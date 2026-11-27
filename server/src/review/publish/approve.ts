import type { Config } from "../config/schema.ts";
import type { ChangeSet, ReviewResult } from "../core/models.ts";
import type { ForgeProvider } from "../core/models.ts";
import { FORGE_INFO } from "../forge/providers.ts";
import type { ApprovalAction } from "../forge/types.ts";
import { plural } from "../core/plural.ts";
import { blockingFindings } from "../core/verdict.ts";
import { ignoreMatcher } from "../context/ignore.ts";
import { diffAreas, RISK_KIND_TEXT } from "../context/risk.ts";

export interface ApprovalDecision {
  action: ApprovalAction["action"];
  // Why the change is not approved; empty for an approval.
  reasons: string[];
}

type Change = Pick<ChangeSet, "author" | "labels" | "files" | "filesTruncated">;

// Policies hold an approval back; they never grant one. Each match is a
// reason, so the summary of a withdrawn approval says every one.
export function approvalPolicyReasons(approval: Config["output"]["approval"], change: Change): string[] {
  const reasons: string[] = [];
  // The forge stopped listing files: the review, the path policy and the risk
  // policy all saw only part of the change.
  if (change.filesTruncated) {
    reasons.push(`The forge listed only ${plural(change.files.length, "file")} of the change, so not all of it was checked`);
  }
  if (approval.blockPaths.length) {
    const blocked = ignoreMatcher(approval.blockPaths);
    // A rename counts on either side: moving a file out of a protected folder
    // changes that folder too.
    const file = change.files.find((f) => blocked(f.path) || (f.previousPath !== undefined && blocked(f.previousPath)));
    if (file) reasons.push(`It changes ${file.path}, which needs a person's approval`);
  }
  const author = change.author?.toLowerCase();
  const listed = (list: string[]) => author !== undefined && list.some((login) => login.toLowerCase() === author);
  if (approval.onlyAuthors.length && !listed(approval.onlyAuthors)) {
    reasons.push(change.author ? `Changes by ${change.author} are not approved automatically` : "The change's author is unknown");
  } else if (listed(approval.skipAuthors)) {
    reasons.push(`Changes by ${change.author} are not approved automatically`);
  }
  const label = (change.labels ?? []).find((name) => approval.blockLabels.includes(name));
  if (label) reasons.push(`The change has the label "${label}"`);
  if (approval.blockOnRisk.length) {
    const kinds = new Set(diffAreas(change.files).map((area) => area.kind));
    const hit = approval.blockOnRisk.filter((kind) => kinds.has(kind));
    if (hit.length) reasons.push(`It touches ${hit.map((kind) => RISK_KIND_TEXT[kind]).join(", ")}`);
  }
  return reasons;
}

// What this run asks of Sentryward's approval, or null to leave it alone (the
// setting is off). Only a completed review may approve: a partial or failed
// one's silence means nothing, the same rule as the verdict.
export function approvalDecision(config: Config, result: ReviewResult, change: Change): ApprovalDecision | null {
  const { approval } = config.output;
  if (!approval.enabled) return null;
  const { verdict, blocking, blockOn } = result.verdict;
  if (verdict === "error") return { action: "withdraw", reasons: ["The review did not complete"] };
  // Blocking findings stand even when part of the review failed, so they come
  // before the completeness check: they are the better reason to give.
  if (verdict === "blocked") {
    return {
      action: approval.requestChanges ? "request_changes" : "withdraw",
      reasons: [`${plural(blocking.length, "finding")} at or above ${blockOn}`],
    };
  }
  if (result.status !== "completed") return { action: "withdraw", reasons: ["The review did not complete"] };
  // The verdict passed under a threshold a repository file or trigger loosened;
  // the dashboard's still holds the approval (config/resolve.ts). Withdraw
  // rather than request changes: the verdict and the commit status say pass.
  const guard = config.approvalGuard;
  if (guard) {
    const held = blockingFindings(result.findings, guard.blockOn, guard.toolFindingsBlock);
    if (held.length) return { action: "withdraw", reasons: [`${plural(held.length, "finding")} at or above ${guard.blockOn}`] };
  }
  if (approval.when === "no_findings" && result.findings.length) {
    return { action: "withdraw", reasons: [`${plural(result.findings.length, "finding")} still open`] };
  }
  const reasons = approvalPolicyReasons(approval, change);
  return { action: reasons.length ? "withdraw" : "approve", reasons };
}

// The decision as the forge can carry it out: where there is no "request
// changes", a request for changes withdraws. Shared by publishing and the
// preview so the preview never promises what publishing will not do.
export function forgeApprovalDecision(provider: ForgeProvider, decision: ApprovalDecision): ApprovalDecision {
  if (decision.action === "request_changes" && !FORGE_INFO[provider].requestChanges) return { ...decision, action: "withdraw" };
  return decision;
}

// The review body that goes with the approval or request for changes, and the
// message a dismissal records.
export function approvalBody(result: ReviewResult, decision: ApprovalDecision, targetUrl?: string): string {
  const link = targetUrl ? `\n\n[Review in Sentryward](${targetUrl})` : "";
  if (decision.action === "approve") {
    const clean = result.findings.length ? `No findings at or above ${result.verdict.blockOn}` : "No findings";
    return `Sentryward approves this change: ${clean}.${link}`;
  }
  const why = decision.reasons.join("; ");
  if (decision.action === "request_changes") return `Sentryward requests changes: ${why}.${link}`;
  return `Sentryward no longer approves this change: ${why}.${link}`;
}
