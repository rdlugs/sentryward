import type { ForgePublisher } from "../../review/forge/types.ts";
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
export async function withdrawOnRetarget(
  forge: Pick<ForgePublisher, "setApproval">,
  repo: RepoWithConnection,
  number: number,
): Promise<WebhookOutcome> {
  try {
    // Withdrawing reads the change by project and number only; the shas are
    // not known from the delivery and not needed.
    const outcome = await forge.setApproval(
      { provider: repo.provider, host: repo.host, project: repo.fullPath, number, baseSha: "", startSha: "", headSha: "" },
      { action: "withdraw", approvalsOnly: true, body: RETARGET_BODY },
    );
    return { body: { outcome: outcome.state === "withdrawn" ? "approval_withdrawn" : "ignored" } };
  } catch (err) {
    console.error(`[webhook] could not withdraw the approval on retargeted change ${repo.fullPath}#${number}`, err);
    return { status: 500, body: { outcome: "failed" } };
  }
}
