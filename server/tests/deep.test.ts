import { describe, expect, it } from "vitest";
import { parseRepoFile } from "../src/review/config/repoFile.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import { SPECIALISTS, configOverrideSchema, type Config, type ConfigOverride } from "../src/review/config/schema.ts";
import type { ContextSource } from "../src/review/context/gather.ts";
import type { Finding, RiskyArea } from "../src/review/core/models.ts";
import type { AgenticRequest, AgenticResponse, GenerateAgentic } from "../src/review/llm/agentic.ts";
import { SPECIALIST_INSTRUCTIONS, deepDecision, lensesFor } from "../src/review/llm/lenses.ts";
import { reviewSystemPrompt } from "../src/review/llm/prompt.ts";
import type { GenerateRequest } from "../src/review/llm/providers.ts";
import { ModelCallError } from "../src/review/llm/providers.ts";
import { runReview } from "../src/review/pipeline.ts";
import { mergeAcrossLenses, titleOverlap } from "../src/review/validate/lensDedupe.ts";
import { APP_PATCH, makeChangeSet } from "./helpers/changeSet.ts";
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
    expect(config().review.deep).toEqual({
      enabled: false,
      autoOn: ["auth", "database", "api"],
      specialists: ["naming", "invariants", "boundaries", "contracts", "tests", "leaks", "consistency"],
    });
    expect(lensesFor(config()).map((lens) => lens.id)).toEqual(["general"]);
  });

  it("can be turned on alone, keeping the specialists from below", () => {
    const resolved = resolveConfig({
      repoSettings: { review: { deep: { specialists: ["tests"] } } },
      trigger: { review: { deep: { enabled: true } } },
    });
    expect(resolved.config.review.deep).toEqual({ enabled: true, autoOn: ["auth", "database", "api"], specialists: ["tests"] });
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

describe("auto deep review", () => {
  const auto = (autoOn?: RiskyArea["kind"][]) =>
    config({ review: { deep: { enabled: "auto", ...(autoOn ? { autoOn } : {}), specialists: ["tests"] } } });
  const route: RiskyArea = { kind: "api", path: "src/routes.ts", reason: "changes an API route" };
  const write: RiskyArea = { kind: "database", path: "src/store.ts", reason: "changes a database write" };
  // Changes a route, which context/risk.ts flags as an api risky area.
  const ROUTE_PATCH = '@@ -1,2 +1,3 @@\n import { app } from "./app";\n+app.post("/users", createUser);\n export {};';
  const routeChange = () => makeChangeSet([{ path: "src/routes.ts", changeType: "modified", patch: ROUTE_PATCH }]);

  it("reads auto and auto_on from the repository file and refuses a bad list", () => {
    const parsed = parseRepoFile(".sentryward.yaml", "review:\n  deep:\n    enabled: auto\n    auto_on: [auth]\n");
    expect(parsed).toEqual({ override: { review: { deep: { enabled: "auto", autoOn: ["auth"] } } }, warnings: [] });
    expect(configOverrideSchema.safeParse({ review: { deep: { autoOn: [] } } }).success).toBe(false);
    expect(configOverrideSchema.safeParse({ review: { deep: { autoOn: ["api", "api"] } } }).success).toBe(false);
    expect(configOverrideSchema.safeParse({ review: { deep: { autoOn: ["css"] } } }).success).toBe(false);
    expect(configOverrideSchema.safeParse({ review: { deep: { enabled: "sometimes" } } }).success).toBe(false);
  });

  it("is overridden by a run that asked for a deep review", () => {
    const resolved = resolveConfig({
      repoSettings: { review: { deep: { enabled: "auto" } } },
      trigger: { review: { deep: { enabled: true } } },
    });
    expect(resolved.config.review.deep.enabled).toBe(true);
    expect(resolved.sources["review.deep.enabled"]).toBe("trigger");
  });

  it("decides from the risky areas of the kinds it runs for", () => {
    expect(deepDecision(deep(["tests"]), [])).toEqual({ run: true });
    expect(deepDecision(config(), [route])).toEqual({ run: false });
    expect(deepDecision(auto(), [route, write])).toEqual({ run: true, auto: { matched: [route, write] } });
    expect(deepDecision(auto(["database"]), [route, write])).toEqual({ run: true, auto: { matched: [write] } });
    expect(deepDecision(auto(["auth"]), [route, write])).toEqual({ run: false, auto: { matched: [] } });
    expect(deepDecision(auto(), [])).toEqual({ run: false, auto: { matched: [] } });
    // "auto" is a string, so it must never read as on.
    expect(lensesFor(auto()).map((lens) => lens.id)).toEqual(["general"]);
  });

  it("runs the specialists on a change touching a chosen kind, and says why", async () => {
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });
    const result = await runReview({ changeSet: routeChange(), config: auto() }, { generate });
    expect(requests.map(specialistOf)).toEqual([undefined, "tests"]);
    expect(result.deepAuto).toEqual({ ran: true, matched: [expect.objectContaining({ kind: "api", path: "src/routes.ts" })] });
  });

  it("runs only the general pass on a change touching none, or only kinds not chosen", async () => {
    const plain = fakeModel({ code_review: { findings: [] } });
    const quiet = await runReview({ changeSet: makeChangeSet(), config: auto() }, { generate: plain.generate });
    expect(plain.requests.map(specialistOf)).toEqual([undefined]);
    expect(quiet.deepAuto).toEqual({ ran: false, matched: [] });

    const other = fakeModel({ code_review: { findings: [] } });
    const result = await runReview({ changeSet: routeChange(), config: auto(["auth", "database"]) }, { generate: other.generate });
    expect(other.requests.map(specialistOf)).toEqual([undefined]);
    expect(result.deepAuto).toEqual({ ran: false, matched: [] });
  });

  it("decides an incremental review on the files it reviews again", async () => {
    const changeSet = makeChangeSet([
      { path: "src/routes.ts", changeType: "modified", patch: ROUTE_PATCH },
      { path: "src/app.ts", changeType: "modified", patch: APP_PATCH },
    ]);
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });
    const increment = { fromSha: "a", toSha: "head", paths: new Set(["src/app.ts"]), carried: [] };
    const result = await runReview({ changeSet, config: auto(), increment }, { generate });
    expect(requests.map(specialistOf)).toEqual([undefined]);
    expect(result.deepAuto).toEqual({ ran: false, matched: [] });
  });

  it("records nothing when deep review is simply on or off", async () => {
    const { generate } = fakeModel({ code_review: { findings: [] } });
    expect((await runReview({ changeSet: routeChange(), config: deep(["tests"]) }, { generate })).deepAuto).toBeUndefined();
    expect((await runReview({ changeSet: routeChange(), config: config() }, { generate })).deepAuto).toBeUndefined();
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

  it("leaves half the agentic searches to the general passes and tags the specialist's findings", async () => {
    const searched: string[] = [];
    const context: ContextSource = {
      readFile: async () => null,
      searchCode: async (term) => {
        searched.push(term);
        return [];
      },
    };
    // Calls the pass's search tool the way the SDK would, without a model.
    const search = (request: AgenticRequest<unknown>, term: string) =>
      (request.tools.search_code as unknown as { execute: (input: unknown, options: unknown) => Promise<string> }).execute(
        { term },
        { toolCallId: "t", messages: [], context: {} },
      );
    // The general pass waits for the specialist to spend what it can, so the
    // test shows the specialist stopping at the reserve rather than the general
    // pass simply getting there first.
    let specialistDone!: () => void;
    const specialistFinished = new Promise<void>((resolve) => (specialistDone = resolve));
    const generateAgentic: GenerateAgentic = async <T>(request: AgenticRequest<T>): Promise<AgenticResponse<T>> => {
      const req = request as AgenticRequest<unknown>;
      const specialist = req.system?.includes(SPECIALIST_INSTRUCTIONS.tests);
      if (specialist) {
        for (const term of ["s1", "s2", "s3", "s4"]) await search(req, term);
        specialistDone();
      } else {
        await specialistFinished;
        for (const term of ["g1", "g2", "g3"]) await search(req, term);
      }
      const findings = specialist
        ? [modelFinding({ title: "The new branch has no test", category: "testing", severity: "minor" })]
        : [modelFinding()];
      return { object: { findings } as T, model: request.model, inputTokens: 900, outputTokens: 60, latencyMs: 9, steps: 2, toolCalls: {} };
    };

    const result = await runReview(
      {
        changeSet: makeChangeSet(),
        config: deep(["tests"], { review: { context: "agentic", agent: { maxSearches: 4 } } }),
      },
      { generate: fakeModel({}).generate, generateAgentic, context, concurrency: 2 },
    );

    // 4 searches in all: the specialist stops at 2, leaving 2 for the general
    // pass. Context gathering searches too, outside the passes' budget.
    expect(searched.filter((term) => /^[sg]\d$/.test(term))).toEqual(["s1", "s2", "g1", "g2"]);
    expect(result.status).toBe("completed");
    expect(result.findings.map((f) => [f.title, f.reviewer])).toEqual([
      ["b overflows for large a", undefined],
      ["The new branch has no test", "tests"],
    ]);
    expect(result.usage.filter((call) => call.purpose === "review").map((call) => call.lens)).toEqual([undefined, "tests"]);
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

  it("never merges two reports from one pass, even after another pass's report replaced the first", () => {
    const result = mergeAcrossLenses([
      finding({ severity: "minor", fingerprint: "g" }),
      finding({ reviewer: "naming", severity: "major", fingerprint: "a1" }),
      finding({ reviewer: "tests", severity: "critical", fingerprint: "b1" }),
      finding({ reviewer: "naming", title: "b overflows for very large a", fingerprint: "a2" }),
    ]);
    expect(result.merged).toBe(2);
    expect(result.findings.map((f) => f.fingerprint)).toEqual(["b1", "a2"]);
  });
});
