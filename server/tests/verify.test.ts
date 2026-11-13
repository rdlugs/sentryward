import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { Config, ConfigOverride } from "../src/review/config/schema.ts";
import { estimateTokens } from "../src/review/context/budget.ts";
import type { ContextSource } from "../src/review/context/gather.ts";
import { repairVerificationOutput, verificationOutputSchema } from "../src/review/llm/schemas.ts";
import type { ModelFinding } from "../src/review/llm/schemas.ts";
import { fingerprint } from "../src/review/core/fingerprint.ts";
import { runReview } from "../src/review/pipeline.ts";
import { toMarkdown } from "../src/review/render/markdown.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { fakeModel, modelFinding } from "./helpers/model.ts";

const now = () => new Date("2026-10-04T12:00:00Z");
// No walkthrough, so every model call is a review pass or a verification.
const config = (override: ConfigOverride = {}): Config =>
  resolveConfig({ trigger: { ...override, output: { walkthrough: false, ...override.output } } }).config;

const BLOCKER = modelFinding({ severity: "critical", title: "b overflows for large a" });

async function review(findings: ModelFinding[], verification: unknown, override: ConfigOverride = {}) {
  const model = fakeModel({ code_review: { findings }, verification });
  const result = await runReview({ changeSet: makeChangeSet(), config: config(override) }, { generate: model.generate, now });
  const verifications = model.requests.filter((request) => request.schemaName === "verification");
  return { result, verifications };
}

describe("verifying findings", () => {
  it("keeps a confirmed blocker blocking and records the call's usage", async () => {
    const { result, verifications } = await review([BLOCKER], { verdict: "confirmed", reason: "a comes from the CLI." });

    expect(verifications).toHaveLength(1);
    expect(result.findings).toMatchObject([{ severity: "critical", kind: "potential_issue" }]);
    expect(result.verdict.verdict).toBe("blocked");
    expect(result.validation).toEqual({ dropped: {}, demoted: 0, noopSuggestions: 0 });
    expect(result.usage.map((u) => u.purpose)).toEqual(["review", "verify"]);
    expect(result.warnings).toEqual([]);
  });

  it("drops a refuted blocker, counts it and names it in the stats line", async () => {
    const { result } = await review([BLOCKER], { verdict: "refuted", reason: "a is a constant 1." });

    expect(result.findings).toEqual([]);
    expect(result.validation.dropped).toEqual({ refuted: 1 });
    expect(result.verdict).toMatchObject({ verdict: "pass", blocking: [] });
    // A clean pass posts only the celebration, so the stats line (and the
    // refuted count in it) shows only when the full summary is rendered.
    expect(toMarkdown(result)).toContain("### 🎉 Congratulations");
    expect(toMarkdown(result)).not.toContain("refuted on verification");
    const full = { ...result, status: "partial" as const, verdict: { ...result.verdict, verdict: "error" as const } };
    expect(toMarkdown(full)).toContain("1 file reviewed · 1 finding refuted on verification</sub>");
  });

  it("demotes an uncertain blocker to a minor verification_needed with a new fingerprint", async () => {
    const confirmed = await review([BLOCKER], { verdict: "confirmed", reason: "" });
    const { result } = await review([BLOCKER], { verdict: "uncertain", reason: "Where a comes from is not shown." });

    expect(result.findings).toMatchObject([{ severity: "minor", kind: "verification_needed" }]);
    expect(result.findings[0]!.fingerprint).not.toBe(confirmed.result.findings[0]!.fingerprint);
    expect(result.validation.demoted).toBe(1);
    expect(result.verdict.verdict).toBe("pass");
  });

  it("suppresses an uncertain finding whose demoted fingerprint this team dismissed", async () => {
    // The dismissal was stored as a verification_needed finding, so it does not
    // match until verification demotes this one onto the same fingerprint.
    const demoted = fingerprint({ file: "src/app.ts", category: "bug", kind: "verification_needed", title: "b overflows for large a" });
    const model = fakeModel({ code_review: { findings: [BLOCKER] }, verification: { verdict: "uncertain", reason: "" } });
    const result = await runReview(
      { changeSet: makeChangeSet(), config: config({ review: { severityFloor: "info" } }), ignoredFingerprints: new Set([demoted]) },
      { generate: model.generate, now },
    );

    expect(result.findings).toEqual([]);
    expect(result.validation.dropped).toEqual({ previously_ignored: 1 });
  });

  it("drops an uncertain finding the demotion takes below the floor", async () => {
    const { result } = await review([BLOCKER], { verdict: "uncertain", reason: "" }, { review: { severityFloor: "major" } });

    expect(result.findings).toEqual([]);
    expect(result.validation).toEqual({ dropped: { below_floor: 1 }, demoted: 1, noopSuggestions: 0 });
  });

  it("counts a no-op suggestion only on a finding that is published", async () => {
    const noop = { ...BLOCKER, suggestion: "const b = a + 1;" };
    const confirmed = { verdict: "confirmed", reason: "" };

    expect((await review([noop], confirmed)).result.validation.noopSuggestions).toBe(1);
    // Two reports of one problem publish one finding.
    expect((await review([noop, noop], confirmed)).result.validation.noopSuggestions).toBe(1);
    expect((await review([noop], { verdict: "refuted", reason: "" })).result.validation.noopSuggestions).toBe(0);
    // Demotion changes the fingerprint, not what the suggestion was on.
    expect((await review([noop], { verdict: "uncertain", reason: "" })).result.validation.noopSuggestions).toBe(1);

    const dismissed = fingerprint({ file: "src/app.ts", category: "bug", kind: "potential_issue", title: "b overflows for large a" });
    const model = fakeModel({ code_review: { findings: [noop] }, verification: confirmed });
    const ignored = await runReview(
      { changeSet: makeChangeSet(), config: config(), ignoredFingerprints: new Set([dismissed]) },
      { generate: model.generate, now },
    );
    expect(ignored.findings).toEqual([]);
    expect(ignored.validation.noopSuggestions).toBe(0);
  });

  it("never lets an uncertain finding block, even when blockOn reaches its demoted severity", async () => {
    for (const blockOn of ["minor", "info"] as const) {
      const { result } = await review([BLOCKER], { verdict: "uncertain", reason: "" }, { review: { blockOn, severityFloor: "info" } });
      expect(result.findings).toMatchObject([{ severity: "minor", kind: "verification_needed" }]);
      expect(result.verdict).toMatchObject({ verdict: "pass", blocking: [] });
    }
  });

  it("never raises a finding's severity when demoting it", async () => {
    const info = modelFinding({ severity: "info", title: "b may be worth a name" });
    const { result } = await review([info], { verdict: "uncertain", reason: "" }, { review: { verify: "all", blockOn: "minor", severityFloor: "info" } });

    expect(result.findings).toMatchObject([{ severity: "info", kind: "verification_needed" }]);
    expect(result.verdict.verdict).toBe("pass");
  });

  it("keeps the finding and warns when the verification call fails", async () => {
    const { result } = await review([BLOCKER], new Error("rate limited"));

    expect(result.status).toBe("completed");
    expect(result.findings).toMatchObject([{ severity: "critical" }]);
    expect(result.verdict.verdict).toBe("blocked");
    expect(result.warnings).toEqual(["Verification failed for 1 finding, kept as reported: rate limited"]);
    expect(result.usage.map((u) => u.purpose)).toEqual(["review"]);
  });

  it("records what verification made of each finding", async () => {
    const minor = modelFinding({ severity: "minor", startLine: 12, endLine: 12, title: "c is never negative" });
    const outcome = async (verification: unknown) =>
      (await review([BLOCKER, minor], verification, { review: { severityFloor: "info" } })).result.findings.map((f) => [f.title, f.verification]);

    // The minor finding is not a candidate by default, so nobody checked it.
    expect(await outcome({ verdict: "confirmed", reason: "" })).toEqual([
      ["b overflows for large a", "verified"],
      ["c is never negative", "not_checked"],
    ]);
    expect(await outcome({ verdict: "uncertain", reason: "" })).toContainEqual(["b overflows for large a", "uncertain"]);
    expect(await outcome(new Error("rate limited"))).toContainEqual(["b overflows for large a", "not_checked"]);
    const off = await review([BLOCKER], { verdict: "confirmed", reason: "" }, { review: { verify: "off" } });
    expect(off.result.findings[0]!.verification).toBe("not_checked");
  });

  it("marks a finding the validator already demoted uncertain when verification cannot decide either", async () => {
    const unproven = modelFinding({ severity: "critical", evidence: "unverified", title: "b overflows for large a" });
    const { result } = await review([unproven], { verdict: "uncertain", reason: "" }, { review: { verify: "all", severityFloor: "info" } });

    expect(result.findings).toMatchObject([{ kind: "verification_needed", verification: "uncertain" }]);
    expect(result.validation.demoted).toBe(1);
  });

  it("shows the verifier the claimed impact", async () => {
    const model = fakeModel({
      code_review: { findings: [modelFinding({ severity: "critical", impact: "The CLI prints a wrong total." })] },
      verification: { verdict: "confirmed", reason: "" },
    });
    await runReview({ changeSet: makeChangeSet(), config: config() }, { generate: model.generate, now });

    const prompt = model.requests.find((request) => request.schemaName === "verification")!.prompt;
    expect(prompt).toContain("Claimed impact: The CLI prints a wrong total.");
  });

  it("verifies only blocking findings by default, every finding with all, none with off", async () => {
    const findings = [BLOCKER, modelFinding({ severity: "minor", startLine: 12, endLine: 12, title: "c is never negative" })];
    const answer = { verdict: "confirmed", reason: "" };

    expect((await review(findings, answer)).verifications).toHaveLength(1);
    expect((await review(findings, answer, { review: { verify: "all" } })).verifications).toHaveLength(2);
    expect((await review(findings, answer, { review: { verify: "off" } })).verifications).toHaveLength(0);
  });

  it("shows the verifier the finding, its file's diff and the pass's context", async () => {
    const head = ['import { helper } from "./helper.ts";', "", "export function main(input: string) {", "  const a = helper(input);", "  const b = a + 1;", "  return b;", "}", ""];
    const patch = ["@@ -4,2 +4,2 @@ export function main(input: string) {", "   const a = helper(input);", "-  const b = a;", "+  const b = a + 1;", "   return b;"];
    const model = fakeModel({ code_review: { findings: [modelFinding({ severity: "critical", startLine: 5, endLine: 5 })] }, verification: { verdict: "confirmed", reason: "" } });
    const context: ContextSource = { readFile: async () => head.join("\n"), searchCode: async () => [] };
    await runReview(
      { changeSet: makeChangeSet([{ path: "src/app.ts", changeType: "modified", patch: patch.join("\n") }]), config: config() },
      { generate: model.generate, now, context },
    );

    const prompt = model.requests.find((request) => request.schemaName === "verification")!.prompt;
    expect(prompt).toContain("Title: b overflows for large a");
    expect(prompt).toContain("Evidence (execution_path): main() is called with Number.MAX_SAFE_INTEGER");
    expect(prompt).toContain("+ |   const b = a + 1;");
    expect(prompt).toContain("Context (read-only");
    expect(prompt).toContain('import { helper } from "./helper.ts";');
  });

  it("shows the verifier the other files of the pass that reported the finding", async () => {
    const changeSet = makeChangeSet([
      { path: "src/app.ts", changeType: "modified", patch: "@@ -1,1 +1,2 @@\n a\n+const b = helper(a);" },
      { path: "src/helper.ts", changeType: "modified", patch: "@@ -1,1 +1,2 @@\n x\n+export const helper = (v) => v.trim();" },
    ]);
    const model = fakeModel({
      code_review: { findings: [modelFinding({ severity: "critical", startLine: 2, endLine: 2 })] },
      verification: { verdict: "confirmed", reason: "" },
    });
    await runReview({ changeSet, config: config() }, { generate: model.generate, now });

    const prompt = model.requests.find((request) => request.schemaName === "verification")!.prompt;
    expect(prompt).toContain("FILE: src/app.ts");
    expect(prompt).toContain("export const helper = (v) => v.trim();");
  });

  it("fills the verifier's budget with the finding's file, then its evidence files, then the rest of its pass", async () => {
    // app.ts and filler.ts fill the 2,000-token minimum pass, so helper.ts is
    // reviewed in a second pass; the verifier has the same budget.
    const changeSet = makeChangeSet([
      { path: "src/app.ts", changeType: "modified", patch: "@@ -1,1 +1,2 @@\n a\n+const b = helper(a);" },
      { path: "src/filler.ts", changeType: "modified", patch: `@@ -1,1 +1,2 @@\n a\n+${"x".repeat(7750)}` },
      { path: "src/helper.ts", changeType: "modified", patch: "@@ -1,1 +1,2 @@\n x\n+export const helper = (v) => v.trim();" },
    ]);
    const finding = modelFinding({ severity: "critical", startLine: 2, endLine: 2, evidenceFiles: ["src/helper.ts"] });
    const model = fakeModel({
      code_review: (request: { prompt: string }) => ({ findings: request.prompt.includes("FILE: src/app.ts") ? [finding] : [] }),
      verification: { verdict: "confirmed", reason: "" },
    });
    const result = await runReview({ changeSet, config: config({ llm: { contextBudget: 4000 } }) }, { generate: model.generate, now });

    expect(result.coverage.passes).toBe(2);
    const prompt = model.requests.find((request) => request.schemaName === "verification")!.prompt;
    expect(prompt).toContain("FILE: src/app.ts");
    expect(prompt).toContain("FILE: src/helper.ts");
    expect(prompt).not.toContain("FILE: src/filler.ts");
  });

  it("keeps a file split over many passes within budget and always shows the flagged line", async () => {
    // Eight hunks of about 1,200 tokens, 100 lines apart: one pass each at this budget.
    const patch = Array.from({ length: 8 }, (_, i) => `@@ -${1 + i * 100},1 +${1 + i * 100},2 @@\n a\n+${"y".repeat(4800)}`);
    const changeSet = makeChangeSet([{ path: "src/big.ts", changeType: "modified", patch: patch.join("\n") }]);
    for (const line of [2, 702]) {
      const model = fakeModel({
        code_review: (request: { prompt: string }) => ({
          findings: request.prompt.includes(`${line} + |`)
            ? [modelFinding({ file: "src/big.ts", severity: "critical", startLine: line, endLine: line })]
            : [],
        }),
        verification: { verdict: "confirmed", reason: "" },
      });
      const result = await runReview({ changeSet, config: config({ llm: { contextBudget: 8000 } }) }, { generate: model.generate, now });

      expect(result.coverage.passes).toBe(8);
      const request = model.requests.find((r) => r.schemaName === "verification")!;
      expect(estimateTokens(request.system) + estimateTokens(request.prompt)).toBeLessThanOrEqual(8000);
      expect(request.prompt).toContain(`${line} + |`);
    }
  });

  it("repairs a loosely written verdict but never guesses one", () => {
    expect(verificationOutputSchema.parse(repairVerificationOutput({ verdict: " Refuted ", reason: "x" }))).toEqual({
      verdict: "refuted",
      reason: "x",
    });
    expect(verificationOutputSchema.safeParse(repairVerificationOutput({ verdict: "probably", reason: "x" })).success).toBe(false);
  });
});
