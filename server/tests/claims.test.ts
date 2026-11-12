import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { Config, ConfigOverride } from "../src/review/config/schema.ts";
import type { Claim, Finding } from "../src/review/core/models.ts";
import type { ContextSource } from "../src/review/context/gather.ts";
import { repairReviewOutput } from "../src/review/llm/schemas.ts";
import { runReview } from "../src/review/pipeline.ts";
import { checkClaims } from "../src/review/validate/claims.ts";
import { APP_PATCH, makeChangeSet } from "./helpers/changeSet.ts";
import { fakeModel, modelFinding } from "./helpers/model.ts";

// The head revision as a map of path to content; a search returns every path
// whose content mentions the term, or `searchIndex` when given (GitHub's index
// is the default branch, which can disagree with the head).
function source(files: Record<string, string>, searchIndex?: Record<string, string[]>) {
  const calls = { reads: [] as string[], searches: [] as string[] };
  const ctx: ContextSource = {
    async readFile(path) {
      calls.reads.push(path);
      return files[path] ?? null;
    },
    async searchCode(term) {
      calls.searches.push(term);
      return searchIndex?.[term] ?? Object.keys(files).filter((path) => files[path]!.includes(term));
    },
  };
  return { ctx, calls };
}

function finding(claim: Claim, overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    startLine: 11,
    endLine: 11,
    severity: "minor",
    category: "maintainability",
    kind: "potential_issue",
    effort: "quick_win",
    title: "Unused",
    body: "Remove it.",
    confidence: 0.8,
    evidence: "unverified",
    evidenceNote: "",
    evidenceFiles: [],
    source: "llm",
    fingerprint: "fp",
    bucket: "actionable",
    claim,
    ...overrides,
  };
}

// src/app.ts at the head: line 11 declares b (an added line).
const APP = ["", "", "", "", "", "", "", "", "export function main() {", "const a = 1;", "export const b = a + 1;", "const c = 2;", "const d = 4;", "return d;"].join("\n");

async function check(claim: Claim, files: Record<string, string>, options: { searchIndex?: Record<string, string[]>; changeSet?: ReturnType<typeof makeChangeSet>; maxSearches?: number } = {}) {
  const { ctx, calls } = source(files, options.searchIndex);
  const result = await checkClaims({
    findings: [finding(claim)],
    changeSet: options.changeSet ?? makeChangeSet(),
    source: ctx,
    ...(options.maxSearches !== undefined ? { maxSearches: options.maxSearches } : {}),
  });
  return { result, calls };
}

describe("checkClaims", () => {
  it("drops a missing_path finding when the path exists at the head", async () => {
    const { result } = await check({ kind: "missing_path", subject: "./src/lib/format.ts" }, { "src/app.ts": APP, "src/lib/format.ts": "export {}" });
    expect(result.findings).toEqual([]);
    expect(result.dropped).toEqual({ claim_refuted: 1 });
  });

  it("keeps a missing_path finding when the path is not there", async () => {
    const { result } = await check({ kind: "missing_path", subject: "src/lib/missing.ts" }, { "src/app.ts": APP });
    expect(result.findings).toHaveLength(1);
    expect(result).toMatchObject({ dropped: {}, checked: 1, inconclusive: 1 });
  });

  it("refutes missing_path from a file the change adds, without a read", async () => {
    const changeSet = makeChangeSet([
      { path: "src/app.ts", changeType: "modified", patch: APP_PATCH },
      { path: "src/new.ts", changeType: "added", patch: "@@ -0,0 +1 @@\n+export const x = 1;" },
    ]);
    const { result, calls } = await check({ kind: "missing_path", subject: "src/new.ts" }, {}, { changeSet });
    expect(result.dropped).toEqual({ claim_refuted: 1 });
    expect(calls.reads).toEqual([]);
  });

  it("never reads a path that escapes the repository", async () => {
    const { result, calls } = await check({ kind: "missing_path", subject: "../secrets.txt" }, { "../secrets.txt": "x" });
    expect(result.findings).toHaveLength(1);
    expect(calls.reads).toEqual([]);
  });

  it("refutes unused_symbol from a use the change adds, before any search", async () => {
    // Line 12 (added) of the default patch uses b.
    const { result, calls } = await check({ kind: "unused_symbol", subject: "b" }, {});
    // "b" is shorter than a searchable name, so it is left alone.
    expect(result.dropped).toEqual({});
    expect(calls.searches).toEqual([]);

    const patch = ["@@ -10,3 +10,5 @@", " const a = 1;", "+export const total = a + 1;", "+const c = total * 2;", " const d = 4;", " return d;"].join("\n");
    const changeSet = makeChangeSet([{ path: "src/app.ts", changeType: "modified", patch }]);
    const used = await check({ kind: "unused_symbol", subject: "total" }, {}, { changeSet });
    expect(used.result.dropped).toEqual({ claim_refuted: 1 });
    expect(used.calls.searches).toEqual([]);
  });

  it("refutes unused_symbol from a search hit confirmed at the head", async () => {
    const files = { "src/app.ts": APP.replace("export const b", "export const total"), "src/api.ts": 'import { total } from "./app";\nconsole.log(total);' };
    const { result, calls } = await check({ kind: "unused_symbol", subject: "total" }, files);
    expect(result.dropped).toEqual({ claim_refuted: 1 });
    expect(calls.searches).toEqual(["total"]);
  });

  it("keeps unused_symbol when the indexed hit is gone at the head", async () => {
    const files = { "src/app.ts": APP.replace("export const b", "export const total"), "src/api.ts": "console.log(1);" };
    const { result } = await check({ kind: "unused_symbol", subject: "total" }, files, { searchIndex: { total: ["src/api.ts"] } });
    expect(result.findings).toHaveLength(1);
  });

  it("does not count the finding's own lines, comments or another declaration as a use", async () => {
    const files = {
      "src/app.ts": APP.replace("export const b", "export const total"),
      "src/other.ts": "// total is computed in app.ts\nconst total = 3;",
    };
    const { result } = await check({ kind: "unused_symbol", subject: "total" }, files);
    expect(result.findings).toHaveLength(1);
  });

  it("skips search candidates the change deletes", async () => {
    const changeSet = makeChangeSet([
      { path: "src/app.ts", changeType: "modified", patch: APP_PATCH },
      { path: "src/old.ts", changeType: "deleted", patch: "@@ -1 +0,0 @@\n-use(total);" },
    ]);
    const files = { "src/app.ts": APP.replace("export const b", "export const total"), "src/old.ts": "use(total);" };
    const { result } = await check({ kind: "unused_symbol", subject: "total" }, files, { changeSet });
    expect(result.findings).toHaveLength(1);
  });

  it("keeps the finding once the search budget is spent", async () => {
    const files = { "src/app.ts": APP.replace("export const b", "export const total"), "src/api.ts": "use(total);" };
    const { result, calls } = await check({ kind: "unused_symbol", subject: "total" }, files, { maxSearches: 0 });
    expect(result.findings).toHaveLength(1);
    expect(calls.searches).toEqual([]);
  });

  it("refutes unreferenced_file from an import of it, with or without the extension", async () => {
    const files = { "src/app.ts": APP, "src/lib/format.ts": "export {}", "src/api.ts": 'import { fmt } from "./lib/format";' };
    const { result } = await check({ kind: "unreferenced_file", subject: "src/lib/format.ts" }, files);
    expect(result.dropped).toEqual({ claim_refuted: 1 });
  });

  it("keeps unreferenced_file when only the file itself mentions its name", async () => {
    const files = { "src/app.ts": APP, "src/lib/format.ts": 'export const name = "format";' };
    const { result } = await check({ kind: "unreferenced_file", subject: "src/lib/format.ts" }, files);
    expect(result.findings).toHaveLength(1);
  });

  it("leaves findings without a claim untouched", async () => {
    const { ctx, calls } = source({});
    const plain = { ...finding({ kind: "missing_path", subject: "x" }), claim: undefined };
    const result = await checkClaims({ findings: [plain], changeSet: makeChangeSet(), source: ctx });
    expect(result).toMatchObject({ findings: [plain], dropped: {}, checked: 0 });
    expect(calls.reads).toEqual([]);
  });
});

describe("claims in a review", () => {
  const config = (override: ConfigOverride = {}): Config =>
    resolveConfig({ trigger: { ...override, output: { walkthrough: false, ...override.output } } }).config;
  const unused = modelFinding({
    severity: "minor",
    title: "c is never used",
    claim: { kind: "unused_symbol", subject: "renderTotal" },
  });
  const head = { "src/app.ts": APP, "src/view.ts": "renderTotal(cart);" };

  it("drops a contradicted finding and counts it", async () => {
    const { ctx } = source(head);
    const { generate } = fakeModel({ code_review: { findings: [unused] } });
    const result = await runReview({ changeSet: makeChangeSet(), config: config() }, { generate, context: ctx });
    expect(result.findings).toEqual([]);
    expect(result.validation.dropped).toEqual({ claim_refuted: 1 });
  });

  it("checks nothing, and asks for no claims, when check_claims is off", async () => {
    // File context searches on its own, so only the claim's term is asserted on.
    const { ctx, calls } = source(head);
    const { generate, requests } = fakeModel({ code_review: { findings: [unused] } });
    const result = await runReview({ changeSet: makeChangeSet(), config: config({ review: { checkClaims: false } }) }, { generate, context: ctx });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.claim).toBeUndefined();
    expect(result.validation.dropped).toEqual({});
    expect(calls.searches).not.toContain("renderTotal");
    expect(JSON.stringify(requests[0])).not.toContain("- claim:");
  });

  it("repairs a reply with a malformed claim without losing the finding", () => {
    const { claim: _claim, ...rest } = modelFinding();
    const repaired = repairReviewOutput({
      findings: [rest, { ...rest, claim: { kind: "nonsense", subject: "x" } }, { ...rest, claim: { kind: "missing_path", subject: " a.ts " } }],
    }) as { findings: { claim: unknown }[] };
    expect(repaired.findings.map((entry) => entry.claim)).toEqual([null, null, { kind: "missing_path", subject: "a.ts" }]);
  });
});
