import { describe, expect, it } from "vitest";
import { parseRepoFile } from "../src/review/config/repoFile.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import { SPECIALISTS, configOverrideSchema, type Config, type ConfigOverride } from "../src/review/config/schema.ts";
import type { Finding } from "../src/review/core/models.ts";
import { SPECIALIST_INSTRUCTIONS, lensesFor } from "../src/review/llm/lenses.ts";
import { reviewSystemPrompt } from "../src/review/llm/prompt.ts";
import type { GenerateRequest } from "../src/review/llm/providers.ts";
import { ModelCallError } from "../src/review/llm/providers.ts";
import { runReview } from "../src/review/pipeline.ts";
import { mergeAcrossLenses, titleOverlap } from "../src/review/validate/lensDedupe.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { fakeModel, modelFinding } from "./helpers/model.ts";

// Walkthrough off so every model call in these tests is a review pass.
const config = (override: ConfigOverride = {}): Config =>
  resolveConfig({ trigger: { ...override, output: { walkthrough: false, ...override.output } } }).config;

const deep = (specialists: Config["review"]["deep"]["specialists"], override: ConfigOverride = {}) =>
  config({ ...override, review: { ...override.review, deep: { enabled: true, specialists } } });

// The specialist a review request was made for, read off its system prompt.
function specialistOf(request: GenerateRequest<unknown>): string | undefined {
  return SPECIALISTS.find((id) => request.system?.includes(SPECIALIST_INSTRUCTIONS[id]));
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    startLine: 11,
    endLine: 11,
    severity: "major",
    category: "bug",
    kind: "potential_issue",
    effort: "quick_win",
    title: "b overflows for large a",
    body: "b",
    confidence: 0.9,
    evidence: "execution_path",
    evidenceNote: "n",
    evidenceFiles: [],
    source: "llm",
    fingerprint: "fp",
    bucket: "actionable",
    ...overrides,
  };
}

describe("deep review config", () => {
  it("is off by default, with every specialist selected", () => {
    expect(config().review.deep).toEqual({ enabled: false, specialists: [...SPECIALISTS] });
    expect(lensesFor(config()).map((lens) => lens.id)).toEqual(["general"]);
  });

  it("can be turned on alone, keeping the specialists from below", () => {
    const resolved = resolveConfig({
      repoSettings: { review: { deep: { specialists: ["tests"] } } },
      trigger: { review: { deep: { enabled: true } } },
    });
    expect(resolved.config.review.deep).toEqual({ enabled: true, specialists: ["tests"] });
    expect(resolved.sources["review.deep.enabled"]).toBe("trigger");
    expect(resolved.sources["review.deep.specialists"]).toBe("repoSettings");
    expect(lensesFor(resolved.config).map((lens) => lens.id)).toEqual(["general", "tests"]);
  });

  it("reads snake_case from the repository file and refuses an empty or repeated list", () => {
    const parsed = parseRepoFile(".sentryward.yaml", "review:\n  deep:\n    enabled: true\n    specialists: [leaks]\n");
    expect(parsed).toEqual({ override: { review: { deep: { enabled: true, specialists: ["leaks"] } } }, warnings: [] });
    expect(configOverrideSchema.safeParse({ review: { deep: { specialists: [] } } }).success).toBe(false);
    expect(configOverrideSchema.safeParse({ review: { deep: { specialists: ["tests", "tests"] } } }).success).toBe(false);
    expect(configOverrideSchema.safeParse({ review: { deep: { specialists: ["vibes"] } } }).success).toBe(false);
  });
});

describe("specialist prompts", () => {
  const withRule = (override: ConfigOverride = {}) =>
    config({ ...override, rules: [{ id: "no-console", description: "Do not log with console.", severity: "minor" }] });

  it("give a specialist its own instructions instead of the team rules", () => {
    const [general, tests] = lensesFor(deep(["tests"], {}));
    const cfg = withRule({ review: { deep: { enabled: true, specialists: ["tests"] } } });
    const generalPrompt = reviewSystemPrompt(cfg, general);
    const testsPrompt = reviewSystemPrompt(cfg, tests);

    expect(generalPrompt).toContain("no-console");
    expect(generalPrompt).not.toContain("Deep review pass");
    expect(testsPrompt).toContain(SPECIALIST_INSTRUCTIONS.tests);
    expect(testsPrompt).not.toContain("no-console");
    // The shared part comes first, so both stay cacheable from one prefix.
    const shared = reviewSystemPrompt(cfg, general).split("\n\nTeam rules")[0]!;
    expect(testsPrompt.startsWith(shared)).toBe(true);
  });
});

describe("runReview with deep review", () => {
  it("runs one general pass per chunk without deep review", async () => {
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });
    await runReview({ changeSet: makeChangeSet(), config: config() }, { generate });
    expect(requests).toHaveLength(1);
    expect(specialistOf(requests[0]!)).toBeUndefined();
  });

  it("adds a pass per specialist and tags what each one found", async () => {
    const progress: number[] = [];
    const { generate, requests } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) => {
        const specialist = specialistOf(request);
        if (specialist === "tests") {
          // Filed under testing, which the default categories leave out, and
          // naming a rule it was never given.
          return {
            findings: [
              modelFinding({ title: "The new branch has no test", category: "testing", severity: "minor", ruleId: "no-console" }),
            ],
          };
        }
        if (specialist === "naming") return { findings: [] };
        return { findings: [modelFinding()] };
      },
    });

    const result = await runReview(
      { changeSet: makeChangeSet(), config: deep(["naming", "tests"]) },
      {
        generate,
        onProgress: (p) => {
          if (p.stage === "reviewing") progress.push(p.passes!.total);
        },
      },
    );

    expect(requests.map(specialistOf)).toEqual([undefined, "naming", "tests"]);
    // The first report comes before any pass finishes, then one per pass.
    expect(progress).toEqual([3, 3, 3, 3]);
    expect(result.status).toBe("completed");
    expect(result.coverage.passes).toBe(1);
    expect(result.findings.map((f) => [f.title, f.reviewer, f.category, f.source])).toEqual([
      ["b overflows for large a", undefined, "bug", "llm"],
      ["The new branch has no test", "tests", "testing", "llm"],
    ]);
    expect(result.findings[1]!.ruleId).toBeUndefined();
    expect(result.usage.map((call) => call.lens)).toEqual([undefined, "naming", "tests"]);
  });

  it("keeps the review complete when a specialist pass fails", async () => {
    const { generate } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) =>
        specialistOf(request) === "leaks"
          ? new ModelCallError("unparseable", [{ model: "anthropic/x", inputTokens: 900, outputTokens: 80, latencyMs: 4 }])
          : { findings: [modelFinding()] },
    });

    const result = await runReview({ changeSet: makeChangeSet(), config: deep(["leaks"]) }, { generate });

    expect(result.status).toBe("completed");
    expect(result.errors).toEqual([]);
    expect(result.coverage).toMatchObject({ reviewedFiles: ["src/app.ts"], omissions: [] });
    expect(result.warnings).toEqual(["Deep review pass leaks on pass 1 failed: unparseable"]);
    expect(result.usage.filter((call) => call.failed)).toEqual([
      expect.objectContaining({ purpose: "review", lens: "leaks", inputTokens: 900, failed: true }),
    ]);
    expect(result.findings).toHaveLength(1);
  });

  it("still fails the review when the general pass fails", async () => {
    const { generate } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) =>
        specialistOf(request) ? { findings: [modelFinding({ title: "Something else" })] } : new Error("down"),
    });

    const result = await runReview({ changeSet: makeChangeSet(), config: deep(["boundaries"]) }, { generate });

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["Review pass 1 failed: down"]);
    // The specialist's findings need a file the general pass reviewed, and
    // their loss is said, since the specialist's call was paid for.
    expect(result.findings).toEqual([]);
    expect(result.warnings).toContain("1 deep review finding was dropped with files whose review pass failed");
  });

  it("drops only what a specialist found in the part of a split file whose general pass failed", async () => {
    // Each hunk nearly fills the 2,000-token minimum pass, so the file is
    // split across two passes.
    const patch = [
      `@@ -1,2 +1,3 @@\n a\n+${"x".repeat(7000)}\n b`,
      `@@ -100,2 +100,3 @@\n a\n+${"y".repeat(7000)}\n b`,
    ].join("\n");
    const changeSet = makeChangeSet([{ path: "src/big.ts", changeType: "modified", patch }]);
    const { generate } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) => {
        const second = request.prompt.includes("yyyy");
        if (!specialistOf(request)) return second ? new Error("down") : { findings: [] };
        const line = second ? 101 : 2;
        return {
          findings: [modelFinding({ file: "src/big.ts", startLine: line, endLine: line, title: `Problem on line ${line}` })],
        };
      },
    });

    const result = await runReview(
      { changeSet, config: deep(["boundaries"], { llm: { contextBudget: 4000 }, review: { requireEvidence: false } }) },
      { generate },
    );

    expect(result.coverage.passes).toBe(2);
    expect(result.errors).toEqual(["Review pass 2 failed: down"]);
    expect(result.findings.map((f) => [f.title, f.reviewer])).toEqual([["Problem on line 2", "boundaries"]]);
    expect(result.warnings).toContain("1 deep review finding was dropped with files whose review pass failed");
  });

  it("says nothing about dropped findings when the general pass succeeds", async () => {
    const { generate } = fakeModel({ code_review: { findings: [modelFinding()] } });

    const result = await runReview({ changeSet: makeChangeSet(), config: deep(["boundaries"]) }, { generate });

    expect(result.warnings.filter((warning) => warning.includes("dropped"))).toEqual([]);
  });

  it("merges a specialist's rewording of a general finding, but not a different problem", async () => {
    const { generate } = fakeModel({
      code_review: (request: GenerateRequest<unknown>) =>
        specialistOf(request)
          ? {
              findings: [
                modelFinding({ title: "b overflows for very large a", confidence: 0.95 }),
                modelFinding({ title: "c is computed from a stale value", confidence: 0.8 }),
              ],
            }
          : { findings: [modelFinding()] },
    });

    const result = await runReview({ changeSet: makeChangeSet(), config: deep(["boundaries"]) }, { generate });

    expect(result.findings.map((f) => [f.title, f.reviewer])).toEqual([
      ["b overflows for very large a", "boundaries"],
      ["c is computed from a stale value", "boundaries"],
    ]);
    expect(result.validation.dropped.duplicate).toBe(1);
  });
});

describe("mergeAcrossLenses", () => {
  it("compares titles by their words", () => {
    expect(titleOverlap("b overflows for large a", "B overflows for very large a")).toBeGreaterThanOrEqual(0.5);
    expect(titleOverlap("b overflows for large a", "c is computed from a stale value")).toBe(0);
    expect(titleOverlap("", "anything")).toBe(0);
  });

  it("never merges reports from the same pass, or on lines that do not overlap", () => {
    const same = mergeAcrossLenses([
      finding({ reviewer: "tests", fingerprint: "1" }),
      finding({ reviewer: "tests", title: "b overflows for very large a", fingerprint: "2" }),
    ]);
    expect(same).toMatchObject({ merged: 0 });
    expect(same.findings).toHaveLength(2);

    const apart = mergeAcrossLenses([finding({ fingerprint: "1" }), finding({ reviewer: "tests", startLine: 30, endLine: 30, fingerprint: "2" })]);
    expect(apart.merged).toBe(0);
  });

  it("keeps the general report on a tie and the stronger one otherwise", () => {
    const tie = mergeAcrossLenses([finding({ reviewer: "tests", fingerprint: "s" }), finding({ fingerprint: "g" })]);
    expect(tie.findings.map((f) => f.fingerprint)).toEqual(["g"]);

    const stronger = mergeAcrossLenses([finding({ fingerprint: "g" }), finding({ reviewer: "tests", severity: "critical", fingerprint: "s" })]);
    expect(stronger.findings.map((f) => f.fingerprint)).toEqual(["s"]);
  });
});
