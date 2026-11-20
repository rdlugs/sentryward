import type { Finding } from "../src/review/core/models.ts";
import type { Expected, Trap } from "./corpus.ts";

export interface MatchOptions {
  // Lines a finding may sit outside an expected range and still match: models
  // often anchor one line off (the call instead of the argument).
  tolerance: number;
  // Require the category to agree too. Off by default: the issue asks for
  // file and line matching, and category is reported as its own rate.
  strictCategory: boolean;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = { tolerance: 2, strictCategory: false };

type Located = { file: string; startLine: number; endLine: number };

export type ScoredFinding = Pick<
  Finding,
  "file" | "startLine" | "endLine" | "severity" | "category" | "kind" | "bucket" | "title" | "confidence" | "reviewer"
> &
  (
    | { outcome: "match"; expected: number; categoryMatch: boolean }
    | { outcome: "false_positive"; trap?: string }
  );

export interface CaseScore {
  truePositives: number;
  falsePositives: number;
  // False positives that landed on code the case marks as a trap.
  trapHits: number;
  falseNegatives: number;
  categoryMatches: number;
  // null when there is nothing to divide by: no findings, or no expectations.
  precision: number | null;
  recall: number | null;
  findings: ScoredFinding[];
  missed: Expected[];
}

// Negative when the ranges are apart; within -tolerance they still count.
function overlap(a: Located, b: Located): number {
  return Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine);
}

function near(a: Located, b: Located, tolerance: number): boolean {
  return a.file === b.file && overlap(a, b) >= -tolerance;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

type Pair = { finding: number; expected: number; categoryMatch: boolean; overlap: number };

// Compared lexicographically, so any number of category agreements outranks
// any amount of overlap without a magic multiplier.
type Weight = readonly [category: number, overlap: number];

const ZERO: Weight = [0, 0];
const weightOf = (pair: Pair): Weight => [Number(pair.categoryMatch), pair.overlap];
const add = (a: Weight, b: Weight): Weight => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Weight, b: Weight): Weight => [a[0] - b[0], a[1] - b[1]];
const better = (a: Weight, b: Weight | undefined) => b === undefined || a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

// Successive shortest augmenting paths: each round takes the augmenting path
// that gains the most weight, which keeps the matching the heaviest of its
// size, and rounds continue until none is left, which makes it maximum. So
// the result has as many pairs as possible, then as many category agreements,
// then as much overlap, whatever order the findings and expectations come in.
function maximumMatching(pairs: Pair[]): Map<number, Pair> {
  const byFinding = new Map<number, Pair>();
  const byExpected = new Map<number, Pair>();
  const findings = [...new Set(pairs.map((pair) => pair.finding))];

  for (;;) {
    // Longest paths from any free finding (Bellman-Ford): an unmatched pair is
    // walked finding -> expectation and gains its weight, a matched pair is
    // walked back and gives it up. Optimality of the current matching rules
    // out gaining cycles.
    const toFinding = new Map<number, Weight>();
    for (const fi of findings) if (!byFinding.has(fi)) toFinding.set(fi, ZERO);
    const toExpected = new Map<number, Weight>();
    const via = new Map<number, Pair>();
    // A path visits each node once, and there are at most two per pair.
    for (let round = 0, changed = true; changed && round < 2 * pairs.length; round++) {
      changed = false;
      for (const pair of pairs) {
        if (byFinding.get(pair.finding) === pair) {
          const from = toExpected.get(pair.expected);
          if (from && better(sub(from, weightOf(pair)), toFinding.get(pair.finding))) {
            toFinding.set(pair.finding, sub(from, weightOf(pair)));
            changed = true;
          }
        } else {
          const from = toFinding.get(pair.finding);
          if (from && better(add(from, weightOf(pair)), toExpected.get(pair.expected))) {
            toExpected.set(pair.expected, add(from, weightOf(pair)));
            via.set(pair.expected, pair);
            changed = true;
          }
        }
      }
    }

    let end: number | undefined;
    for (const [ei, weight] of toExpected) {
      if (!byExpected.has(ei) && (end === undefined || better(weight, toExpected.get(end)))) end = ei;
    }
    if (end === undefined) return byFinding;

    // Flip the path: each finding on it takes the expectation it was reached
    // through, and hands its old one back up the path.
    for (let ei: number | undefined = end; ei !== undefined; ) {
      const pair: Pair = via.get(ei)!;
      const previous = byFinding.get(pair.finding);
      byFinding.set(pair.finding, pair);
      byExpected.set(ei, pair);
      ei = previous?.expected;
    }
  }
}

// One-to-one: each expectation credits at most one finding, so a model that
// reports the same problem three times gets one true positive and two false
// positives. See maximumMatching for which pairs are chosen.
export function scoreCase(
  findings: Finding[],
  expected: Expected[],
  traps: Trap[],
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
): CaseScore {
  const pairs: Pair[] = [];
  findings.forEach((finding, fi) => {
    expected.forEach((exp, ei) => {
      if (!near(finding, exp, options.tolerance)) return;
      const categoryMatch = exp.categories.includes(finding.category);
      if (options.strictCategory && !categoryMatch) return;
      pairs.push({ finding: fi, expected: ei, categoryMatch, overlap: overlap(finding, exp) });
    });
  });
  const byFinding = maximumMatching(pairs);
  const usedExpected = new Set([...byFinding.values()].map((pair) => pair.expected));

  let trapHits = 0;
  let categoryMatches = 0;
  const scored = findings.map((finding, fi): ScoredFinding => {
    const base = {
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      severity: finding.severity,
      category: finding.category,
      kind: finding.kind,
      bucket: finding.bucket,
      title: finding.title,
      confidence: finding.confidence,
      ...(finding.reviewer ? { reviewer: finding.reviewer } : {}),
    };
    const pair = byFinding.get(fi);
    if (pair) {
      if (pair.categoryMatch) categoryMatches += 1;
      return { ...base, outcome: "match", expected: pair.expected, categoryMatch: pair.categoryMatch };
    }
    // Traps use exact overlap: a finding a few lines away from a trap is not
    // the trap.
    const trap = traps.find((t) => near(finding, t, 0));
    if (trap) trapHits += 1;
    return { ...base, outcome: "false_positive", ...(trap ? { trap: trap.note } : {}) };
  });

  const truePositives = byFinding.size;
  const falsePositives = findings.length - truePositives;
  return {
    truePositives,
    falsePositives,
    trapHits,
    falseNegatives: expected.length - usedExpected.size,
    categoryMatches,
    precision: ratio(truePositives, findings.length),
    recall: ratio(usedExpected.size, expected.length),
    findings: scored,
    missed: expected.filter((_, ei) => !usedExpected.has(ei)),
  };
}

export interface Totals {
  cases: number;
  // Reviews that failed outright (every pass errored, or the run threw). Left
  // out of the rates below so a provider outage does not read as a quality drop.
  errored: number;
  scored: number;
  truePositives: number;
  falsePositives: number;
  trapHits: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  // Share of matched findings whose category was one the case accepts.
  categoryAgreement: number | null;
  // Cases that expect nothing, and the findings reported on them anyway.
  cleanCases: number;
  cleanCaseFalsePositives: number;
}

export interface ScoredCase {
  expectedCount: number;
  // undefined when the review failed.
  score?: CaseScore;
}

// Micro-averaged: every finding and expectation counts once, whichever case it
// belongs to.
export function summarize(cases: ScoredCase[]): Totals {
  const scored = cases.filter((c): c is Required<ScoredCase> => c.score !== undefined);
  const sum = (pick: (score: CaseScore) => number) => scored.reduce((total, c) => total + pick(c.score), 0);
  const truePositives = sum((s) => s.truePositives);
  const falsePositives = sum((s) => s.falsePositives);
  const falseNegatives = sum((s) => s.falseNegatives);
  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  const clean = scored.filter((c) => c.expectedCount === 0);
  return {
    cases: cases.length,
    errored: cases.length - scored.length,
    scored: scored.length,
    truePositives,
    falsePositives,
    trapHits: sum((s) => s.trapHits),
    falseNegatives,
    precision,
    recall,
    // Zero, not undefined, when both rates exist and nothing matched.
    f1: precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    categoryAgreement: ratio(sum((s) => s.categoryMatches), truePositives),
    cleanCases: clean.length,
    cleanCaseFalsePositives: clean.reduce((total, c) => total + c.score.falsePositives, 0),
  };
}
