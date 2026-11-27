import type { ReviewJob } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { skipFilterReason } from "../review/config/filters.ts";
import type { Config } from "../review/config/schema.ts";
import { approvalHoldReasons, approvalManaged } from "../review/publish/approve.ts";
import type { ChangeSet } from "../review/core/models.ts";
import type { ApprovalOutcome, ForgePublisher } from "../review/forge/types.ts";

type Job = Pick<ReviewJob, "id" | "repositoryId" | "number" | "actor">;

// A skipped run posts nothing, but an approval from an earlier review would
// still stand: GitHub counts it for newer commits unless branch protection
// dismisses stale approvals, and GitLab keeps it unless the project resets
// approvals on push. So it is withdrawn unless the last review settled the
// approval at the current head, base and target branch (a retarget or a moved
// base queues no review, so a matching head alone does not show the approval
// covers the change as it stands), and always when the skip is the team's own
// filter (a skip label, author, title or branch), which says the change is not
// for Sentryward to judge, or when a repository file or trigger turned approval
// off for this change. It is also always withdrawn when an approval policy
// holds the change back as it stands now (a hold label added since, a policy
// the dashboard added, a listing the forge truncated): the last review settled
// the approval against the change and settings it saw, not these. A review of
// the head alone proves nothing: approval
// may have been off then, or the approval step may have failed or been
// refused, leaving an older approval standing: then the forge is asked to
// withdraw, keeping an approval it can tell covers the current head (GitHub
// records the commit; GitLab cannot, so it withdraws). That fallback is only
// used when the last review saw this same head and target and did not decide
// to withdraw or request changes (a decision whose write failed is still on
// record): an approval records its commit, never the target it was given for. Without such a
// record (retention prunes job rows, the head or target moved, or the row
// predates the target being stored) every approval is withdrawn.
// Best effort: a failure is logged and the job is still recorded as skipped.
export async function withdrawStaleApproval(
  publisher: Pick<ForgePublisher, "setApproval">,
  job: Job,
  config: Config,
  changeSet: ChangeSet,
  skip: string,
): Promise<ApprovalOutcome | undefined> {
  // A repository veto still withdraws (publish/approve.ts approvalManaged).
  if (!approvalManaged(config)) return undefined;
  const head = changeSet.forgeRef.headSha;
  const filtered = skip === skipFilterReason(config.triggers, changeSet, job.actor);
  // Vetoed for this run: no earlier approval stands, whatever it covered.
  const vetoed = !config.output.approval.enabled;
  // Held back by policy now: no earlier approval stands either, so neither
  // the record of the last review nor keepAt may keep it.
  const held = vetoed ? [] : approvalHoldReasons(config, changeSet);
  let keepAt: string | undefined;
  let why = vetoed
    ? `automatic approval is turned off for this change (${skip})`
    : held.length
      ? `${held.map((reason) => reason.charAt(0).toLowerCase() + reason.slice(1)).join("; ")} (${skip})`
      : skip;
  if (!filtered && !vetoed && !held.length) {
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
      select: { headSha: true, baseSha: true, result: true, publication: true },
    });
    const sameHead = last?.headSha === head;
    const sameTarget = last !== null && sameReviewedTarget(last, changeSet);
    if (sameHead && sameTarget && settledApproval(last.publication)) return undefined;
    // keepAt only stands in for a missing record: when the last review
    // decided against approval (its write failed), an approval at this head
    // is the one it meant to withdraw.
    if (sameHead && sameTarget && !decidedAgainst(last.publication)) keepAt = head;
    why =
      last && !sameHead
        ? `commits since the last review were not reviewed (${skip})`
        : last && !sameTarget
          ? `the target branch moved or was changed since the last review (${skip})`
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

// Whether a review decided against approval (withdraw or request changes),
// whatever became of the write.
function decidedAgainst(publication: unknown): boolean {
  const action = (publication as { approval?: { action?: string } } | null)?.approval?.action;
  return action === "withdraw" || action === "request_changes";
}

// Whether the last review saw the base commit and target branch the change has
// now. Anything missing on either side counts as unverified, never as a match.
function sameReviewedTarget(last: { baseSha: string | null; result: unknown }, changeSet: ChangeSet): boolean {
  const baseRef = (last.result as { change?: { baseRef?: unknown } } | null)?.change?.baseRef;
  return (
    last.baseSha !== null &&
    last.baseSha === changeSet.forgeRef.baseSha &&
    typeof baseRef === "string" &&
    changeSet.baseRef !== undefined &&
    baseRef === changeSet.baseRef
  );
}
