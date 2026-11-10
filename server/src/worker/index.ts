import { env } from "../config/env.ts";
import { prisma } from "../lib/prisma.ts";
import { notifyJob, queueMissedNotifications } from "../services/notifications.ts";
import { execute } from "./execute.ts";
import { claimDueDeliveries, recoverStaleDeliveries, runDelivery } from "./deliveryQueue.ts";
import { claimNext, recoverStale, requeueInterrupted } from "./queue.ts";
import { claimNextReply, recoverStaleReplies } from "./replyQueue.ts";
import { executeReply } from "./executeReply.ts";
import { runRetention } from "./retention.ts";

let stopping = false;
const running = new Set<Promise<void>>();
// Review jobs in flight and the attempt each holds, so a shutdown that cannot
// wait for them can hand them back to the queue.
const inFlight = new Map<string, number>();

// Notification sends in flight. They have their own limit rather than taking
// review slots, so a slow or hanging endpoint never delays a review.
const deliveries = new Set<Promise<void>>();
const DELIVERY_CONCURRENCY = 10;

// Retention is about days, so an hourly pass is plenty. The first poll after
// start runs it.
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

// Claims are awaited one at a time; the work itself runs in the background up
// to WORKER_CONCURRENCY jobs. Replies to inline threads share the slots and
// are claimed after reviews, which they are much smaller than.
async function tick(): Promise<void> {
  const stale = await recoverStale(env.WORKER_LOCK_TIMEOUT_MS, env.WORKER_MAX_ATTEMPTS);
  const recovered = stale.count + (await recoverStaleReplies(env.WORKER_LOCK_TIMEOUT_MS, env.WORKER_MAX_ATTEMPTS));
  if (recovered > 0) {
    console.log(`[worker] recovered ${recovered} stale job(s)`);
  }
  // Jobs failed here never return to an execute() that would notify for them.
  // notifyJob only queues, so this is quick.
  for (const id of stale.failedIds) {
    await notifyJob(id);
  }
  // The backstop for a worker that stopped after storing a job but before
  // queueing its deliveries.
  const missed = await queueMissedNotifications();
  if (missed > 0) {
    console.log(`[worker] queued notifications for ${missed} finished job(s) missing them`);
  }
  while (!stopping && running.size < env.WORKER_CONCURRENCY) {
    const job = await claimNext(env.WORKER_USER_CONCURRENCY);
    if (!job) {
      break;
    }
    inFlight.set(job.id, job.attempts);
    const task: Promise<void> = execute(job).finally(() => {
      running.delete(task);
      inFlight.delete(job.id);
    });
    running.add(task);
  }
  while (!stopping && running.size < env.WORKER_CONCURRENCY) {
    const reply = await claimNextReply();
    if (!reply) {
      return;
    }
    const task: Promise<void> = executeReply(reply).finally(() => running.delete(task));
    running.add(task);
  }
}

// Claims due notification deliveries and sends them in the background.
async function dispatchDeliveries(): Promise<void> {
  const recovered = await recoverStaleDeliveries();
  if (recovered > 0) {
    console.log(`[worker] recovered ${recovered} stale notification delivery(ies)`);
  }
  if (stopping) return;
  for (const id of await claimDueDeliveries(DELIVERY_CONCURRENCY - deliveries.size)) {
    const task: Promise<void> = runDelivery(id).finally(() => deliveries.delete(task));
    deliveries.add(task);
  }
}

// Runs after the claims so a long first pass or a failing prune never holds
// up reviews.
// The periods are read from the instance and workspace privacy settings on
// each pass, so a change applies within the hour.
async function prune(): Promise<void> {
  if (Date.now() - lastPruneAt < RETENTION_INTERVAL_MS) return;
  // Set first so a failing prune waits for the next interval instead of
  // retrying every poll.
  lastPruneAt = Date.now();
  const r = await runRetention();
  if (r.deleted || r.trimmed || r.changes || r.auditRows || r.deliveries) {
    console.log(
      `[worker] retention: deleted ${r.deleted} job(s), expired ${r.trimmed} result(s), ` +
        `purged ${r.changes} change(s) (${r.findings} finding(s), ${r.replies} reply(ies)), ` +
        `${r.auditRows} audit row(s), ${r.deliveries} notification delivery(ies)`,
    );
  }
}

// A review may run for up to WORKER_MAX_RUN_MS, longer than a deploy should
// wait, and a worker killed mid-run leaves its jobs running until stale-lock
// recovery retries them on a fresh attempt. So in-flight work gets
// WORKER_SHUTDOWN_DRAIN_MS to finish, and reviews still running after that are
// handed back to the queue and the process exits at once: requeueInterrupted
// returns their attempt, and holds their change under a short lease so nothing
// claims it before this process is gone. Replies are only claimed before
// shutdown and each settles within MAX_REPLY_RUN_MS (executeReply.ts), so the
// drain outlasts them unless WORKER_SHUTDOWN_DRAIN_MS is set below that; a reply
// still running at the deadline is cut off by the exit and falls to stale
// recovery. Notification sends are waited for the same way (each is bounded by
// its timeouts); one cut off is sent again after its lock goes stale.
async function drain(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), env.WORKER_SHUTDOWN_DRAIN_MS);
  });
  const outcome = await Promise.race([Promise.allSettled([...running, ...deliveries]), deadline]);
  clearTimeout(timer);
  if (outcome !== "timeout") return;
  if (inFlight.size === 0) {
    // Only replies and sends left: nothing to hand back, so let them finish.
    await Promise.allSettled([...running, ...deliveries]);
    return;
  }

  const jobs = [...inFlight].map(([id, attempts]) => ({ id, attempts }));
  try {
    const requeued = await requeueInterrupted(jobs);
    console.log(`[worker] requeued ${requeued} of ${jobs.length} unfinished review(s)`);
  } catch (err) {
    // Left running; stale-lock recovery retries them later.
    console.error("[worker] could not requeue unfinished reviews", err);
  }
  await prisma.$disconnect().catch(() => undefined);
  console.log("[worker] stopped");
  process.exit(0);
}

async function loop(): Promise<void> {
  console.log(
    `[worker] polling every ${env.WORKER_POLL_INTERVAL_MS}ms, concurrency ${env.WORKER_CONCURRENCY}`,
  );
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error("[worker] poll failed", err);
    }
    try {
      await dispatchDeliveries();
    } catch (err) {
      console.error("[worker] notification deliveries failed", err);
    }
    try {
      await prune();
    } catch (err) {
      console.error("[worker] retention failed", err);
    }
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
  }
  await drain();
  await prisma.$disconnect();
  console.log("[worker] stopped");
}

function shutdown() {
  if (!stopping) {
    console.log(
      `[worker] shutting down; waiting up to ${env.WORKER_SHUTDOWN_DRAIN_MS}ms for in-flight jobs`,
    );
    stopping = true;
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

void loop();
