import { lockChange } from "../lib/changeLock.ts";
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
        // Nor does one cancelled only because reviews were off: that head was
        // never reviewed, and turning the repository back on should pick it up.
        NOT: { status: "cancelled", error: { in: OFF_REASONS } },
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
export async function claimNext(workspaceConcurrency = Number.MAX_SAFE_INTEGER): Promise<ReviewJob | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE review_jobs
    SET status = 'running', locked_at = now(), started_at = now(), attempts = attempts + 1, progress = NULL
    WHERE id = (
      SELECT j.id FROM review_jobs j
      JOIN repositories r ON r.id = j.repository_id
      JOIN forge_connections c ON c.id = r.connection_id
      WHERE j.status = 'queued'
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
// status, so a close that arrives mid-review is never overwritten.
export async function complete(
  id: string,
  input: CompleteInput & Partial<Pick<ReviewJob, "headSha" | "baseSha">>,
): Promise<boolean> {
  const { count } = await prisma.reviewJob.updateMany({
    where: { id, status: "running" },
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
// writing it after a cancel changes nothing that run reports.
export async function recordTitle(id: string, title: string): Promise<void> {
  await prisma.reviewJob.updateMany({ where: { id }, data: { title } });
}

// Only by the attempt that holds the job (see claimState): a run that lost its
// claim must not write over the progress of the one that took it over.
export async function recordProgress(id: string, attempts: number, progress: ReviewProgress): Promise<void> {
  await prisma.reviewJob.updateMany({
    where: { id, status: "running", attempts },
    data: { progress: progress as object },
  });
}

export async function fail(id: string, error: string): Promise<void> {
  await prisma.reviewJob.updateMany({
    where: { id, status: "running" },
    data: { status: "failed", verdict: "error", error, lockedAt: null, finishedAt: new Date() },
  });
}

export const CLOSED_REASON = "The pull or merge request was closed or merged";
export const DISABLED_REASON = "Reviews were turned off for this repository";
export const ACCESS_LOST_REASON = "Sentryward lost access to this repository";
export const NO_REPOSITORY_REASON = "The repository is no longer connected";
// Reasons that mean the repository is off, not that the review was unwanted.
const OFF_REASONS = [DISABLED_REASON, ACCESS_LOST_REASON];

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

// Refreshes the lock on a job still being worked, so recoverStale only reclaims
// a job whose worker has actually gone silent, not a slow-but-healthy run.
// Scoped to running jobs so a cancel or finish between beats is never undone.
export async function heartbeat(id: string): Promise<void> {
  await prisma.reviewJob.updateMany({
    where: { id, status: "running" },
    data: { lockedAt: new Date() },
  });
}

// Whether a run still holds its claim. A job cancelled from the dashboard says
// so, and one cancelled because its repository was turned off says "disabled";
// one failed on timeout, requeued by recovery or claimed again by another
// worker (a later attempt) is lost, and the run must leave it alone.
export async function claimState(id: string, attempts: number): Promise<"owned" | "cancelled" | "disabled" | "lost"> {
  const job = await prisma.reviewJob.findUnique({
    where: { id },
    select: { status: true, attempts: true, error: true },
  });
  if (job?.status === "cancelled") return job.error && OFF_REASONS.includes(job.error) ? "disabled" : "cancelled";
  return job?.status === "running" && job.attempts === attempts ? "owned" : "lost";
}

// A worker that died mid-job leaves it running forever. Jobs locked longer than
// the timeout go back to the queue, or fail once they have used every attempt.
// One whose change has had a newer push queued since is superseded instead:
// requeueing it would leave two queued jobs for the change, and the newer one
// already reviews the current head. Returns how many jobs were recovered, and
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
      finishedAt: new Date(),
    },
    select: { id: true },
  });

  const retryable = await prisma.reviewJob.findMany({
    where: { ...stale, attempts: { lt: maxAttempts } },
    select: { id: true, repositoryId: true, number: true },
  });
  let recovered = 0;
  for (const job of retryable) {
    recovered += await prisma.$transaction(async (tx) => {
      await lockEnqueue(tx, job.repositoryId, job.number);
      const newer = await tx.reviewJob.findFirst({
        where: { repositoryId: job.repositoryId, number: job.number, status: "queued" },
        select: { id: true },
      });
      // Still stale: a heartbeat that landed since means the worker is alive.
      const { count } = await tx.reviewJob.updateMany({
        where: { id: job.id, ...stale },
        data: newer
          ? { status: "superseded", lockedAt: null, finishedAt: new Date() }
          : { status: "queued", lockedAt: null },
      });
      return count;
    });
  }
  return { count: recovered + failed.length, failedIds: failed.map((job) => job.id) };
}
