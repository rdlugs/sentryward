import { prisma } from "../lib/prisma.ts";

// What the last review of a change recorded about Sentryward's approval. Shared
// by skipped runs (worker/staleApproval.ts) and retarget webhooks
// (services/providers/retarget.ts), which both decide whether an approval
// standing on the forge is one a review settled for the change as it is now.
export interface LastReview {
  headSha: string | null;
  baseSha: string | null;
  result: unknown;
  publication: unknown;
}

// The most recent published review of the change. A trial never published, so
// it never approved; `excludeJobId` leaves out the run asking.
export function lastPublishedReview(repositoryId: string, number: number, excludeJobId?: string): Promise<LastReview | null> {
  return prisma.reviewJob.findFirst({
    where: {
      repositoryId,
      number,
      status: { in: ["completed", "partial"] },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
      trial: false,
    },
    orderBy: { finishedAt: "desc" },
    select: { headSha: true, baseSha: true, result: true, publication: true },
  });
}

// Whether a review's publication shows it set the approval at its head: it
// approved (or found its approval already there), requested changes or
// withdrew. A refusal leaves whatever stood before, and "unchanged" without
// the recorded action (rows from before it was stored) could be any of them.
export function settledApproval(publication: unknown): boolean {
  const approval = (publication as { approval?: { action?: string; state?: string } } | null)?.approval;
  switch (approval?.state) {
    case "approved":
    case "changes_requested":
    case "withdrawn":
      return true;
    case "unchanged":
      return approval.action !== undefined;
    default:
      return false;
  }
}

// Whether a review decided against approval (withdraw or request changes),
// whatever became of the write.
export function decidedAgainst(publication: unknown): boolean {
  const action = (publication as { approval?: { action?: string } } | null)?.approval?.action;
  return action === "withdraw" || action === "request_changes";
}

// Whether the last review saw the base commit and target branch the change has
// now. Anything missing on either side counts as unverified, never as a match.
export function sameReviewedTarget(
  last: Pick<LastReview, "baseSha" | "result">,
  current: { baseSha: string; baseRef?: string | undefined },
): boolean {
  const baseRef = (last.result as { change?: { baseRef?: unknown } } | null)?.change?.baseRef;
  return (
    last.baseSha !== null &&
    last.baseSha === current.baseSha &&
    typeof baseRef === "string" &&
    current.baseRef !== undefined &&
    baseRef === current.baseRef
  );
}
