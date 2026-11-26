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
            requirements: [{ requirement: "Export CSV", status: "Done-ish", path: "src/app.ts", line: "11" }, { status: "met" }],
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
        requirements: [{ text: "Export CSV", status: "unclear", file: "src/app.ts", line: 11, fix: "" }],
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

  it("turns each missing requirement into a major gap, partial ones not", () => {
    const gaps = requirementGapFindings(walkthrough, change);
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
    expect(requirementGapFindings(walkthrough, change).map((gap) => gap.fingerprint)).toEqual(gaps.map((gap) => gap.fingerprint));
  });

  it("skips a gap the team dismissed", () => {
    const [dismissed] = requirementGapFindings(walkthrough, change);
    const gaps = requirementGapFindings(walkthrough, change, new Set([dismissed!.fingerprint]));
    expect(gaps.map((gap) => gap.title)).toEqual(["#1: Guards c"]);
  });

  it("has nothing to say without linked issues or requirements", () => {
    expect(requirementGapFindings(undefined, change)).toEqual([]);
    expect(requirementGapFindings({ ...walkthrough, linkedIssues: [{ ...walkthrough.linkedIssues![0]!, requirements: undefined }] }, change)).toEqual(
      [],
    );
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
  const gap = (fingerprint: string, file = ""): KnownFinding => ({
    fingerprint,
    state: "open",
    file,
    title: `#1: ${fingerprint}`,
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
});
