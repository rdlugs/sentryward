import { env } from "../config/env.ts";
import type { ReviewJob } from "../generated/prisma/client.ts";
import { notifyJob } from "../services/notifications.ts";
import { fail, heartbeat, releaseLease, RUN_LEASE_MS } from "./queue.ts";
import { runJob } from "./runJob.ts";

export interface ExecuteDeps {
  runJob: (job: ReviewJob) => Promise<void>;
  // Never throws; told about every job once its run ends, however it ended.
  notify: (jobId: string) => Promise<void>;
  heartbeatMs: number;
  maxRunMs: number;
  // How long the change stays busy after the last beat (see RUN_LEASE_MS).
  leaseMs?: number;
}

const defaultDeps: ExecuteDeps = {
  runJob: (job) => runJob(job),
  notify: notifyJob,
  heartbeatMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
  maxRunMs: env.WORKER_MAX_RUN_MS,
};

const RUN_TIMEOUT = Symbol("run-timeout");

export async function execute(job: ReviewJob, deps: ExecuteDeps = defaultDeps): Promise<void> {
  console.log(`[worker] claimed job ${job.id} (attempt ${job.attempts})`);
  // Refresh the lock while the job runs so a long-but-healthy review is not
  // mistaken for a dead worker by recoverStale. A transient DB blip on one beat
  // must not kill the run, so errors are swallowed; the next beat retries.
  const beat = setInterval(() => {
    void heartbeat(job.id, job.attempts, deps.leaseMs ?? RUN_LEASE_MS).catch((err) => console.error(`[worker] heartbeat failed for job ${job.id}`, err));
  }, deps.heartbeatMs);
  beat.unref();

  // The longest a review may take. Past it the job is failed and its slot freed,
  // even when the run is stuck where abortableGenerate cannot reach. The run
  // itself is not killed; it stops at its next claim check, having lost the
  // job, and publishes nothing more. Its change stays busy until it returns or,
  // with the heartbeat stopped, its lease runs out, so a step it already had in
  // flight lands before a newer review of the change can start.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof RUN_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(RUN_TIMEOUT), deps.maxRunMs);
    timer.unref();
  });

  try {
    // The race subscribes to the run, so a rejection after a timeout is handled.
    // The lease goes when the run itself returns, however late that is: until
    // then it may still be cancelling, publishing or syncing findings.
    const run = deps.runJob(job).finally(() =>
      releaseLease(job.id, job.attempts).catch((err) => console.error(`[worker] could not release job ${job.id}`, err)),
    );
    const outcome = await Promise.race([run, timeout]);
    if (outcome === RUN_TIMEOUT) {
      console.error(`[worker] job ${job.id} exceeded the maximum run time; freeing its slot`);
      await fail(job.id, job.attempts, "Review exceeded the maximum run time").catch((failErr) => {
        console.error(`[worker] could not record timeout for job ${job.id}`, failErr);
      });
      return;
    }
    console.log(`[worker] finished job ${job.id}`);
  } catch (err) {
    console.error(`[worker] job ${job.id} failed`, err);
    await fail(job.id, job.attempts, err instanceof Error ? err.message : String(err)).catch((failErr) => {
      // Left running; stale-lock recovery retries or fails it later.
      console.error(`[worker] could not record failure for job ${job.id}`, failErr);
    });
  } finally {
    clearInterval(beat);
    clearTimeout(timer);
    // After the job is stored, so a delivery cannot change its outcome. It
    // only queues deliveries for a job left completed, partial or failed; the
    // poll loop sends them, so a slow endpoint never holds this slot. If this
    // never runs (a crash) or fails, queueMissedNotifications picks the job up.
    await deps.notify(job.id);
  }
}
