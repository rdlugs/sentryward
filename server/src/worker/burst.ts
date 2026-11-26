import type { Prisma, ReviewJob } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { BURST_PAUSED_REASON, type PushBurst } from "../review/config/filters.ts";

// Either the shared client or the transaction enqueue() holds the change's
// lock in, so the pause check there sees the same rows as its duplicate check.
type Db = Prisma.TransactionClient;

// The change's push history for triggers.pauseOnBurst, as skipReason reads it.
//
// Everything is measured up to the job's own creation, not the moment it runs:
// a push that waited in the queue is judged by when it arrived, and a request
// made after it cannot lift a pause it was part of.
//
// A requested review (dashboard or "/sentryward review") ends a pause and
// restarts the count, so only pushes after the latest request are counted. A
// request that was skipped (review commands turned off) or cancelled never
// became a review, so it ends nothing. A superseded one still counts: the push
// that replaced it is reviewed, which answers it.
//
// A pause is remembered through the skipped job that started it rather than a
// flag on the change, so it lasts past the window without any new state. A
// push reviewed after that job shows the pause was no longer in force (the
// setting was turned off meanwhile), so the marker is stale and turning the
// setting back on starts afresh. Turned off and on with no push reviewed in
// between, or with pauseAfterPushes raised, the pause holds: nothing was
// reviewed since, and a request is what ends it. With REVIEW_RETENTION_DAYS
// set, retention deletes the skipped job after those days, which lifts a
// pause nobody acted on; a change idle that long is better reviewed again
// than left silent.
//
// Pushes are counted by distinct head: a forge redelivery of a push whose job
// was superseded or skipped is queued again (enqueueFromWebhook does not count
// those as seen), and must not count twice. Every status counts otherwise: a
// superseded or skipped push was still a push. Trials never speak for the
// change, so they neither count nor end a pause. The queries use the
// (repository_id, number) index; a change has few jobs.
export async function pushBurst(
  job: Pick<ReviewJob, "repositoryId" | "number" | "createdAt">,
  windowMinutes: number,
): Promise<PushBurst> {
  const change = { repositoryId: job.repositoryId, number: job.number };
  const request = await lastRequest(prisma, change, job.createdAt);
  const windowStart = new Date(job.createdAt.getTime() - windowMinutes * 60_000);
  const since = request && request > windowStart ? { gt: request } : { gte: windowStart };

  const [pushes, pausedSinceRequest] = await Promise.all([
    prisma.reviewJob.findMany({
      where: { ...change, trial: false, trigger: "webhook", event: "push", createdAt: { ...since, lte: job.createdAt } },
      distinct: ["headSha"],
      select: { headSha: true },
    }),
    livePause(prisma, change, job.createdAt, request),
  ]);
  return { pushesInWindow: pushes.length, pausedSinceRequest };
}

// Whether the change is paused as of `at`. enqueue() asks this so a request on
// a paused change is not answered by a push job the pause will skip.
export async function pausedAt(db: Db, repositoryId: string, number: number, at: Date): Promise<boolean> {
  const change = { repositoryId, number };
  return livePause(db, change, at, await lastRequest(db, change, at));
}

type ChangeKey = { repositoryId: string; number: number };

async function lastRequest(db: Db, change: ChangeKey, at: Date): Promise<Date | null> {
  const row = await db.reviewJob.findFirst({
    where: {
      ...change,
      trial: false,
      trigger: { in: ["manual", "comment"] },
      status: { notIn: ["skipped", "cancelled"] },
      createdAt: { lte: at },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

// A pause marker counts only after both the last request and the last push
// that was actually reviewed (see pushBurst).
async function livePause(db: Db, change: ChangeKey, at: Date, request: Date | null): Promise<boolean> {
  const reviewed = await db.reviewJob.findFirst({
    where: {
      ...change,
      trial: false,
      trigger: "webhook",
      event: "push",
      status: { in: ["completed", "partial", "failed"] },
      createdAt: { lt: at },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const after = [request, reviewed?.createdAt ?? null].reduce<Date | null>(
    (latest, d) => (d && (!latest || d > latest) ? d : latest),
    null,
  );
  const marker = await db.reviewJob.findFirst({
    where: {
      ...change,
      trial: false,
      status: "skipped",
      error: BURST_PAUSED_REASON,
      createdAt: { ...(after ? { gt: after } : {}), lt: at },
    },
    select: { id: true },
  });
  return marker !== null;
}
