import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/review/config/resolve.ts";
import { parseRepoFile } from "../src/review/config/repoFile.ts";
import type { ConfigOverride } from "../src/review/config/schema.ts";
import { withDescriptionSummary, withoutDescriptionBlock } from "../src/review/core/markers.ts";
import type { IssueContext } from "../src/review/core/models.ts";
import { ForgeCache } from "../src/review/forge/cache.ts";
import { GitHubAdapter } from "../src/review/forge/github.ts";
import { GitLabAdapter } from "../src/review/forge/gitlab.ts";
import { closingIssueNumbers, searchTerms } from "../src/review/forge/issues.ts";
import { parseLenient } from "../src/review/llm/format.ts";
import { repairWalkthroughOutput, walkthroughSchemaFor } from "../src/review/llm/schemas.ts";
import { generateWalkthrough } from "../src/review/llm/walkthrough.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { WALKTHROUGH, fakeModel } from "./helpers/model.ts";
import { EVERY_OUTPUT } from "./helpers/output.ts";

// Every part of the output on, as these tests check each one (helpers/output.ts).
const config = (override: ConfigOverride = {}) => resolveConfig({ global: { output: EVERY_OUTPUT }, trigger: override }).config;

const issue = (ref: string, title = `Issue ${ref}`): IssueContext => ({ ref, title, state: "open", body: "details" });

describe("walkthrough settings", () => {
  it("default to the quiet setup with related issues only, and read snake_case from the repository file", () => {
    // The real defaults, without the helper's every-part-on layer.
    const { output, triggers, review } = resolveConfig({}).config;
    expect(output).toMatchObject({
      sequenceDiagrams: false,
      estimateEffort: false,
      assessLinkedIssues: false,
      relatedIssues: true,
      highLevelSummary: false,
      highLevelSummaryPlacement: "description",
      highLevelSummaryInstructions: "",
    });
    expect(triggers.abortOnClose).toBe(true);
    expect(review.disableCache).toBe(false);

    const file = parseRepoFile(
      ".sentryward.yaml",
      "output:\n  sequence_diagrams: false\n  high_level_summary_placement: walkthrough\n  high_level_summary_instructions: Bullets only\ntriggers:\n  abort_on_close: false\nreview:\n  disable_cache: true\n",
    );
    expect(file.warnings).toEqual([]);
    expect(file.override).toEqual({
      output: { sequenceDiagrams: false, highLevelSummaryPlacement: "walkthrough", highLevelSummaryInstructions: "Bullets only" },
      triggers: { abortOnClose: false },
      review: { disableCache: true },
    });
  });
});

describe("closingIssueNumbers", () => {
  it("reads this repository's issues from closing keywords only", () => {
    const description = [
      "Fixes #12 and closes acme/web#13.",
      "Resolves https://github.com/acme/web/issues/14).",
      "See #15; closes other/repo#16; fixes https://github.com/other/repo/issues/17",
      "fixes #12 again",
    ].join("\n");
    expect(closingIssueNumbers(description, "acme/web", "github.com")).toEqual([12, 13, 14]);
  });

  it("stops at five", () => {
    const description = Array.from({ length: 8 }, (_, i) => `fixes #${i + 1}`).join("\n");
    expect(closingIssueNumbers(description, "acme/web", "github.com")).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("searchTerms", () => {
  it("keeps the distinctive words of a title", () => {
    expect(searchTerms("feat(api): Add user lookup endpoint with caching")).toEqual(["user", "lookup", "endpoint", "caching"]);
    expect(searchTerms("Fix it")).toEqual([]);
  });
});

describe("ForgeCache", () => {
  it("reuses an answer until it expires and evicts the least recently used", async () => {
    let now = 0;
    const cache = new ForgeCache({ maxEntries: 2, ttlMs: 100, now: () => now });
    let fetches = 0;
    const fetch = async () => ++fetches;

    expect(await cache.memo("a", fetch)).toBe(1);
    expect(await cache.memo("a", fetch)).toBe(1);
    await cache.memo("b", fetch);
    await cache.memo("a", fetch);
    await cache.memo("c", fetch);
    // "b" was least recently used.
    expect(await cache.memo("b", fetch)).toBe(4);

    now = 500;
    expect(await cache.memo("b", fetch)).toBe(5);
  });

  it("evicts the least recently used entries to stay under the byte limit", async () => {
    const cache = new ForgeCache({ maxBytes: 25 });
    // Each value serializes to 10 characters: a quoted 8-character string.
    const value = (c: string) => async () => c.repeat(8);

    await cache.memo("a", value("a"));
    await cache.memo("b", value("b"));
    expect(cache.bytes).toBe(20);
    await cache.memo("a", value("x"));
    await cache.memo("c", value("c"));
    // "b" was least recently used, and dropping it brings the total to 20.
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(20);
    expect(await cache.memo("a", value("x"))).toBe("aaaaaaaa");
    expect(await cache.memo("b", value("y"))).toBe("yyyyyyyy");
  });

  it("returns a value over the per-entry limit without storing it", async () => {
    const cache = new ForgeCache({ maxEntryBytes: 10 });
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return "x".repeat(20);
    };

    expect(await cache.memo("big", fetch)).toBe("x".repeat(20));
    expect(await cache.memo("big", fetch)).toBe("x".repeat(20));
    expect(fetches).toBe(2);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it("treats a negative limit as storing nothing instead of looping", async () => {
    for (const options of [{ maxEntries: -1 }, { maxBytes: -1 }]) {
      const cache = new ForgeCache(options);
      expect(await cache.memo("a", async () => "aa")).toBe("aa");
      expect(cache.size).toBe(0);
      expect(cache.bytes).toBe(0);
    }
  });

  it("does not keep counting expired or replaced entries", async () => {
    let now = 0;
    const cache = new ForgeCache({ ttlMs: 100, now: () => now });

    await cache.memo("a", async () => "aaaaaaaa");
    now = 500;
    await cache.memo("a", async () => "bb");
    expect(cache.bytes).toBe(4);

    // Two concurrent misses for one key: the last one stored is counted once.
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const first = cache.memo("c", async () => {
      await slow;
      return "cccccccc";
    });
    await cache.memo("c", async () => "dd");
    release();
    await first;
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(14);

    cache.clear();
    expect(cache.bytes).toBe(0);
  });
});

describe("description summary block", () => {
  const block = "<!-- sentryward:summary:start -->\nnotes\n<!-- sentryward:summary:end -->";

  it("writes, replaces, keeps and removes the block", () => {
    const written = withDescriptionSummary("Closes #1", block);
    expect(written).toBe(`Closes #1\n\n${block}`);
    expect(withDescriptionSummary(written, block)).toBe(written);
    expect(withDescriptionSummary(written, block.replace("notes", "new"))).toBe(`Closes #1\n\n${block.replace("notes", "new")}`);
    // A run without a summary keeps the last one.
    expect(withDescriptionSummary(written, null)).toBe(written);
    expect(withDescriptionSummary(written, "")).toBe("Closes #1");
    expect(withDescriptionSummary("", block)).toBe(block);
    // A review never reads its own summary as the author's text.
    expect(withoutDescriptionBlock(written)).toBe("Closes #1");
  });

  it("still clears the old walkthrough block", () => {
    const legacy = "Text\n\n<!-- sentryward:walkthrough:start -->\nold\n<!-- sentryward:walkthrough:end -->";
    expect(withDescriptionSummary(legacy, null)).toBe("Text");
    expect(withDescriptionSummary("Text", null)).toBe("Text");
  });
});

describe("repairWalkthroughOutput with optional parts", () => {
  it("normalises issue entries and keeps only the requested parts", () => {
    const schema = walkthroughSchemaFor({ sequenceDiagram: true, highLevelSummary: false, linkedIssues: true, relatedIssues: true });
    const output = parseLenient(
      JSON.stringify({
        overview: "o",
        sequence_diagram: "sequenceDiagram\n  A->>B: hi",
        linked_issues: [{ ref: "#1", status: "Not addressed", note: "n" }, { note: "no ref" }],
        related_issues: "none",
      }),
      schema,
      repairWalkthroughOutput,
    );
    expect(output).toMatchObject({
      sequenceDiagram: "sequenceDiagram\n  A->>B: hi",
      linkedIssues: [{ ref: "#1", assessment: "not_addressed", note: "n" }],
      relatedIssues: [],
    });
    expect(output).not.toHaveProperty("highLevelSummary");
  });
});

describe("generateWalkthrough", () => {
  const change = makeChangeSet();

  it("asks only for the enabled parts and keeps only what the forge returned", async () => {
    const model = fakeModel({
      walkthrough: {
        ...WALKTHROUGH,
        sequenceDiagram: "```mermaid\nsequenceDiagram\n  A->>B: hi\n```",
        highLevelSummary: "  - notes  ",
        linkedIssues: [{ ref: "#1", assessment: "addressed", note: " ok " }, { ref: "#99", assessment: "addressed", note: "?" }],
        relatedIssues: [{ ref: "#2", reason: "same" }, { ref: "#2", reason: "twice" }],
      },
    });
    const { walkthrough } = await generateWalkthrough(
      model.generate,
      change,
      change.files,
      config({ output: { highLevelSummaryInstructions: "Bullets please" } }),
      { linked: [issue("#1")], candidates: [issue("#2"), issue("#3")] },
    );

    expect(walkthrough).toMatchObject({
      sequenceDiagram: "sequenceDiagram\n  A->>B: hi",
      highLevelSummary: "- notes",
      linkedIssues: [{ ref: "#1", title: "Issue #1", assessment: "addressed", note: "ok" }],
      relatedIssues: [{ ref: "#2", reason: "same" }],
    });
    expect(walkthrough.linkedIssues![0]).not.toHaveProperty("body");
    const prompt = model.requests[0]!.prompt;
    expect(prompt).toContain("Bullets please");
    expect(prompt).toContain("#3 (open)");
  });

  it("asks for nothing extra when the parts are off or there is nothing to assess", async () => {
    const model = fakeModel({ walkthrough: { ...WALKTHROUGH, sequenceDiagram: "graph TD; A-->B" } });
    const off = config({ output: { highLevelSummary: false } });
    const { walkthrough } = await generateWalkthrough(model.generate, change, change.files, off, { linked: [], candidates: [] });

    // Not a sequence diagram, so it is not kept.
    expect(walkthrough).not.toHaveProperty("sequenceDiagram");
    expect(walkthrough).not.toHaveProperty("linkedIssues");
    const prompt = model.requests[0]!.prompt;
    expect(prompt).not.toMatch(/highLevelSummary|Linked issues|Candidate issues/);
    expect(prompt).toContain("sequenceDiagram:");
  });
});

describe("issue lookups", () => {
  it("reads GitHub's closing references and searches its issues", async () => {
    const stub = fetchStub([
      { url: /\/repos\/acme\/web\/issues\/3$/, body: { number: 3, title: "Bug", body: "b", state: "open", html_url: "https://github.com/acme/web/issues/3" } },
      { url: /\/repos\/acme\/web\/issues\/4$/, status: 404, body: { message: "Not Found" } },
      { url: /\/repos\/acme\/web\/issues\/5$/, body: { number: 5, title: "A PR", body: null, state: "open", html_url: "x", pull_request: {} } },
      {
        url: /\/search\/issues\?/,
        body: { items: [{ number: 8, title: "Parser", body: null, state: "closed", html_url: "https://github.com/acme/web/issues/8" }] },
      },
    ]);
    const gh = new GitHubAdapter({ host: "github.com", token: async () => "t", fetch: stub.fetch });
    const change = { ...makeChangeSet(), description: "fixes #3, fixes #4, closes #5" };
    change.forgeRef = { ...change.forgeRef, project: "acme/web" };

    expect(await gh.getLinkedIssues(change)).toEqual([
      { ref: "#3", title: "Bug", url: "https://github.com/acme/web/issues/3", state: "open", body: "b" },
    ]);
    expect(await gh.searchIssues("acme/web", ["parser", "tokens"])).toEqual([
      { ref: "#8", title: "Parser", url: "https://github.com/acme/web/issues/8", state: "closed", body: "" },
    ]);
    const search = new URL(stub.calls.at(-1)!.url);
    expect(search.searchParams.get("q")).toBe("repo:acme/web is:issue parser OR tokens");
    expect(await gh.searchIssues("acme/web", [])).toEqual([]);
  });

  it("asks GitLab which issues an MR closes and searches term by term", async () => {
    const stub = fetchStub([
      {
        url: /merge_requests\/7\/closes_issues/,
        body: [{ iid: 1, title: "Crash", description: "d", state: "opened", web_url: "https://gitlab.com/team/app/-/issues/1" }],
      },
      { url: /issues\?search=parser/, body: [{ iid: 2, title: "Parser", description: null, state: "closed", web_url: "u2" }] },
      { url: /issues\?search=tokens/, body: [{ iid: 2, title: "Parser", description: null, state: "closed", web_url: "u2" }] },
    ]);
    const gl = new GitLabAdapter({ host: "gitlab.com", token: async () => "t", fetch: stub.fetch });
    const change = makeChangeSet();
    change.forgeRef = { ...change.forgeRef, provider: "gitlab", project: "team/app", number: 7 };

    expect(await gl.getLinkedIssues(change)).toEqual([
      { ref: "#1", title: "Crash", url: "https://gitlab.com/team/app/-/issues/1", state: "open", body: "d" },
    ]);
    expect(await gl.searchIssues("team/app", ["parser", "tokens"])).toEqual([
      { ref: "#2", title: "Parser", url: "u2", state: "closed", body: "" },
    ]);
  });

  it("reads a pull request's files once per head through the cache", async () => {
    const pull = {
      title: "t",
      body: null,
      html_url: "u",
      state: "open",
      base: { sha: "b1", ref: "main" },
      head: { sha: "h1", ref: "f" },
    };
    const stub = fetchStub([
      { url: /\/pulls\/1$/, body: pull },
      { url: /\/pulls\/1\/files/, body: [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", changes: 2 }] },
    ]);
    const gh = new GitHubAdapter({ host: "github.com", token: async () => "t", fetch: stub.fetch });
    const cache = new ForgeCache();

    await gh.getChange("acme/web", 1, cache);
    const again = await gh.getChange("acme/web", 1, cache);
    await gh.getChange("acme/web", 1);

    expect(again.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(stub.calls.filter((call) => call.url.includes("/files"))).toHaveLength(2);
    // The pull itself, with its title and labels, is always read fresh, and
    // read again after each listing that is fetched, to check it did not move.
    expect(stub.calls.filter((call) => call.url.endsWith("/pulls/1"))).toHaveLength(5);
  });
});
