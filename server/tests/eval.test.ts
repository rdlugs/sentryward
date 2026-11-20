import { describe, expect, it } from "vitest";
import type { Finding, LlmUsage } from "../src/review/core/models.ts";
import { DEFAULT_CONFIG } from "../src/review/config/schema.ts";
import { loadCorpus, type EvalCase, type Expected, type Trap } from "../evals/corpus.ts";
import { caseConfig, evaluate, evaluateCase } from "../evals/evaluate.ts";
import { DEFAULT_MATCH_OPTIONS, scoreCase, summarize } from "../evals/match.ts";
import { costOf, parsePrice } from "../evals/pricing.ts";
import { WALKTHROUGH, fakeModel, modelFinding } from "./helpers/model.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    startLine: 10,
    endLine: 10,
    severity: "major",
    category: "security",
    kind: "potential_issue",
    effort: "quick_win",
    title: "t",
    body: "b",
    confidence: 0.9,
    evidence: "execution_path",
    evidenceNote: "n",
    evidenceFiles: [],
    source: "llm",
    fingerprint: "f",
    bucket: "actionable",
    ...overrides,
  };
}

function expected(overrides: Partial<Expected> = {}): Expected {
  return { file: "src/app.ts", startLine: 10, endLine: 12, categories: ["security"], description: "d", ...overrides };
}

const trap = (overrides: Partial<Trap> = {}): Trap => ({ file: "src/app.ts", startLine: 30, endLine: 30, note: "fine", ...overrides });

describe("scoreCase", () => {
  it("matches a finding to an expectation by file and overlapping lines", () => {
    const score = scoreCase([finding({ startLine: 12, endLine: 14 })], [expected()], []);
    expect(score).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1 });
    expect(score.findings[0]).toMatchObject({ outcome: "match", expected: 0, categoryMatch: true });
  });

  it("allows a finding within the tolerance of the range, and no further", () => {
    expect(scoreCase([finding({ startLine: 14, endLine: 14 })], [expected()], []).truePositives).toBe(1);
    expect(scoreCase([finding({ startLine: 15, endLine: 15 })], [expected()], []).truePositives).toBe(0);
    expect(scoreCase([finding({ startLine: 15, endLine: 15 })], [expected()], [], { ...DEFAULT_MATCH_OPTIONS, tolerance: 3 }).truePositives).toBe(1);
  });

  it("never matches across files", () => {
    const score = scoreCase([finding({ file: "src/other.ts" })], [expected()], []);
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1, precision: 0, recall: 0 });
    expect(score.missed).toEqual([expected()]);
  });

  it("credits an expectation once, so duplicates are false positives", () => {
    const score = scoreCase([finding(), finding({ startLine: 11, endLine: 11 })], [expected()], []);
    expect(score).toMatchObject({ truePositives: 1, falsePositives: 1, precision: 0.5, recall: 1 });
  });

  it("prefers the pairing whose category agrees", () => {
    const score = scoreCase(
      [finding({ category: "style" }), finding({ category: "security", startLine: 13, endLine: 13 })],
      [expected()],
      [],
    );
    expect(score.findings.map((f) => f.outcome)).toEqual(["false_positive", "match"]);
    expect(score.categoryMatches).toBe(1);
  });

  it("records a category mismatch, and rejects it only when strict", () => {
    const loose = scoreCase([finding({ category: "bug" })], [expected()], []);
    expect(loose.findings[0]).toMatchObject({ outcome: "match", categoryMatch: false });
    expect(loose.categoryMatches).toBe(0);
    const strict = scoreCase([finding({ category: "bug" })], [expected()], [], { ...DEFAULT_MATCH_OPTIONS, strictCategory: true });
    expect(strict.truePositives).toBe(0);
  });

  it("finds the largest matching even when the preferred pair would block it", () => {
    // Greedy would pair the wide finding with line 10 and leave line 9 nowhere
    // to go; pairing it with line 12 matches both.
    const score = scoreCase(
      [finding({ startLine: 10, endLine: 12 }), finding({ startLine: 9, endLine: 9 })],
      [expected({ startLine: 10, endLine: 10 }), expected({ startLine: 12, endLine: 12 })],
      [],
      { ...DEFAULT_MATCH_OPTIONS, tolerance: 1 },
    );
    expect(score).toMatchObject({ truePositives: 2, falsePositives: 0, falseNegatives: 0 });
    expect(score.findings.map((f) => f.outcome === "match" && f.expected)).toEqual([1, 0]);
  });

  it("maximizes category agreement whatever order the expectations come in", () => {
    const findings = [finding({ startLine: 10, endLine: 12, category: "security" }), finding({ startLine: 10, endLine: 12, category: "bug" })];
    const either = expected({ startLine: 10, endLine: 10, categories: ["security", "bug"] });
    const securityOnly = expected({ startLine: 12, endLine: 12, categories: ["security"] });
    for (const order of [[either, securityOnly], [securityOnly, either]]) {
      expect(scoreCase(findings, order, [])).toMatchObject({ truePositives: 2, categoryMatches: 2 });
    }
  });

  // Every one-to-one assignment, scored the way scoreCase ranks them.
  function bruteForce(findings: Finding[], exps: Expected[], tolerance: number): [number, number, number] {
    let best: [number, number, number] = [0, 0, 0];
    const visit = (fi: number, used: Set<number>, acc: [number, number, number]) => {
      if (acc[0] > best[0] || (acc[0] === best[0] && (acc[1] > best[1] || (acc[1] === best[1] && acc[2] > best[2])))) best = acc;
      if (fi === findings.length) return;
      visit(fi + 1, used, acc);
      const f = findings[fi]!;
      exps.forEach((e, ei) => {
        const amount = Math.min(f.endLine, e.endLine) - Math.max(f.startLine, e.startLine);
        if (used.has(ei) || f.file !== e.file || amount < -tolerance) return;
        visit(fi + 1, new Set([...used, ei]), [acc[0] + 1, acc[1] + Number(e.categories.includes(f.category)), acc[2] + amount]);
      });
    };
    visit(0, new Set(), [0, 0, 0]);
    return best;
  }

  it("agrees with brute force on random small cases", () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const categories = ["security", "bug", "logic"] as const;
    for (let trial = 0; trial < 300; trial++) {
      const findings = Array.from({ length: 1 + random(5) }, () => {
        const start = 1 + random(12);
        return finding({ startLine: start, endLine: start + random(3), category: categories[random(3)] });
      });
      const exps = Array.from({ length: 1 + random(4) }, () => {
        const start = 1 + random(12);
        return expected({ startLine: start, endLine: start + random(2), categories: categories.filter(() => random(2) === 0) });
      });
      const score = scoreCase(findings, exps, [], { tolerance: 1, strictCategory: false });
      const overlapSum = score.findings.reduce((total, f) => {
        if (f.outcome !== "match") return total;
        const e = exps[f.expected]!;
        return total + Math.min(f.endLine, e.endLine) - Math.max(f.startLine, e.startLine);
      }, 0);
      expect([score.truePositives, score.categoryMatches, overlapSum], `trial ${trial}`).toEqual(bruteForce(findings, exps, 1));
    }
  });

  it("tags a false positive that lands on a trap, without tolerance", () => {
    const score = scoreCase([finding({ startLine: 30, endLine: 30 }), finding({ startLine: 32, endLine: 32 })], [], [trap()]);
    expect(score.trapHits).toBe(1);
    expect(score.findings[0]).toMatchObject({ outcome: "false_positive", trap: "fine" });
    expect(score.findings[1]).not.toHaveProperty("trap");
  });

  it("leaves a rate undefined when there is nothing to divide by", () => {
    expect(scoreCase([], [], [])).toMatchObject({ precision: null, recall: null });
    expect(scoreCase([finding()], [], [])).toMatchObject({ precision: 0, recall: null, falsePositives: 1 });
  });
});

describe("summarize", () => {
  it("micro-averages scored cases and leaves failed ones out", () => {
    const hit = scoreCase([finding()], [expected()], []);
    const miss = scoreCase([], [expected()], []);
    const noisy = scoreCase([finding(), finding({ startLine: 40, endLine: 40 })], [], []);
    const totals = summarize([
      { expectedCount: 1, score: hit },
      { expectedCount: 1, score: miss },
      { expectedCount: 0, score: noisy },
      { expectedCount: 1 },
    ]);
    expect(totals).toMatchObject({
      cases: 4,
      errored: 1,
      scored: 3,
      truePositives: 1,
      falsePositives: 2,
      falseNegatives: 1,
      cleanCases: 1,
      cleanCaseFalsePositives: 2,
      categoryAgreement: 1,
    });
    expect(totals.precision).toBeCloseTo(1 / 3);
    expect(totals.recall).toBeCloseTo(1 / 2);
    expect(totals.f1).toBeCloseTo(0.4);
  });

  it("scores F1 as zero when nothing matched, and leaves it undefined without findings", () => {
    const wrong = scoreCase([finding({ startLine: 40, endLine: 40 })], [expected()], []);
    expect(summarize([{ expectedCount: 1, score: wrong }])).toMatchObject({ precision: 0, recall: 0, f1: 0 });
    const silent = scoreCase([], [expected()], []);
    expect(summarize([{ expectedCount: 1, score: silent }])).toMatchObject({ precision: null, recall: 0, f1: null });
  });
});

describe("pricing", () => {
  const call = (model: string): LlmUsage => ({ purpose: "review", model, inputTokens: 1_000_000, outputTokens: 100_000, latencyMs: 1 });

  it("prices known models and refuses to guess the rest", () => {
    expect(costOf([call("anthropic/claude-sonnet-5-5")])).toBeCloseTo(3);
    expect(costOf([call("anthropic/claude-sonnet-5-5"), call("openai/unknown")])).toBeNull();
    expect(costOf([call("openai/unknown")], parsePrice("1, 2"))).toBeCloseTo(1.2);
    expect(() => parsePrice("1")).toThrow(/--price/);
    for (const bad of [",10", "1,", "Infinity,10", "1,NaN", "1,2,3", "-1,2"]) {
      expect(() => parsePrice(bad), bad).toThrow(/--price/);
    }
  });
});

describe("corpus", () => {
  const corpus = loadCorpus();

  it("has enough cases across languages, including clean ones", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(15);
    expect(new Set(corpus.map((c) => c.language)).size).toBeGreaterThanOrEqual(2);
    expect(corpus.filter((c) => c.expected.length === 0).length).toBeGreaterThanOrEqual(3);
    expect(corpus.filter((c) => c.expected.length > 0).length).toBeGreaterThanOrEqual(10);
  });

  // Ranges have the shape a validated finding can take: the validator moves a
  // start off an unchanged line onto the nearest added one (or drops the
  // finding), and keeps an end only inside the start's hunk. A range that
  // starts on a context line may never be matched, so the case would silently
  // mis-score.
  it.each(corpus.map((c) => [c.id, c] as const))("%s starts every range on an added line", (_, evalCase) => {
    for (const range of [...evalCase.expected, ...evalCase.traps]) {
      const file = evalCase.changeSet.files.find((f) => f.path === range.file);
      expect(file, `${range.file} is not in the diff`).toBeDefined();
      const hunk = file!.hunks.find((h) => h.addedLines.includes(range.startLine));
      expect(hunk && hunk.newLineToPosition[String(range.endLine)] !== undefined, `${range.file}:${range.startLine}-${range.endLine}`).toBe(true);
    }
    expect(() => caseConfig(evalCase, "anthropic/claude-sonnet-5-5")).not.toThrow();
  });

  it("rejects an unknown case id", () => {
    expect(() => loadCorpus(["no-such-case"])).toThrow(/Unknown case/);
  });
});

describe("evaluate", () => {
  const [sqlCase] = loadCorpus(["ts-sql-injection"]) as [EvalCase];

  it("reviews a case with the thinking and context being compared", () => {
    const config = caseConfig(sqlCase, "anthropic/claude-sonnet-5-5", { thinking: "medium", context: "agentic" });
    expect(config.llm.thinking).toBe("medium");
    expect(config.review.context).toBe("agentic");
    expect(caseConfig(sqlCase, "anthropic/claude-sonnet-5-5").llm.thinking).toBe("off");
  });

  it("turns deep review on or off for the comparison, keeping the default specialists", () => {
    expect(caseConfig(sqlCase, "anthropic/claude-sonnet-5-5", { deep: true }).review.deep.enabled).toBe(true);
    expect(caseConfig(sqlCase, "anthropic/claude-sonnet-5-5", { deep: false }).review.deep.enabled).toBe(false);
    expect(caseConfig(sqlCase, "anthropic/claude-sonnet-5-5").review.deep).toEqual(DEFAULT_CONFIG.review.deep);
  });

  it("reviews a case and scores what the model reported", async () => {
    const { generate, requests } = fakeModel({
      code_review: {
        findings: [
          modelFinding({ file: "src/products/repository.ts", startLine: 17, endLine: 17, severity: "major", category: "security" }),
        ],
      },
      walkthrough: WALKTHROUGH,
    });

    const report = await evaluateCase(sqlCase, { generate }, { model: "anthropic/claude-sonnet-5-5", match: DEFAULT_MATCH_OPTIONS, concurrency: 1 });

    expect(requests.every((r) => r.model === "anthropic/claude-sonnet-5-5")).toBe(true);
    // The case's after/ tree stands in for the head revision.
    expect(requests.find((r) => r.schemaName === "code_review")?.prompt).toContain("findById");
    expect(report).toMatchObject({ status: "completed", score: { truePositives: 1, falsePositives: 0, recall: 1 } });
    expect(report.usage.byPurpose.review).toMatchObject({ calls: 1, inputTokens: 100 });
    expect(report.costUsd).toBeGreaterThan(0);
  });

  it("reports a failed review as errored instead of scoring it", async () => {
    const { generate } = fakeModel({ code_review: new Error("rate limited"), walkthrough: WALKTHROUGH });

    const run = await evaluate([sqlCase], { generate }, { model: "anthropic/claude-sonnet-5-5", match: DEFAULT_MATCH_OPTIONS, concurrency: 1 });

    // The walkthrough's usage is recorded, but the failed call may have been
    // billed too, so the cost is unknown rather than the walkthrough's alone.
    expect(run.cases[0]).toMatchObject({ status: "failed", error: expect.stringContaining("rate limited"), costUsd: null });
    expect(run.cases[0]).not.toHaveProperty("score");
    expect(run.totals).toMatchObject({ errored: 1, scored: 0, precision: null, recall: null, costUsd: null });
  });

  it("leaves the cost unknown when a review throws", async () => {
    const { generate } = fakeModel({ code_review: { findings: [] }, walkthrough: WALKTHROUGH });
    const broken = { ...sqlCase, changeSet: null as never };

    const run = await evaluate([broken, sqlCase], { generate }, { model: "anthropic/claude-sonnet-5-5", match: DEFAULT_MATCH_OPTIONS, concurrency: 1 });

    expect(run.cases[0]).toMatchObject({ status: "error", costUsd: null });
    expect(run.cases[1]?.costUsd).toBeGreaterThan(0);
    // One unknown makes the total unknown rather than a partial sum.
    expect(run.totals.costUsd).toBeNull();
  });
});
