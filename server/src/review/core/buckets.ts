import { diffPosition, type Bucket, type ChangeSet, type Finding } from "./models.ts";
import { atLeast, severityRank, type Kind, type Severity } from "./severity.ts";

export const BUCKET_ORDER: Bucket[] = ["actionable", "requirement_gap", "outside_diff", "nitpick"];

// The buckets a forge summary carries, because no inline thread can hold them.
export const SUMMARY_BUCKETS: Bucket[] = ["requirement_gap", "outside_diff", "nitpick"];

export const BUCKET_TITLE: Record<Bucket, string> = {
  actionable: "Actionable comments",
  requirement_gap: "Requirements not met",
  outside_diff: "Outside diff range comments",
  nitpick: "Nitpick comments",
};

export function canAnchor(file: string, line: number, changeSet: ChangeSet): boolean {
  const changed = changeSet.files.find((f) => f.path === file);
  return changed !== undefined && diffPosition(changed, line) !== undefined;
}

// The single decision of which channel a finding belongs on. Terminal-style
// views, the summary comment and the publisher all read the stored bucket
// rather than deciding again. Order matters: a gap has no line by nature, so it
// is never "outside" the diff; anchorability comes next, because a nitpick the
// forge cannot attach is still reported in the summary.
export function bucketFor(
  finding: { file: string; startLine: number; kind: Kind },
  changeSet: ChangeSet,
): Bucket {
  if (finding.kind === "requirement_gap") return "requirement_gap";
  if (!canAnchor(finding.file, finding.startLine, changeSet)) return "outside_diff";
  if (finding.kind === "nitpick") return "nitpick";
  return "actionable";
}

// output.inlineMinSeverity and output.maxInlineComments.
export interface InlineLimits {
  minSeverity: Severity;
  max: number | null;
}

// Which actionable findings get an inline thread and which are held back to
// the summary. Decided from the findings and the limits alone, so the
// publisher, the preview and a re-rendered stored review always agree.
// Threads posted by earlier runs count toward the cap like new ones, or the
// selection would depend on what is already on the change.
export function inlineSelection(findings: Finding[], limits?: InlineLimits): { inline: Finding[]; heldBack: Finding[] } {
  const actionable = findings.filter((f) => f.bucket === "actionable");
  if (!limits) return { inline: actionable, heldBack: [] };
  // Sort is stable, so findings of one severity keep the review's order.
  const eligible = actionable
    .filter((f) => atLeast(f.severity, limits.minSeverity))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const chosen = new Set(limits.max === null ? eligible : eligible.slice(0, limits.max));
  // Both lists keep the review's order; the cap only decides membership.
  return {
    inline: actionable.filter((f) => chosen.has(f)),
    heldBack: actionable.filter((f) => !chosen.has(f)),
  };
}

export function inlineLimits(output: { inlineMinSeverity: Severity; maxInlineComments: number | null }): InlineLimits {
  return { minSeverity: output.inlineMinSeverity, max: output.maxInlineComments };
}
