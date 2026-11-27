import type { ForgeAdapter, ForgePublisher } from "../../review/forge/types.ts";
import { lastPublishedReview, sameReviewedTarget, settledApproval } from "../approvalRecord.ts";
import type { RepoWithConnection, WebhookOutcome } from "./types.ts";

const RETARGET_BODY =
  "Sentryward withdrew this approval: the target branch was changed since it was given. Rerun the review to decide on an approval.";

// A retarget queues no review (trigger settings say nothing about it), but an
// approval given for the old target would go on counting for a target no review
// checked, so Sentryward's own approval is withdrawn here, whether or not
// automatic reviews are on. No config is resolved: withdrawing only touches an
// approval Sentryward gave, which it only did while approval was managed. A
// request for changes stays: it is no less right on another target. A forge
// failure fails the delivery, which can be redelivered, rather than leaving the
// approval standing behind a success.
//
// A delivery can arrive late (a redelivery, or one GitLab or GitHub held back)
// after a review already settled the approval for the new target. So the
// change is read as it stands now and the approval kept when the last review
// recorded a decision at that very head, base commit and target branch: an
// approval then is that review's, not one given before the retarget. This also
// makes the handler idempotent: a repeated delivery with nothing new withdraws
// again, which the forge reports as unchanged.
export async function withdrawOnRetarget(
  forge: Pick<ForgePublisher, "setApproval"> & Pick<ForgeAdapter, "getChangeHead">,
  repo: RepoWithConnection,
  number: number,
): Promise<WebhookOutcome> {
  if (await settledForCurrentTarget(forge, repo, number)) return { body: { outcome: "approval_current" } };
  try {
    // Withdrawing reads the change by project and number only; the shas are
    // not known from the delivery and not needed.
    const outcome = await forge.setApproval(
      { provider: repo.provider, host: repo.host, project: repo.fullPath, number, baseSha: "", startSha: "", headSha: "" },
      { action: "withdraw", approvalsOnly: true, body: RETARGET_BODY },
    );
    return { body: { outcome: outcome.state === "withdrawn" ? "approval_withdrawn" : "ignored" } };
  } catch (err) {
    // A constant format string: the path is forge-provided text.
    console.error("[webhook] could not withdraw the approval on retargeted change %s#%d", repo.fullPath, number, err);
    return { status: 500, body: { outcome: "failed" } };
  }
}

// Whether the last published review decided the approval for the change as the
// forge shows it now. A head GitLab has not diffed yet, a target the forge does
// not name, or a failed read counts as unverified: the approval is withdrawn.
async function settledForCurrentTarget(
  forge: Pick<ForgeAdapter, "getChangeHead">,
  repo: RepoWithConnection,
  number: number,
): Promise<boolean> {
  try {
    const head = await forge.getChangeHead(repo.fullPath, number);
    if (head.liveHeadSha !== undefined && head.liveHeadSha !== head.headSha) return false;
    const last = await lastPublishedReview(repo.id, number);
    return (
      last !== null &&
      last.headSha === head.headSha &&
      sameReviewedTarget(last, { baseSha: head.baseSha, baseRef: head.baseRef }) &&
      settledApproval(last.publication)
    );
  } catch (err) {
    console.error("[webhook] could not read retargeted change %s#%d; withdrawing", repo.fullPath, number, err);
    return false;
  }
}
