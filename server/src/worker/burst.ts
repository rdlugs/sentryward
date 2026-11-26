import type { Prisma, ReviewJob } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { BURST_PAUSED_REASON, type PushBurst } from "../review/config/filters.ts";

type Db = Prisma.TransactionClient;

// The change's push history for triggers.pauseOnBurst, as skipReason reads it.
//
// Everything is measured up to the job's own creation, not the moment it runs:
// a push that waited in the queue is judged by when it arrived, and a request
// made after it cannot lift a pause it was part of.
//
// A requested review (dashboard or "/sentryward review") ends a pause and
// restarts the count, so only pushes after the latest request are counted. So
// does a request stamped on a push job (see enqueue), as of when it was made:
// the worker clears a stamp it does not honour. A request that was skipped
// (review commands turned off) or cancelled never became a review, so it ends
// nothing. A superseded one still counts: the push that replaced it is
// reviewed, which answers it.
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
// than left silent. Retention also deletes the markers a request ended along
// with that request, so deleting it cannot bring the pause back.
//
// Pushes are counted by distinct head: a forge redelivery of a push whose job
// was superseded or skipped is queued again (enqueueFromWebhook does not count
// those as seen), and must not count twice. Superseded, running and paused
// pushes count: each would have been reviewed. A push skipped for any other
// reason (a draft, review on push turned off, the filters) would not, so it
// is not part of a burst, and a change is never paused before a push of it
// could be reviewed. Trials never speak for the
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
      where: {
        ...change,
        trial: false,
        trigger: "webhook",
        event: "push",
        createdAt: { ...since, lte: job.createdAt },
        OR: [{ status: { not: "skipped" } }, { error: BURST_PAUSED_REASON }],
      },
      distinct: ["headSha"],
      select: { headSha: true },
    }),
    livePause(prisma, change, job.createdAt, request),
  ]);
  return { pushesInWindow: pushes.length, pausedSinceRequest };
}

type ChangeKey = { repositoryId: string; number: number };

async function lastRequest(db: Db, change: ChangeKey, at: Date): Promise<Date | null> {
  const answered = { ...change, trial: false, status: { notIn: ["skipped" as const, "cancelled" as const] } };
  const [job, stamped] = await Promise.all([
    db.reviewJob.findFirst({
      where: { ...answered, trigger: { in: ["manual", "comment"] }, createdAt: { lte: at } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.reviewJob.findFirst({
      where: { ...answered, requestedAt: { lte: at } },
      orderBy: { requestedAt: "desc" },
      select: { requestedAt: true },
    }),
  ]);
  return latest([job?.createdAt ?? null, stamped?.requestedAt ?? null]);
}

function latest(dates: (Date | null)[]): Date | null {
  return dates.reduce<Date | null>((max, d) => (d && (!max || d > max) ? d : max), null);
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
  const after = latest([request, reviewed?.createdAt ?? null]);
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
