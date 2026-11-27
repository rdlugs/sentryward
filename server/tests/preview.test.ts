import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import { DEFAULT_CONFIG, type ConfigOverride } from "../src/review/config/schema.ts";
import { runReview } from "../src/review/pipeline.ts";
import { previewPublication } from "../src/review/preview/preview.ts";
import { SAMPLE_NOW, sampleChange, sampleGenerate, sampleIssues } from "../src/review/preview/sample.ts";
import { toMarkdown } from "../src/review/render/markdown.ts";
import { createUser } from "./helpers/users.ts";
import { EVERY_OUTPUT } from "./helpers/output.ts";

// Every part of the output on, as these tests check each one (helpers/output.ts).
const config = (override: ConfigOverride = {}) => resolveConfig({ global: { output: EVERY_OUTPUT }, trigger: override }).config;

describe("previewPublication", () => {
  it("posts exactly what the publisher would for the sample review", async () => {
    const preview = await previewPublication(config(), "github");
    const result = await runReview(
      { changeSet: sampleChange("github"), config: config(), issues: sampleIssues("github") },
      { generate: sampleGenerate, now: () => SAMPLE_NOW },
    );

    expect(preview.summaryComment).toBe(toMarkdown(result, { walkthrough: true }));
    // The SQL injection is critical, the default block level.
    expect(preview.status).toEqual({ state: "failure", description: "1 finding at or above critical" });
    // The unproven rate-limit finding is demoted, not dropped, so it still gets a thread.
    expect(preview.inline.map((c) => c.startLine)).toEqual([9, 10, 7]);
    expect(preview.inline[0]!.diff.at(-1)).toMatchObject({ type: "add", newLine: 9 });
  });

  it("opens the review comment with the summary and leaves the description alone", async () => {
    const preview = await previewPublication(config(), "github");
    expect(preview.walkthroughComment).toBeNull();
    expect(preview.summaryComment).toMatch(/^## Summary\n/);
    expect(preview.summaryComment).toContain("Blast radius: medium");
    expect(preview.summaryComment).not.toContain("### Code review");

    // With the review comment off, the summary still gets a comment of its own.
    const alone = await previewPublication(config({ output: { postSummary: false } }), "github");
    expect(alone.summaryComment).toBeNull();
    expect(alone.walkthroughComment).toContain("## Summary");

    const none = await previewPublication(config({ output: { walkthrough: false, effortLabel: true } }), "github");
    expect(none.walkthroughComment).toBeNull();
    expect(none.summaryComment).not.toContain("Blast radius");
    expect(none.pr.labels).toEqual([]);
  });

  it("follows each output switch and the finding settings", async () => {
    const off = await previewPublication(
      config({ output: { postInline: false, postSummary: false, postCheck: false } }),
      "github",
    );
    expect(off).toMatchObject({ summaryComment: null, status: null, inline: [] });

    const labelled = await previewPublication(config({ output: { blastRadiusLabel: true, effortLabel: true } }), "gitlab");
    expect(labelled.pr.labels).toEqual(["Medium blast radius", "5-10 Minutes"]);

    const strict = await previewPublication(config({ review: { blockOn: "major", severityFloor: "major" } }), "github");
    // The sample's missing requirement of #12 is a major gap, so it counts too.
    expect(strict.status?.description).toBe("3 findings at or above major");
    expect(strict.summaryComment).not.toContain("rate limit");
  });

  it("says what would happen to the approval only while approval is on", async () => {
    expect((await previewPublication(config(), "github")).approval).toBeNull();
    const approving = await previewPublication(config({ output: { approval: { enabled: true, requestChanges: true } } }), "github");
    // The sample's SQL injection blocks the verdict.
    expect(approving.approval).toEqual({ action: "request_changes", reasons: ["1 finding at or above critical"] });
  });

  it("shows each optional walkthrough part only while its setting is on", async () => {
    const all = await previewPublication(config(), "github");
    expect(all.summaryComment).toContain("```mermaid\nsequenceDiagram");
    expect(all.summaryComment).toContain("⏱️ Review effort: 2/5");
    expect(all.summaryComment).toContain("[#12](https://github.com/acme/users/issues/12)");
    expect(all.summaryComment).toContain("🟡 Partly addressed");
    // Each requirement of the issue, and the missing one as a finding.
    expect(all.summaryComment).toContain("**#12: 2 of 3 met**");
    expect(all.summaryComment).toContain(
      "| Return 404 for an unknown id | ❌ Missing | `src/api/users.ts:10` | Check that a row came back and respond with 404 when none did. |",
    );
    expect(all.summaryComment).toContain("| Document the endpoint in the README | ✅ Met | `README.md` |  |");
    expect(all.summaryComment).toContain("Requirements not met (1)");
    expect(all.summaryComment).toContain("#### `src/api/users.ts:10`: #12: Return 404 for an unknown id");
    expect(all.summaryComment).toContain("[#31](https://github.com/acme/users/issues/31)");
    // The candidate the model did not pick is left out.
    expect(all.summaryComment).not.toContain("#7");
    // The summary goes in the description by default, not the comment.
    expect(all.summaryComment).not.toContain("High-level summary");
    expect(all.pr.description).toContain("<!-- sentryward:summary:start -->\n## High-level summary");
    expect(all.pr.description).toMatch(/^Closes #12\n\n/);

    const none = await previewPublication(
      config({
        output: {
          sequenceDiagrams: false,
          estimateEffort: false,
          assessLinkedIssues: false,
          relatedIssues: false,
          highLevelSummary: false,
        },
      }),
      "github",
    );
    expect(none.summaryComment).not.toMatch(/mermaid|Review effort|#12|#31|Requirements not met/);
    // Not parts the model is asked for, so still shown.
    expect(none.summaryComment).toContain("🏷️ Labels: `api`, `feature` · 💥 Blast radius: medium");

    const noMeta = await previewPublication(
      config({ output: { estimateEffort: false, walkthroughLabels: false, walkthroughBlastRadius: false } }),
      "github",
    );
    expect(noMeta.summaryComment).not.toMatch(/Labels:|Review effort|Blast radius:/);
    expect(none.pr.description).toBe("Closes #12");

    const inWalkthrough = await previewPublication(config({ output: { highLevelSummaryPlacement: "walkthrough" } }), "github");
    // It takes the overview's place at the top of the comment.
    expect(inWalkthrough.summaryComment).toMatch(/^## High-level summary\n\n\*\*New Features\*\*/);
    expect(inWalkthrough.summaryComment).not.toContain("Adds a `GET /users/:id` endpoint");
    expect(inWalkthrough.summaryComment).toContain("💥 Blast radius: medium");
    expect(all.summaryComment).toMatch(/^## Summary\n\nAdds a `GET \/users\/:id` endpoint/);
    expect(inWalkthrough.pr.description).toBe("Closes #12");
  });

  it("uses each forge's suggestion syntax", async () => {
    const [github] = (await previewPublication(config(), "github")).inline;
    const [gitlab] = (await previewPublication(config(), "gitlab")).inline;
    expect(github!.body).toContain("```suggestion\n");
    expect(gitlab!.body).toContain("```suggestion:-0+0\n");
  });
});

describe("POST /api/config/preview", () => {
  let cookie: string;

  beforeEach(async () => {
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    ({ cookie } = await createUser());
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("requires a session", async () => {
    const res = await request(app).post("/api/config/preview").send({ provider: "github", base: {}, settings: {} });
    expect(res.status).toBe(401);
  });

  it("layers the form's settings over what it inherits", async () => {
    const res = await request(app)
      .post("/api/config/preview")
      .set("Cookie", cookie)
      .send({ provider: "gitlab", base: { output: { postCheck: false } }, settings: { output: { postInline: false } } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: "gitlab", status: null, inline: [], pr: { number: 42 } });
    expect(res.body.summaryComment).toMatch(/^## Summary\n/);
  });

  it("accepts a resolved config as the base, rules included", async () => {
    // The forms send the defaults or the global config's effective config.
    const rule = { id: "no-b", description: "No b.", severity: "major" };
    const res = await request(app)
      .post("/api/config/preview")
      .set("Cookie", cookie)
      .send({ provider: "github", base: { ...DEFAULT_CONFIG, rules: [rule] }, settings: { rules: [{ ...rule, id: "no-c" }] } });
    expect(res.status).toBe(200);
    expect(res.body.summaryComment).toMatch(/^## Summary\n/);

    const refused = await request(app)
      .post("/api/config/preview")
      .set("Cookie", cookie)
      .send({ provider: "github", base: {}, settings: { rules: [{ ...rule, pattern: "(?=b)" }] } });
    expect(refused.status).toBe(400);
  });

  it("rejects settings the config would reject", async () => {
    const res = await request(app)
      .post("/api/config/preview")
      .set("Cookie", cookie)
      .send({ provider: "github", base: {}, settings: { review: { maxFindings: 0 } } });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/config/rules/check", () => {
  let cookie: string;

  beforeEach(async () => {
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    ({ cookie } = await createUser());
  });

  it("requires a session", async () => {
    const res = await request(app).post("/api/config/rules/check").send({ patterns: [] });
    expect(res.status).toBe(401);
  });

  it("answers each pattern in order with what RE2 accepts", async () => {
    const res = await request(app)
      .post("/api/config/rules/check")
      .set("Cookie", cookie)
      .send({ patterns: ["\\bconsole\\.log\\(", "(?<=a)b", "(a)\\1", "[", ""] });
    expect(res.status).toBe(200);
    const invalid = "Not a valid regular expression (backreferences and lookarounds are not supported)";
    expect(res.body.errors).toEqual([null, invalid, invalid, invalid, null]);
  });

  it("refuses patterns over the length limit", async () => {
    const res = await request(app)
      .post("/api/config/rules/check")
      .set("Cookie", cookie)
      .send({ patterns: ["a".repeat(301)] });
    expect(res.status).toBe(400);
  });
});
