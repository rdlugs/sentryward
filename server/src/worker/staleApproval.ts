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
// approvals on push. So it is withdrawn when commits arrived since the last
// review, or when the skip is the team's own filter (a skip label, author,
// title or branch), which says the change is not for Sentryward to judge.
// Job rows and forge approvals live independently (retention prunes the
// rows), so a missing history is no proof that nothing was approved: the
// forge is asked to withdraw, keeping an approval it can tell covers the
// current head. Best effort: a failure is logged and the job is still
// recorded as skipped.
export async function withdrawStaleApproval(
  publisher: Pick<ForgePublisher, "setApproval">,
  job: Job,
  config: Config,
  changeSet: ChangeSet,
  skip: string,
): Promise<ApprovalOutcome | undefined> {
  if (!config.output.approval.enabled) return undefined;
  const filtered = skip === skipFilterReason(config.triggers, changeSet, job.actor);
  let keepAt: string | undefined;
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
      select: { headSha: true },
    });
    if (last?.headSha === changeSet.forgeRef.headSha) return undefined;
    if (!last) keepAt = changeSet.forgeRef.headSha;
  }
  const why = filtered
    ? skip
    : keepAt
      ? `no review of the current commits is on record (${skip})`
      : `commits since the last review were not reviewed (${skip})`;
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
