import type { ReviewJob } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { BURST_PAUSED_REASON, type PushBurst } from "../review/config/filters.ts";

// The change's push history for triggers.pauseOnBurst, as skipReason reads it.
//
// Everything is measured up to the job's own creation, not the moment it runs:
// a push that waited in the queue is judged by when it arrived, and a request
// made after it cannot lift a pause it was part of.
//
// A requested review (dashboard or "/sentryward review") ends a pause and
// restarts the count, so only pushes after the latest request are counted. A
// pause is remembered through the skipped job that started it rather than a
// flag on the change, so it lasts past the window without any new state. With
// REVIEW_RETENTION_DAYS set, retention deletes that skipped job after those
// days, which lifts a pause nobody acted on; a change idle that long is better
// reviewed again than left silent.
//
// Every status counts: a superseded or skipped push was still a push. Trials
// never speak for the change, so they neither count nor end a pause. The
// queries use the (repository_id, number) index; a change has few jobs.
export async function pushBurst(
  job: Pick<ReviewJob, "repositoryId" | "number" | "createdAt">,
  windowMinutes: number,
): Promise<PushBurst> {
  const change = { repositoryId: job.repositoryId, number: job.number, trial: false };
  const lastRequest = await prisma.reviewJob.findFirst({
    where: { ...change, trigger: { in: ["manual", "comment"] }, createdAt: { lte: job.createdAt } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const windowStart = new Date(job.createdAt.getTime() - windowMinutes * 60_000);
  const since =
    lastRequest && lastRequest.createdAt > windowStart ? { gt: lastRequest.createdAt } : { gte: windowStart };

  const [pushesInWindow, pause] = await Promise.all([
    prisma.reviewJob.count({
      where: { ...change, trigger: "webhook", event: "push", createdAt: { ...since, lte: job.createdAt } },
    }),
    prisma.reviewJob.findFirst({
      where: {
        ...change,
        status: "skipped",
        error: BURST_PAUSED_REASON,
        createdAt: { ...(lastRequest ? { gt: lastRequest.createdAt } : {}), lt: job.createdAt },
      },
      select: { id: true },
    }),
  ]);
  return { pushesInWindow, pausedSinceRequest: pause !== null };
}
