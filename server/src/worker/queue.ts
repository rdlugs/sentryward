import { env } from "../config/env.ts";
import { lockChange } from "../lib/changeLock.ts";
import { FORGE_TIMEOUT_MS } from "../review/forge/http.ts";
import { prisma } from "../lib/prisma.ts";
import type { Prisma, Repository, ReviewJob, ReviewTrigger } from "../generated/prisma/client.ts";
import { loadDashboardConfig } from "../review/config/load.ts";
import type { ResultSummary } from "../review/render/json.ts";
import type { ReviewProgress } from "../review/core/models.ts";

export interface EnqueueInput {
  repositoryId: string;
  number: number;
  headSha: string;
  trigger: ReviewTrigger;
  event?: "open" | "push";
  actor?: string;
  // The change's author on the forge, when the webhook says. Stored at once so
  // a review that fails before the change is fetched can still reach them
  // (personal notifications); the worker refreshes it from the fetch.
  authorId?: string;
}

// Every write that queues, supersedes or cancels a change's queued jobs takes
// this lock first. Concurrent deliveries for one change (two quick pushes, a
// push and a review comment) would otherwise both pass their checks before
// either job is committed, and the same head would be reviewed twice. Under
// READ COMMITTED the second transaction sees the first one's job once it gets
// the lock. The lock covers a few short queries, so waiters are held for
// milliseconds; only a large burst for one change gets near Prisma's
// interactive-transaction limits (2s to start, 5s to finish).
function lockEnqueue(tx: Prisma.TransactionClient, repositoryId: string, number: number): Promise<void> {
  return lockChange(tx, "enqueue", repositoryId, number);
}

// A newer push makes any still-queued review of the same PR pointless, so it is
// marked superseded rather than left to spend a model call. A job for the same
// head that is already queued or running is returned instead of duplicated.
export async function enqueue(input: EnqueueInput): Promise<ReviewJob> {
  return prisma.$transaction(async (tx) => {
    await lockEnqueue(tx, input.repositoryId, input.number);

    const existing = await tx.reviewJob.findFirst({
      where: {
        repositoryId: input.repositoryId,
        number: input.number,
        headSha: input.headSha,
        status: { in: ["queued", "running"] },
      },
    });
    if (existing) {
      return existing;
    }

    return supersedeAndCreate(tx, input);
  });
}

// The caller holds the change's lock and has checked the head is not queued.
async function supersedeAndCreate(tx: Prisma.TransactionClient, input: EnqueueInput): Promise<ReviewJob> {
  await tx.reviewJob.updateMany({
    where: {
      repositoryId: input.repositoryId,
      number: input.number,
      status: "queued",
    },
    data: { status: "superseded", finishedAt: new Date() },
  });

  return tx.reviewJob.create({ data: input });
}

// Forge redeliveries and repeated events must not review a commit twice, and a
// burst of pushes must not pile up work: a repository holds at most this many
// queued jobs (newer pushes already supersede older ones).
const MAX_QUEUED_PER_REPOSITORY = 10;

export type WebhookEnqueueResult =
  | { queued: true; job: ReviewJob }
  | { queued: false; reason: "duplicate" | "queue_full" };

// For automatic triggers: a head that was ever queued or reviewed is left
// alone. A person asking explicitly (manual or comment) goes through enqueue().
// The duplicate check runs under the change's lock, so a redelivery racing the
// original is refused, and it already covers a queued or running job for this
// head, so enqueue()'s own check is not repeated. The queue-full count spans other changes, which take
// their own locks, so concurrent pushes to several changes can exceed it by a
// few; it bounds a burst, not a hard quota.
export async function enqueueFromWebhook(input: EnqueueInput): Promise<WebhookEnqueueResult> {
  return prisma.$transaction(async (tx): Promise<WebhookEnqueueResult> => {
    await lockEnqueue(tx, input.repositoryId, input.number);

    const seen = await tx.reviewJob.findFirst({
      where: {
        repositoryId: input.repositoryId,
        number: input.number,
        headSha: input.headSha,
        // A skipped job does not count: a draft marked ready for review keeps its
        // head, and must still be reviewed.
        status: { notIn: ["superseded", "skipped"] },
        // Nor does one cancelled only because reviews were off or the change
        // closed: that head was never reviewed, and turning the repository back
        // on or reopening the change on the same head should pick it up.
        NOT: { status: "cancelled", error: { in: UNREVIEWED_CANCEL_REASONS } },
      },
      select: { id: true },
    });
    if (seen) return { queued: false, reason: "duplicate" };

    const queued = await tx.reviewJob.count({
      where: { repositoryId: input.repositoryId, status: "queued", number: { not: input.number } },
    });
    if (queued >= MAX_QUEUED_PER_REPOSITORY) return { queued: false, reason: "queue_full" };

    return { queued: true, job: await supersedeAndCreate(tx, input) };
  });
}

// Claims the oldest queued job whose workspace is under the per-workspace
// running limit. SKIP LOCKED lets several workers poll the same table without
// ever handing one job to two of them. Two workers claiming for the same
// workspace at the same instant can exceed the limit by one; it is a fairness
// bound, not a hard quota.
//
// A change whose run still holds its lease is skipped until that run ends.
// Otherwise an older head that finishes last would replace the newer review's
// summary comment, reopen findings it fixed and become the "latest review".
// The lease, not the status, decides: a run cancelled from the dashboard, failed
// on its time limit or completed but still syncing findings is still working on
// the change. Waiting is enough: enqueue supersedes older queued jobs, so the
// one left waiting is the newest head and publishes last. A worker that dies
// frees its change once the lease expires, and a hung live run once it passes
// WORKER_MAX_RUN_MS and its last lease runs out; claimState fences either one
// off if it wakes up after the newer run started.
export async function claimNext(
  workspaceConcurrency = Number.MAX_SAFE_INTEGER,
  leaseMs = RUN_LEASE_MS,
): Promise<ReviewJob | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE review_jobs
    SET status = 'running', locked_at = now(), started_at = now(), attempts = attempts + 1, progress = NULL,
      lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    WHERE id = (
      SELECT j.id FROM review_jobs j
      JOIN repositories r ON r.id = j.repository_id
      JOIN forge_connections c ON c.id = r.connection_id
      WHERE j.status = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM review_jobs busy
          WHERE busy.repository_id = j.repository_id
            AND busy.number = j.number
            AND busy.lease_expires_at > now()
        )
        AND (
          SELECT count(*) FROM review_jobs running
          JOIN repositories rr ON rr.id = running.repository_id
          JOIN forge_connections rc ON rc.id = rr.connection_id
          WHERE running.status = 'running' AND rc.workspace_id = c.workspace_id
        ) < ${workspaceConcurrency}
      ORDER BY j.created_at
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `;
  const claimed = rows[0];
  return claimed ? prisma.reviewJob.findUnique({ where: { id: claimed.id } }) : null;
}

export interface CompleteInput {
  status: "completed" | "partial" | "failed" | "skipped" | "cancelled";
  verdict: ReviewJob["verdict"];
  result?: unknown;
  summary?: ResultSummary;
  publication?: unknown;
  resolvedConfig?: unknown;
  error?: string | null;
}

// Only a running job is finished: one cancelled while it ran keeps that
// status, so a close that arrives mid-review is never overwritten. And only by
// the attempt that holds it (see claimState): a run that stalled past the lock
// timeout and woke after recovery handed its job to a later attempt must not
// finish that attempt's job, or the later run's own result would be dropped.
export async function complete(
  id: string,
  attempts: number,
  input: CompleteInput & Partial<Pick<ReviewJob, "headSha" | "baseSha">>,
): Promise<boolean> {
  const { count } = await prisma.reviewJob.updateMany({
    where: { id, status: "running", attempts },
    data: {
      headSha: input.headSha,
      baseSha: input.baseSha,
      status: input.status,
      verdict: input.verdict,
      result: input.result as object | undefined,
      summary: input.summary as object | undefined,
      publication: input.publication as object | undefined,
      resolvedConfig: input.resolvedConfig as object | undefined,
      error: input.error ?? null,
      lockedAt: null,
      finishedAt: new Date(),
    },
  });
  return count > 0;
}

// The change's title, stored as soon as the worker has fetched the change so
// every run that got that far is searchable by it, skipped and cancelled ones
// included. No status guard: the title describes the change, not the run, so
// writing it after a cancel changes nothing that run reports. The author's
// forge id goes with it, for personal notifications; undefined (a change
// cached before it was fetched) leaves the column alone.
export async function recordTitle(id: string, title: string, authorId?: string): Promise<void> {
  await prisma.reviewJob.updateMany({ where: { id }, data: { title, authorId } });
}

// Only by the attempt that holds the job (see claimState): a run that lost its
// claim must not write over the progress of the one that took it over.
export async function recordProgress(id: string, attempts: number, progress: ReviewProgress): Promise<void> {
  await prisma.reviewJob.updateMany({
    where: { id, status: "running", attempts },
    data: { progress: progress as object },
  });
}

// Scoped to the attempt like complete(), so a run that lost its job cannot
// fail the one that took it over.
export async function fail(id: string, attempts: number, error: string): Promise<void> {
  await prisma.reviewJob.updateMany({
    where: { id, status: "running", attempts },
    data: { status: "failed", verdict: "error", error, lockedAt: null, finishedAt: new Date() },
  });
}

export const CLOSED_REASON = "The pull or merge request was closed or merged";
export const DISABLED_REASON = "Reviews were turned off for this repository";
export const ACCESS_LOST_REASON = "Sentryward lost access to this repository";
export const NO_REPOSITORY_REASON = "The repository is no longer connected";
// Reasons that mean the repository is off, not that the review was unwanted.
const OFF_REASONS = [DISABLED_REASON, ACCESS_LOST_REASON];
// Cancellations that leave a head unreviewed rather than unwanted, so an
// automatic trigger may queue it again. Kept apart from OFF_REASONS, which
// claimState reads: a close must still stop the run as "cancelled".
const UNREVIEWED_CANCEL_REASONS = [...OFF_REASONS, CLOSED_REASON];

// A closed or merged change needs no review, so its queued jobs are
// cancelled when the forge reports the close, unless the dashboard settings
// turned that off. A running job is left to the worker, which checks the change
// itself with the full configuration, repository file included.
export async function cancelQueuedForClosedChange(
  repo: Pick<Repository, "id" | "settings" | "followGlobal" | "connectionId">,
  number: number,
): Promise<number> {
  const owner = await prisma.forgeConnection.findUnique({
    where: { id: repo.connectionId },
    select: { workspace: { select: { reviewSettings: true } } },
  });
  const config = loadDashboardConfig({
    globalSettings: owner?.workspace.reviewSettings,
    repoSettings: repo.settings,
    followGlobal: repo.followGlobal,
  });
  if (!config.triggers.abortOnClose) return 0;
  // Under the change's lock, so a push being queued at the same moment commits
  // first and is cancelled too. The worker re-checks the change before
  // reviewing anyway; this spares it a claim and a forge call.
  return prisma.$transaction(async (tx) => {
    await lockEnqueue(tx, repo.id, number);
    const { count } = await tx.reviewJob.updateMany({
      where: { repositoryId: repo.id, number, status: "queued" },
      data: { status: "cancelled", error: CLOSED_REASON, finishedAt: new Date() },
    });
    return count;
  });
}

// A person stopping a review. One status check and write, so it cannot race a
// worker: claimNext only takes queued jobs, and complete() and fail() only
// finish running ones, so the reason given here is the one that stays.
export async function cancelJob(id: string, workspaceId: string, reason: string): Promise<number> {
  return cancelWhere({ id, repository: { connection: { workspaceId } } }, reason);
}

// Turning repositories off (by hand, or because access was lost) stops
// everything they still have in flight, so nothing is published to them
// afterwards. A running job sees the cancel through claimState; complete() and
// fail() only finish running jobs, so this reason is the one that stays. Takes
// a transaction client so the cancel commits with the repository update.
export async function cancelForDisabledRepositories(
  repositoryIds: string[],
  reason: typeof DISABLED_REASON | typeof ACCESS_LOST_REASON,
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  if (repositoryIds.length === 0) return 0;
  return cancelWhere({ repositoryId: { in: repositoryIds } }, reason, client);
}

async function cancelWhere(
  where: Prisma.ReviewJobWhereInput,
  reason: string,
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  const { count } = await client.reviewJob.updateMany({
    where: { ...where, status: { in: ["queued", "running"] } },
    data: { status: "cancelled", error: reason, lockedAt: null, finishedAt: new Date() },
  });
  return count;
}

// How long a run's hold on its change outlives its last heartbeat. Three beats,
// so one missed beat (a DB blip) does not free the change, and well over the
// forge request timeout, so a step already in flight lands before a newer run
// can start. The env check keeps a beat below WORKER_LOCK_TIMEOUT_MS; three of
// them at the defaults (3 min) are still well under it.
export const RUN_LEASE_MS = 3 * env.WORKER_HEARTBEAT_INTERVAL_MS;

// Renews the run's lease, and refreshes the lock on a job still being worked so
// recoverStale only reclaims a job whose worker has actually gone silent, not a
// slow-but-healthy run. The lock is only touched while the job runs, so a
// cancel or finish between beats is never undone; the lease is renewed after
// one too, because the run is still working until it returns. Scoped to this
// attempt, so a run that lost its job never extends the lease of the one that
// took it over, and to a lease still held, so a released one stays released.
export async function heartbeat(id: string, attempts: number, leaseMs = RUN_LEASE_MS): Promise<void> {
  await prisma.$executeRaw`
    UPDATE review_jobs
    SET lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
      locked_at = CASE WHEN status = 'running' THEN now() ELSE locked_at END
    WHERE id = ${id} AND attempts = ${attempts} AND lease_expires_at IS NOT NULL
  `;
}

// The run has returned, so its change may take the next review. Scoped to the
// attempt for the same reason as heartbeat.
export async function releaseLease(id: string, attempts: number): Promise<void> {
  await prisma.reviewJob.updateMany({ where: { id, attempts }, data: { leaseExpiresAt: null } });
}

// Whether a run still holds its claim. A job cancelled from the dashboard says
// so, and one cancelled because its repository was turned off says "disabled";
// one failed on timeout, requeued by recovery or claimed again by another
// worker (a later attempt) is lost, and the run must leave it alone. So is one
// whose change has a newer job that already started: that happens only when
// this run's lease ran out while it was still alive (a stalled process), and
// the newer head must win, so this run publishes nothing more.
export async function claimState(id: string, attempts: number): Promise<"owned" | "cancelled" | "disabled" | "lost"> {
  const job = await prisma.reviewJob.findUnique({
    where: { id },
    select: { status: true, attempts: true, error: true, repositoryId: true, number: true, createdAt: true },
  });
  if (job?.status === "cancelled") return job.error && OFF_REASONS.includes(job.error) ? "disabled" : "cancelled";
  if (job?.status !== "running" || job.attempts !== attempts) return "lost";
  const newer = await prisma.reviewJob.findFirst({
    where: {
      repositoryId: job.repositoryId,
      number: job.number,
      createdAt: { gt: job.createdAt },
      startedAt: { not: null },
    },
    select: { id: true },
  });
  return newer ? "lost" : "owned";
}

// A worker that died mid-job leaves it running forever. Jobs locked longer than
// the timeout go back to the queue, or fail once they have used every attempt.
// One whose change has had a newer job since, in any state, is superseded
// instead: the newer one speaks for the change (it may already be running,
// since a dead worker's lease expires long before this timeout), and
// requeueing would review an older head after it. Returns how many jobs were recovered, and
// which of them failed, for notifications.
export async function recoverStale(
  lockTimeoutMs: number,
  maxAttempts: number,
): Promise<{ count: number; failedIds: string[] }> {
  const cutoff = new Date(Date.now() - lockTimeoutMs);
  const stale = { status: "running", lockedAt: { lt: cutoff } } as const;

  const failed = await prisma.reviewJob.updateManyAndReturn({
    where: { ...stale, attempts: { gte: maxAttempts } },
    data: {
      status: "failed",
      verdict: "error",
      error: "Worker stopped responding",
      lockedAt: null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
    },
    select: { id: true },
  });

  const retryable = await prisma.reviewJob.findMany({
    where: { ...stale, attempts: { lt: maxAttempts } },
    select: { id: true, repositoryId: true, number: true, createdAt: true },
  });
  let recovered = 0;
  for (const job of retryable) {
    recovered += await prisma.$transaction(async (tx) => {
      await lockEnqueue(tx, job.repositoryId, job.number);
      const newer = await tx.reviewJob.findFirst({
        where: { repositoryId: job.repositoryId, number: job.number, createdAt: { gt: job.createdAt } },
        select: { id: true },
      });
      // Still stale: a heartbeat that landed since means the worker is alive.
      const { count } = await tx.reviewJob.updateMany({
        where: { id: job.id, ...stale },
        data: newer
          ? { status: "superseded", lockedAt: null, leaseExpiresAt: null, finishedAt: new Date() }
          : { status: "queued", lockedAt: null, leaseExpiresAt: null },
      });
      return count;
    });
  }
  return { count: recovered + failed.length, failedIds: failed.map((job) => job.id) };
}

// How long a handed-back job stays unclaimable. Once the stopping worker has
// exited, the only writes its abandoned runs can still make are forge requests
// already sent, which end within the forge request timeout; the margin covers
// the exit itself. The runs cannot extend it: their heartbeat is scoped to
// their attempt, which the hand-back takes back. A superseded job keeps its
// attempt, so a beat landing before the exit can only hold the change longer,
// never free it early.
const HANDBACK_LEASE_MS = FORGE_TIMEOUT_MS + 5_000;

// A stopping worker hands back the reviews it could not finish within its
// drain time, so a deploy neither leaves them running until recoverStale's
// timeout nor spends one of their attempts. The attempt is handed back too,
// which means the next claim reuses this run's attempt number and so passes
// its fences (complete, claimState, heartbeat). So the change keeps a short
// lease (HANDBACK_LEASE_MS) instead of being freed: claimNext skips it until
// the caller has exited and any forge call already in flight has landed, and
// only then can the job, or a newer one for the change, be claimed. Scoped to
// the running attempt, so a job that finished, failed on its time limit or was
// cancelled meanwhile keeps that outcome; one whose change has a newer job is
// superseded instead, as in recoverStale. Each job is handed back on its own,
// so one that fails falls to recoverStale without holding back the rest.
// Returns how many jobs were handed back.
export async function requeueInterrupted(jobs: { id: string; attempts: number }[]): Promise<number> {
  let requeued = 0;
  for (const { id, attempts } of jobs) {
    try {
      requeued += await prisma.$transaction(async (tx) => {
        const job = await tx.reviewJob.findUnique({
          where: { id },
          select: { repositoryId: true, number: true, createdAt: true },
        });
        if (!job) return 0;
        await lockEnqueue(tx, job.repositoryId, job.number);
        const newer = await tx.reviewJob.findFirst({
          where: { repositoryId: job.repositoryId, number: job.number, createdAt: { gt: job.createdAt } },
          select: { id: true },
        });
        const leaseExpiresAt = new Date(Date.now() + HANDBACK_LEASE_MS);
        const { count } = await tx.reviewJob.updateMany({
          where: { id, attempts, status: "running" },
          data: newer
            ? { status: "superseded", lockedAt: null, leaseExpiresAt, finishedAt: new Date() }
            : { status: "queued", attempts: { decrement: 1 }, lockedAt: null, leaseExpiresAt },
        });
        return count;
      });
    } catch (err) {
      console.error(`[worker] could not requeue job ${id}`, err);
    }
  }
  return requeued;
}
