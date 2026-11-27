import type { ReviewJob } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { skipFilterReason } from "../review/config/filters.ts";
import type { Config } from "../review/config/schema.ts";
import type { ChangeSet } from "../review/core/models.ts";
import type { ApprovalOutcome, ForgePublisher } from "../review/forge/types.ts";

type Job = Pick<ReviewJob, "id" | "repositoryId" | "number" | "actor">;

// A skipped run posts nothing, but an approval from an earlier review would
// still stand: GitHub counts it for newer commits unless branch protection
// dismisses stale approvals, and GitLab keeps it unless the project resets
// approvals on push. So it is withdrawn unless the last review settled the
// approval at the current head, and always when the skip is the team's own
// filter (a skip label, author, title or branch), which says the change is not
// for Sentryward to judge. A review of the head alone proves nothing: approval
// may have been off then, or the approval step may have failed or been
// refused, leaving an older approval standing. Job rows and forge approvals
// live independently (retention prunes the rows), so without such a record
// the forge is asked to withdraw, keeping an approval it can tell covers the
// current head (GitHub records the commit; GitLab cannot, so it withdraws).
// Best effort: a failure is logged and the job is still recorded as skipped.
export async function withdrawStaleApproval(
  publisher: Pick<ForgePublisher, "setApproval">,
  job: Job,
  config: Config,
  changeSet: ChangeSet,
  skip: string,
): Promise<ApprovalOutcome | undefined> {
  if (!config.output.approval.enabled) return undefined;
  const head = changeSet.forgeRef.headSha;
  const filtered = skip === skipFilterReason(config.triggers, changeSet, job.actor);
  let keepAt: string | undefined;
  let why = skip;
  if (!filtered) {
    const last = await prisma.reviewJob.findFirst({
      where: {
        repositoryId: job.repositoryId,
        number: job.number,
        status: { in: ["completed", "partial"] },
        id: { not: job.id },
        // A trial never published, so it never approved.
        trial: false,
      },
      orderBy: { finishedAt: "desc" },
      select: { headSha: true, publication: true },
    });
    if (last?.headSha === head && settledApproval(last.publication)) return undefined;
    keepAt = head;
    why =
      last && last.headSha !== head
        ? `commits since the last review were not reviewed (${skip})`
        : `no published approval of the current commits is on record (${skip})`;
  }
  try {
    return await publisher.setApproval(changeSet.forgeRef, {
      action: "withdraw",
      body: `Sentryward no longer approves this change: ${why}.`,
      ...(keepAt ? { keepAt } : {}),
    });
  } catch (err) {
    console.error(`[worker] could not withdraw the approval for skipped job ${job.id}`, err);
    return undefined;
  }
}

// Whether a review's publication shows it set the approval at its head: it
// approved (or found its approval already there), requested changes or
// withdrew. A refusal leaves whatever stood before, and "unchanged" without
// the recorded action (rows from before it was stored) could be any of them.
function settledApproval(publication: unknown): boolean {
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
