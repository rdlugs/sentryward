import type { Finding } from "../core/models.ts";
import { compareFindings, stronger } from "./validator.ts";

// How much two titles must share (Jaccard over their words) before reports on
// overlapping lines count as one problem. Overlapping lines alone are not
// enough: two different bugs often sit on the same lines, and merging them
// would silently lose one. Tuned with the evals (npm run eval -- --deep).
export const TITLE_OVERLAP = 0.5;

// Words too common in finding titles to say what the problem is.
const STOPWORDS = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "is", "be", "can", "may", "not", "and", "or", "when", "with", "without"]);

function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word)),
  );
}

export function titleOverlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function sameProblem(a: Finding, b: Finding): boolean {
  return (
    a.file === b.file &&
    a.category === b.category &&
    a.startLine <= b.endLine &&
    b.startLine <= a.endLine &&
    titleOverlap(a.title, b.title) >= TITLE_OVERLAP
  );
}

// A deep review asks several passes about the same lines, so one problem can
// come back in different words: the fingerprint (exact title) does not catch
// that. Only reports from different passes are merged, so this never changes
// what a review without deep mode reports. The general pass is considered
// first and keeps its report on a tie. Returned in compareFindings order, as
// the cap that follows expects.
export function mergeAcrossLenses(findings: Finding[]): { findings: Finding[]; merged: number } {
  const ordered = [...findings].sort((a, b) => Number(a.reviewer !== undefined) - Number(b.reviewer !== undefined));
  const kept: Finding[] = [];
  let merged = 0;
  for (const finding of ordered) {
    const index = kept.findIndex((other) => other.reviewer !== finding.reviewer && sameProblem(other, finding));
    if (index === -1) {
      kept.push(finding);
      continue;
    }
    kept[index] = stronger(kept[index]!, finding);
    merged += 1;
  }
  return { findings: kept.sort(compareFindings), merged };
}
