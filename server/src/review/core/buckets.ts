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

// Which actionable findings have an inline thread and which are held back to
// the summary. `posted` holds the fingerprints of threads already on the
// change: those findings keep their thread whatever the limits say (it exists
// either way, so holding it back would only repeat it in the summary), and
// they use up the cap, which counts threads per change, not per run. New
// threads fill the slots left, most severe first. The publisher stores the
// outcome in the result (ReviewResult.heldBack) so a re-render agrees with it.
export function inlineSelection(
  findings: Finding[],
  limits?: InlineLimits,
  posted: ReadonlySet<string> = new Set(),
): { inline: Finding[]; heldBack: Finding[] } {
  const actionable = findings.filter((f) => f.bucket === "actionable");
  if (!limits) return { inline: actionable, heldBack: [] };
  const existing = actionable.filter((f) => posted.has(f.fingerprint));
  // Sort is stable, so findings of one severity keep the review's order.
  const eligible = actionable
    .filter((f) => !posted.has(f.fingerprint) && atLeast(f.severity, limits.minSeverity))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const slots = limits.max === null ? eligible.length : Math.max(0, limits.max - existing.length);
  const chosen = new Set([...existing, ...eligible.slice(0, slots)]);
  // Both lists keep the review's order; the cap only decides membership.
  return {
    inline: actionable.filter((f) => chosen.has(f)),
    heldBack: actionable.filter((f) => !chosen.has(f)),
  };
}

export function inlineLimits(output: { inlineMinSeverity: Severity; maxInlineComments: number | null }): InlineLimits {
  return { minSeverity: output.inlineMinSeverity, max: output.maxInlineComments };
}
