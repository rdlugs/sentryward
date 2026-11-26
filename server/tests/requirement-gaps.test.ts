import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { ConfigOverride } from "../src/review/config/schema.ts";
import { requirementGapFindings } from "../src/review/core/requirementGaps.ts";
import { walkthroughSchema, type IssueContext, type Walkthrough } from "../src/review/core/models.ts";
import { parseLenient } from "../src/review/llm/format.ts";
import { repairWalkthroughOutput, walkthroughSchemaFor } from "../src/review/llm/schemas.ts";
import { generateWalkthrough } from "../src/review/llm/walkthrough.ts";
import { runReview } from "../src/review/pipeline.ts";
import { toMarkdown } from "../src/review/render/markdown.ts";
import { findingTransitions, type KnownFinding } from "../src/worker/syncFindings.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { WALKTHROUGH, fakeModel } from "./helpers/model.ts";
import { EVERY_OUTPUT } from "./helpers/output.ts";

// Every part of the output on, as these tests check each one (helpers/output.ts).
const config = (override: ConfigOverride = {}) =>
  resolveConfig({ global: { output: EVERY_OUTPUT }, trigger: { ...override, review: { verify: "off", ...override.review } } }).config;

const issue = (ref: string, title = `Issue ${ref}`): IssueContext => ({ ref, title, state: "open", body: "- [ ] a\n- [ ] b" });

const requirement = (text: string, status: string, file = "", line = 0, fix = "") => ({ text, status, file, line, fix });

// src/app.ts (helpers/changeSet.ts) shows lines 10-14, of which 11 and 12 are added.
const walkthroughWith = (requirements: unknown[], ref = "#1") => ({
  ...WALKTHROUGH,
  linkedIssues: [{ ref, assessment: "partial", note: "Half done.", requirements }],
});

describe("repairWalkthroughOutput requirements", () => {
  it("normalises requirement entries and drops the unreadable ones", () => {
    const schema = walkthroughSchemaFor({ sequenceDiagram: false, highLevelSummary: false, linkedIssues: true, relatedIssues: false });
    const output = parseLenient(
      JSON.stringify({
        overview: "o",
        linked_issues: [
          {
            ref: "#1",
            assessment: "partial",
            note: "n",
            requirements: [
              { requirement: "Export CSV", status: "Done-ish", path: "src/app.ts", line: "11" },
              { status: "met" },
              { text: "Log it", status: "Not met" },
              { text: "Count it", status: "completed" },
              { text: "Page it", status: "partly-met" },
            ],
          },
          { ref: "#2", assessment: "addressed", note: "n" },
        ],
      }),
      schema,
      repairWalkthroughOutput,
    );
    expect(output.linkedIssues).toEqual([
      {
        ref: "#1",
        assessment: "partial",
        note: "n",
        requirements: [
          { text: "Export CSV", status: "unclear", file: "src/app.ts", line: 11, fix: "" },
          // Common wordings repair to the status they mean, so a gap is not lost to unclear.
          { text: "Log it", status: "missing", file: "", line: 0, fix: "" },
          { text: "Count it", status: "met", file: "", line: 0, fix: "" },
          { text: "Page it", status: "partial", file: "", line: 0, fix: "" },
        ],
      },
      { ref: "#2", assessment: "addressed", note: "n", requirements: [] },
    ]);
  });

  it("still reads a stored walkthrough from before requirements existed", () => {
    const stored = { ...WALKTHROUGH, linkedIssues: [{ ref: "#1", title: "t", state: "open", assessment: "addressed", note: "ok" }] };
    expect(walkthroughSchema.parse(stored).linkedIssues![0]).not.toHaveProperty("requirements");
  });
});

describe("generateWalkthrough requirements", () => {
  const change = makeChangeSet();

  it("keeps only locations the change has, and fixes only where something is left to do", async () => {
    const model = fakeModel({
      walkthrough: walkthroughWith([
        requirement("Adds b", "met", "src/app.ts", 11, "nothing to do"),
        requirement("Doubles b", "partial", "src/app.ts", 50, "Handle zero."),
        requirement("Logs it", "missing", "src/invented.ts", 3, " Add a log line. "),
        requirement("   ", "missing"),
        ...Array.from({ length: 10 }, (_, index) => requirement(`Extra ${index}`, "unclear")),
      ]),
    });
    const { walkthrough } = await generateWalkthrough(model.generate, change, change.files, config(), { linked: [issue("#1")] });

    const requirements = walkthrough.linkedIssues![0]!.requirements!;
    expect(requirements.slice(0, 3)).toEqual([
      { text: "Adds b", status: "met", file: "src/app.ts", line: 11 },
      // Line 50 is not in the diff: the file stays, the line goes.
      { text: "Doubles b", status: "partial", file: "src/app.ts", fix: "Handle zero." },
      // Not a changed file: neither is kept.
      { text: "Logs it", status: "missing", fix: "Add a log line." },
    ]);
    // The empty one is dropped and the rest capped.
    expect(requirements).toHaveLength(8);
    expect(model.requests[0]!.prompt).toContain("In requirements, split the issue");
  });

  it("leaves requirements out when the model gave none", async () => {
    const model = fakeModel({ walkthrough: walkthroughWith([]) });
    const { walkthrough } = await generateWalkthrough(model.generate, change, change.files, config(), { linked: [issue("#1")] });
    expect(walkthrough.linkedIssues![0]).not.toHaveProperty("requirements");
    // Linked, but not split into requirements, so not assessed.
    expect(walkthrough.requirementChecks).toEqual({ linked: ["#1"], assessed: [] });
  });

  it("does not place a requirement in a file the review ignores", async () => {
    const model = fakeModel({ walkthrough: walkthroughWith([requirement("Logs it", "missing", "src/app.ts", 11)]) });
    // src/app.ts is changed but not among the files the review covers.
    const { walkthrough } = await generateWalkthrough(model.generate, change, [], config(), { linked: [issue("#1")] });
    expect(walkthrough.linkedIssues![0]!.requirements).toEqual([{ text: "Logs it", status: "missing" }]);
  });

  it("records which linked issues it assessed, even when none are linked", async () => {
    const model = fakeModel({ walkthrough: walkthroughWith([requirement("Logs it", "missing")]) });
    const linked = await generateWalkthrough(model.generate, change, change.files, config(), { linked: [issue("#1"), issue("#2")] });
    // #2 was left out by the model: linked, not assessed.
    expect(linked.walkthrough.requirementChecks).toEqual({ linked: ["#1", "#2"], assessed: ["#1"] });

    const none = await generateWalkthrough(model.generate, change, change.files, config(), { linked: [] });
    expect(none.walkthrough.requirementChecks).toEqual({ linked: [], assessed: [] });

    // An unreadable tracker or the setting off made no check at all.
    const unread = await generateWalkthrough(model.generate, change, change.files, config(), {});
    expect(unread.walkthrough).not.toHaveProperty("requirementChecks");
    const off = await generateWalkthrough(model.generate, change, change.files, config({ output: { assessLinkedIssues: false } }), {
      linked: [issue("#1")],
    });
    expect(off.walkthrough).not.toHaveProperty("requirementChecks");
  });

  it("asks the model to keep the wording of earlier gaps", async () => {
    const model = fakeModel({ walkthrough: walkthroughWith([]) });
    await generateWalkthrough(model.generate, change, change.files, config(), { linked: [issue("#1")], knownGaps: ["#1: Logs each export"] });
    expect(model.requests[0]!.prompt).toContain("use its text exactly");
    expect(model.requests[0]!.prompt).toContain("#1: Logs each export");

    const fresh = fakeModel({ walkthrough: walkthroughWith([]) });
    await generateWalkthrough(fresh.generate, change, change.files, config(), { linked: [issue("#1")] });
    expect(fresh.requests[0]!.prompt).not.toContain("use its text exactly");
  });
});

describe("requirementGapFindings", () => {
  const change = makeChangeSet();
  const walkthrough: Walkthrough = {
    ...WALKTHROUGH,
    blastRadius: "small",
    linkedIssues: [
      {
        ref: "#1",
        title: "Export",
        state: "open",
        assessment: "partial",
        note: "n",
        requirements: [
          { text: "Adds b", status: "met", file: "src/app.ts", line: 11 },
          { text: "Doubles b", status: "partial", file: "src/app.ts", fix: "Handle zero." },
          { text: "Logs it", status: "missing", fix: "Add a log line." },
          { text: "Guards c", status: "missing", file: "src/app.ts", line: 12, fix: "Check c." },
        ],
      },
    ],
  };

  const gapsOf = (w: Walkthrough | undefined, ignored?: Set<string>, override: ConfigOverride = {}) =>
    requirementGapFindings(w, change, config(override), ignored).findings;

  it("turns each missing requirement into a major gap, partial ones not", () => {
    const gaps = gapsOf(walkthrough);
    expect(gaps.map((gap) => [gap.title, gap.file, gap.startLine])).toEqual([
      ["#1: Logs it", "", 1],
      ["#1: Guards c", "src/app.ts", 12],
    ]);
    expect(gaps[0]).toMatchObject({
      kind: "requirement_gap",
      bucket: "requirement_gap",
      severity: "major",
      evidenceNote: "Linked issue #1",
      body: "#1 (Export) asks for this, and the change does not do it. Add a log line.",
    });
    // Stable across runs, so the backlog keeps one row per gap.
    expect(gapsOf(walkthrough).map((gap) => gap.fingerprint)).toEqual(gaps.map((gap) => gap.fingerprint));
  });

  it("keeps a gap's identity when the model places it in another file or none", () => {
    const moved = (file?: string): Walkthrough => ({
      ...walkthrough,
      linkedIssues: [{ ...walkthrough.linkedIssues![0]!, requirements: [{ text: "Logs it", status: "missing", ...(file ? { file } : {}) }] }],
    });
    const [none] = gapsOf(moved());
    const [placed] = gapsOf(moved("src/app.ts"));
    expect(placed!.file).toBe("src/app.ts");
    expect(placed!.fingerprint).toBe(none!.fingerprint);
    // So a dismissal made while it had no file still holds once it has one.
    expect(gapsOf(moved("src/app.ts"), new Set([none!.fingerprint]))).toEqual([]);
  });

  it("holds gaps to the workspace's floor and minimum confidence, not its categories", () => {
    const floor = requirementGapFindings(walkthrough, change, config({ review: { severityFloor: "critical" } }));
    expect(floor).toEqual({ findings: [], dropped: { below_floor: 2 } });
    const confidence = requirementGapFindings(walkthrough, change, config({ review: { minConfidence: 0.6 } }));
    expect(confidence).toEqual({ findings: [], dropped: { low_confidence: 2 } });
    expect(gapsOf(walkthrough, undefined, { review: { categories: ["security"] } })).toHaveLength(2);
  });

  it("skips a gap the team dismissed", () => {
    const [dismissed] = gapsOf(walkthrough);
    const gaps = gapsOf(walkthrough, new Set([dismissed!.fingerprint]));
    expect(gaps.map((gap) => gap.title)).toEqual(["#1: Guards c"]);
  });

  it("has nothing to say without linked issues or requirements", () => {
    expect(gapsOf(undefined)).toEqual([]);
    expect(gapsOf({ ...walkthrough, linkedIssues: [{ ...walkthrough.linkedIssues![0]!, requirements: undefined }] })).toEqual([]);
  });
});

describe("runReview with requirement gaps", () => {
  const change = makeChangeSet();
  const model = () =>
    fakeModel({
      code_review: { findings: [] },
      walkthrough: walkthroughWith([requirement("Adds b", "met", "src/app.ts", 11), requirement("Logs it", "missing", "", 0, "Add a log line.")]),
    });

  it("reports the gap, follows blockOn and renders the requirement table", async () => {
    const run = (blockOn: "major" | "critical") =>
      runReview(
        { changeSet: change, config: config({ review: { blockOn } }), issues: { linked: [issue("#1")] } },
        { generate: model().generate, now: () => new Date("2026-10-04T12:00:00Z") },
      );
    const lenient = await run("critical");
    expect(lenient.findings.map((finding) => [finding.kind, finding.bucket])).toEqual([["requirement_gap", "requirement_gap"]]);
    expect(lenient.verdict).toMatchObject({ verdict: "pass", blocking: [] });

    const strict = await run("major");
    expect(strict.verdict).toMatchObject({ verdict: "blocked", blocking: [strict.findings[0]!.fingerprint] });

    const markdown = toMarkdown(lenient);
    expect(markdown).toContain("**#1: 1 of 2 met**");
    expect(markdown).toContain("| Adds b | ✅ Met | `src/app.ts:11` |  |");
    expect(markdown).toContain("Requirements not met (1)");
    // No file to name, so the title (which names the issue) stands alone.
    expect(markdown).toContain("#### #1: Logs it");
    expect(markdown).not.toContain("`:1`");
  });

  it("reports no gaps when linked issues are not assessed", async () => {
    const result = await runReview(
      { changeSet: change, config: config({ output: { assessLinkedIssues: false } }), issues: { linked: [issue("#1")] } },
      { generate: model().generate, now: () => new Date("2026-10-04T12:00:00Z") },
    );
    expect(result.findings).toEqual([]);
  });
});

describe("findingTransitions for requirement gaps", () => {
  const gap = (fingerprint: string, file = "", ref = "#1"): KnownFinding => ({
    fingerprint,
    state: "open",
    file,
    title: `${ref}: ${fingerprint}`,
    startLine: 1,
    severity: "major",
    category: "logic",
    kind: "requirement_gap",
  });

  it("resolves a gap only when the run assessed linked issues", async () => {
    const change = makeChangeSet();
    const result = await runReview(
      { changeSet: change, config: config(), issues: { linked: [issue("#1")] } },
      {
        generate: fakeModel({ code_review: { findings: [] }, walkthrough: walkthroughWith([requirement("Logs it", "met")]) }).generate,
        now: () => new Date("2026-10-04T12:00:00Z"),
      },
    );
    const existing = [gap("aaaaaaaaaaaaaaaa"), gap("bbbbbbbbbbbbbbbb", "src/app.ts")];
    expect(findingTransitions(existing, result).resolved).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);

    // A failed walkthrough (or an unreadable tracker) says nothing about them.
    const { walkthrough: _walkthrough, ...unassessed } = result;
    expect(findingTransitions(existing, unassessed).resolved).toEqual([]);
  });

  const checked = async (linked: string[], assessed: string[], dropped: Record<string, number> = {}) => {
    const result = await runReview(
      { changeSet: makeChangeSet(), config: config(), issues: { linked: [issue("#1")] } },
      {
        generate: fakeModel({ code_review: { findings: [] }, walkthrough: walkthroughWith([requirement("Logs it", "met")]) }).generate,
        now: () => new Date("2026-10-04T12:00:00Z"),
      },
    );
    return {
      ...result,
      walkthrough: { ...result.walkthrough!, requirementChecks: { linked, assessed } },
      validation: { ...result.validation, dropped: { ...result.validation.dropped, ...dropped } },
    };
  };

  it("resolves a gap only for an issue this run checked again or no longer links", async () => {
    const existing = [gap("aaaaaaaaaaaaaaaa", "", "#1"), gap("bbbbbbbbbbbbbbbb", "", "#2"), gap("cccccccccccccccc", "", "#3")];
    // #1 assessed again, #2 linked but left out by the model, #3 no longer linked.
    expect(findingTransitions(existing, await checked(["#1", "#2"], ["#1"])).resolved).toEqual([
      "aaaaaaaaaaaaaaaa",
      "cccccccccccccccc",
    ]);
  });

  it("resolves no gap when max_findings may have cut it", async () => {
    const existing = [gap("aaaaaaaaaaaaaaaa")];
    expect(findingTransitions(existing, await checked(["#1"], ["#1"], { over_limit: 1 })).resolved).toEqual([]);
  });
});
