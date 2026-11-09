import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { ConfigOverride } from "../src/review/config/schema.ts";
import { DESCRIPTION_END, DESCRIPTION_START, WALKTHROUGH_MARKER, markersIn } from "../src/review/core/markers.ts";
import type { Finding, ReviewResult } from "../src/review/core/models.ts";
import type { CommitStatus, ForgePublisher, InlineComment } from "../src/review/forge/types.ts";
import { inlineBody, inlineComments } from "../src/review/publish/inline.ts";
import { inlineSelection } from "../src/review/core/buckets.ts";
import { publishReview, summaryPlacement, withInlineSelection } from "../src/review/publish/publisher.ts";
import { commitStatus } from "../src/review/publish/status.ts";
import { toMarkdown, walkthroughMarkdown } from "../src/review/render/markdown.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { sampleResult } from "./helpers/result.ts";
import { EVERY_OUTPUT } from "./helpers/output.ts";

// Every part of the output on, as these tests check each one (helpers/output.ts).
const config = (override: ConfigOverride = {}) => resolveConfig({ global: { output: EVERY_OUTPUT }, trigger: override }).config;

function finding(result: ReviewResult, title: string): Finding {
  return result.findings.find((f) => f.title.startsWith(title))!;
}

describe("inlineBody", () => {
  it("uses each forge's suggestion syntax and ends with the fingerprint marker", async () => {
    const result = await sampleResult();
    const blocker = { ...finding(result, "SQL"), endLine: 12 };

    const github = inlineBody(blocker, "github");
    const gitlab = inlineBody(blocker, "gitlab");

    expect(github).toContain("```suggestion\ndb.query(sql, [b]);\n```");
    expect(gitlab).toContain("```suggestion:-0+1\ndb.query(sql, [b]);\n```");
    expect(markersIn(github)).toEqual([blocker.fingerprint]);
    expect(github).toContain("SQL built from @​input");
  });
});

describe("inlineComments", () => {
  it("posts only actionable findings not already posted", async () => {
    const result = await sampleResult();
    const changeSet = makeChangeSet();
    const actionable = result.findings.filter((f) => f.bucket === "actionable");

    const all = inlineComments(result.findings, changeSet, "github", new Set());
    expect(all.map((c) => c.fingerprint)).toEqual(actionable.map((f) => f.fingerprint));

    const rest = inlineComments(result.findings, changeSet, "github", new Set([actionable[0]!.fingerprint]));
    expect(rest.map((c) => c.fingerprint)).toEqual([actionable[1]!.fingerprint]);
  });

  it("posts only findings at or above the inline severity, up to the cap, most severe first", async () => {
    const result = await sampleResult();
    const changeSet = makeChangeSet();
    const sql = finding(result, "SQL");
    const minor = finding(result, "c is never negative");
    // The minor finding first, so the cap has to pick by severity, not order.
    const findings = [minor, ...result.findings.filter((f) => f !== minor)];
    const prints = (limits: { minSeverity: "info" | "major"; max: number | null }, posted = new Set<string>()) => {
      const heldBack = new Set(inlineSelection(findings, limits, posted).heldBack.map((f) => f.fingerprint));
      return inlineComments(findings, changeSet, "github", posted, { heldBack }).map((c) => c.fingerprint);
    };

    expect(prints({ minSeverity: "info", max: null })).toEqual([minor.fingerprint, sql.fingerprint]);
    expect(prints({ minSeverity: "major", max: null })).toEqual([sql.fingerprint]);
    expect(prints({ minSeverity: "info", max: 1 })).toEqual([sql.fingerprint]);
    // A thread an earlier run posted still takes its place under the cap.
    expect(prints({ minSeverity: "info", max: 1 }, new Set([sql.fingerprint]))).toEqual([]);
  });

  it("adds the old line for a finding on an unchanged context line", async () => {
    const result = await sampleResult();
    const onContext: Finding = { ...finding(result, "SQL"), startLine: 13, endLine: 13 };

    const [comment] = inlineComments([onContext], makeChangeSet(), "gitlab", new Set());

    // Line 13 is " const d = 4;", old line 11 (two lines were added above it).
    expect(comment).toMatchObject({ startLine: 13, oldLine: 11 });
    expect(inlineComments([finding(result, "SQL")], makeChangeSet(), "gitlab", new Set())[0]!.oldLine).toBeUndefined();
  });
});

describe("commitStatus", () => {
  it("maps the verdict to a state with a reason", async () => {
    const result = await sampleResult();
    expect(commitStatus(result, "http://x")).toEqual({
      state: "failure",
      description: "1 finding at or above critical",
      targetUrl: "http://x",
    });
    expect(commitStatus({ ...result, verdict: { verdict: "pass", blockOn: "major", blocking: [] } }).state).toBe("success");
    expect(commitStatus({ ...result, verdict: { verdict: "error", blockOn: "major", blocking: [] } }).state).toBe("error");
  });
});

function recordingPublisher(
  options: {
    onForge?: string[];
    failInline?: boolean;
    description?: string;
    failDescription?: boolean;
    failThreads?: boolean;
    // Whether a summary comment from an earlier run is on the change.
    summaryOnForge?: boolean;
  } = {},
) {
  const calls = {
    inline: [] as InlineComment[],
    summaries: [] as string[],
    statuses: [] as CommitStatus[],
    comments: [] as { marker: string; body: string }[],
    descriptions: [] as string[],
    labels: [] as { add: string[]; remove: string[] }[],
    threads: [] as { fingerprints: string[]; resolved: boolean }[],
    // Which kind of comment went up when, across the kinds.
    order: [] as string[],
  };
  const publisher: ForgePublisher = {
    listPostedFingerprints: async () => new Set(options.onForge ?? []),
    postInlineComments: async (_ref, comments) => {
      if (options.failInline) throw new Error("boom");
      calls.inline.push(...comments);
      calls.order.push("inline");
      return { posted: comments.map((c) => ({ fingerprint: c.fingerprint, forgeCommentId: "1" })), failed: [] };
    },
    upsertSummaryComment: async (_ref, body, upsert) => {
      // Like the adapters: create: false only edits a comment already there.
      if (upsert?.create === false && options.summaryOnForge === false) return null;
      calls.summaries.push(body);
      calls.order.push("summary");
      return "s1";
    },
    upsertComment: async (_ref, marker, body) => {
      calls.comments.push({ marker, body });
      calls.order.push("comment");
      return "w1";
    },
    // Like the adapters: only an actual change is written.
    updateDescription: async (_ref, transform) => {
      if (options.failDescription) throw new Error("403 Forbidden");
      const before = options.description ?? "";
      const next = transform(before);
      if (next !== before) calls.descriptions.push(next);
    },
    setLabels: async (_ref, add, remove) => {
      calls.labels.push({ add, remove });
    },
    setCommitStatus: async (_ref, status) => {
      calls.statuses.push(status);
    },
    setThreadsResolved: async (_ref, fingerprints, resolved) => {
      if (options.failThreads) throw new Error("GraphQL request failed: nope");
      calls.threads.push({ fingerprints, resolved });
      return { updated: fingerprints, failed: [] };
    },
  };
  return { publisher, calls };
}

describe("publishReview", () => {
  it("posts the summary byte for byte as toMarkdown renders it", async () => {
    const result = await sampleResult();
    const { publisher, calls } = recordingPublisher();

    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result,
      config: config(),
      postedFingerprints: new Set(),
    });

    expect(calls.summaries).toEqual([toMarkdown(result, { walkthrough: true })]);
    expect(calls.inline).toHaveLength(2);
    expect(calls.statuses.map((s) => s.state)).toEqual(["failure"]);
    expect(publication).toMatchObject({ summaryCommentId: "s1", statusState: "failure", errors: [], inlineSkipped: 0 });
  });

  it("resolves threads for fixed findings and reopens ones that came back", async () => {
    const { publisher, calls } = recordingPublisher();

    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result: await sampleResult(),
      config: config(),
      postedFingerprints: new Set(),
      resolvedFingerprints: ["aaaaaaaaaaaaaaaa"],
      reopenedFingerprints: ["bbbbbbbbbbbbbbbb"],
    });

    expect(calls.threads).toEqual([
      { fingerprints: ["aaaaaaaaaaaaaaaa"], resolved: true },
      { fingerprints: ["bbbbbbbbbbbbbbbb"], resolved: false },
    ]);
    expect(publication).toMatchObject({
      threadsResolved: ["aaaaaaaaaaaaaaaa"],
      threadsReopened: ["bbbbbbbbbbbbbbbb"],
      errors: [],
    });
  });

  it("leaves threads alone when the setting or inline comments are off", async () => {
    for (const output of [{ resolveFixedThreads: false }, { postInline: false }]) {
      const { publisher, calls } = recordingPublisher();
      await publishReview({
        publisher,
        changeSet: makeChangeSet(),
        result: await sampleResult(),
        config: config({ output }),
        postedFingerprints: new Set(),
        resolvedFingerprints: ["aaaaaaaaaaaaaaaa"],
      });
      expect(calls.threads).toEqual([]);
    }
  });

  it("records a thread failure and still sets the commit status", async () => {
    const { publisher, calls } = recordingPublisher({ failThreads: true });

    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result: await sampleResult(),
      config: config(),
      postedFingerprints: new Set(),
      resolvedFingerprints: ["aaaaaaaaaaaaaaaa"],
    });

    expect(publication.errors).toEqual(["Inline threads could not be resolved: GraphQL request failed: nope"]);
    expect(publication.threadsFailed).toEqual(["aaaaaaaaaaaaaaaa"]);
    expect(calls.statuses).toHaveLength(1);
  });

  it("posts the summary before the inline comments", async () => {
    const { publisher, calls } = recordingPublisher();
    await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result: await sampleResult(),
      config: config(),
      postedFingerprints: new Set(),
    });
    expect(calls.order).toEqual(["summary", "inline"]);

    const alone = recordingPublisher();
    await publishReview({
      publisher: alone.publisher,
      changeSet: makeChangeSet(),
      result: await sampleResult(),
      config: config({ output: { postSummary: false } }),
      postedFingerprints: new Set(),
    });
    expect(alone.calls.order).toEqual(["comment", "inline"]);
  });

  it("skips findings already on the forge or in the database", async () => {
    const result = await sampleResult();
    const [first, second] = result.findings.filter((f) => f.bucket === "actionable");
    const { publisher, calls } = recordingPublisher({ onForge: [first!.fingerprint] });

    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result,
      config: config(),
      postedFingerprints: new Set([second!.fingerprint]),
    });

    expect(calls.inline).toEqual([]);
    expect(publication.inlineSkipped).toBe(2);
  });

  it("stops before the next step once proceed says the job was cancelled", async () => {
    const { publisher, calls } = recordingPublisher();
    // Lets the summary through, then reports the cancel.
    let asked = 0;
    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result: await sampleResult(),
      config: config(),
      postedFingerprints: new Set(),
      proceed: async () => ++asked === 1,
    });

    expect(publication.stopped).toBe(true);
    expect(calls.order).toEqual(["summary"]);
    expect(calls.statuses).toEqual([]);
  });

  it("keeps publishing the summary and status when inline comments fail", async () => {
    const { publisher, calls } = recordingPublisher({ failInline: true });

    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result: await sampleResult(),
      config: config(),
      postedFingerprints: new Set(),
    });

    expect(publication.errors).toEqual(["Inline comments failed: boom"]);
    expect(calls.summaries).toHaveLength(1);
    expect(calls.statuses).toHaveLength(1);
  });

  it("respects each output switch", async () => {
    const { publisher, calls } = recordingPublisher();

    await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result: await sampleResult(),
      config: config({ output: { postInline: false, postCheck: false } }),
      postedFingerprints: new Set(),
    });

    expect(calls.inline).toEqual([]);
    expect(calls.statuses).toEqual([]);
    expect(calls.summaries).toHaveLength(1);
  });
});

describe("inline limits and the summary", () => {
  it("writes the findings held back from inline out in full in the summary", async () => {
    const result = await sampleResult();
    const minor = finding(result, "c is never negative");

    const all = toMarkdown(result, { walkthrough: false });
    expect(all).not.toContain("Not posted inline");
    expect(toMarkdown({ ...result, heldBack: [] }, { walkthrough: false })).toBe(all);

    const limited = toMarkdown({ ...result, heldBack: [minor.fingerprint] }, { walkthrough: false });
    expect(limited).toContain("Actionable comments (1)");
    expect(limited).toContain("Not posted inline (1)");
    // In full, under its own heading, as the nitpick and outside-diff sections are.
    expect(limited).toMatch(new RegExp(`#### .*: ${minor.title}`));
    // Counted on its own, since it is written out below rather than inline.
    expect(limited).toMatch(/: 1 inline, 1 not posted inline, \d+ in the other sections below\./);
  });

  it("gives a held-back finding the rule wording and prompt its thread would have had", async () => {
    const result = await sampleResult();
    const minor = { ...finding(result, "c is never negative"), source: "rule" as const, ruleId: "no-dead-checks" };
    const held = { ...result, findings: result.findings.map((f) => (f.fingerprint === minor.fingerprint ? minor : f)), heldBack: [minor.fingerprint] };
    const rules = [{ id: "no-dead-checks", description: "Remove checks that can never be true." }];

    const withExtras = toMarkdown(held, { walkthrough: false, agentPrompt: false, rules, findingPrompts: true });
    expect(withExtras).toContain("📏 Rule no-dead-checks");
    expect(withExtras).toContain("Remove checks that can never be true.");
    expect(withExtras).toContain("Prompt for AI agents");

    const plain = toMarkdown(held, { walkthrough: false, agentPrompt: false, rules, findingPrompts: false });
    expect(plain).not.toContain("Prompt for AI agents");
  });

  it("keeps a finding's existing thread and counts it toward the cap", async () => {
    const result = await sampleResult();
    const sql = finding(result, "SQL");
    const minor = finding(result, "c is never negative");
    const cap = (minSeverity: "info" | "critical", max: number | null, posted: string[]) =>
      inlineSelection(result.findings, { minSeverity, max }, new Set(posted));

    // The minor finding's thread is already there: it stays inline and fills
    // the only slot, so the more severe new finding is held back.
    expect(cap("info", 1, [minor.fingerprint]).heldBack).toEqual([sql]);
    // A floor raised after the thread went up does not hide it either.
    expect(cap("critical", null, [minor.fingerprint]).inline).toContain(minor);
    // More threads than the cap: no new ones, and the slots never go negative.
    expect(cap("info", 1, [minor.fingerprint, sql.fingerprint]).heldBack).toEqual([]);
  });

  it("publishes the inline limits and holds the rest back to the summary", async () => {
    const result = await sampleResult();
    const { publisher, calls } = recordingPublisher();

    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result,
      config: config({ output: { maxInlineComments: 1 } }),
      postedFingerprints: new Set(),
    });

    expect(calls.inline.map((c) => c.fingerprint)).toEqual([finding(result, "SQL").fingerprint]);
    expect(calls.summaries[0]).toContain("Not posted inline (1)");
    // Returned so the worker stores it in the result for re-renders.
    expect(publication.heldBack).toEqual([finding(result, "c is never negative").fingerprint]);
  });

  it("never opens more threads than the cap, counting those already on the change", async () => {
    const result = await sampleResult();
    const sql = finding(result, "SQL");
    const minor = finding(result, "c is never negative");
    // An earlier run posted the minor finding's thread, by the forge's markers.
    const { publisher, calls } = recordingPublisher({ onForge: [minor.fingerprint] });

    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result,
      config: config({ output: { maxInlineComments: 1 } }),
      postedFingerprints: new Set(),
    });

    expect(calls.inline).toEqual([]);
    expect(publication.inlineSkipped).toBe(1);
    expect(publication.heldBack).toEqual([sql.fingerprint]);
    // Only the finding without a thread is written out, not the one that has one.
    expect(calls.summaries[0]).toContain("Not posted inline (1)");
    expect(calls.summaries[0]).toMatch(/#### .*: SQL built from/);
    expect(calls.summaries[0]).not.toMatch(new RegExp(`#### .*: ${minor.title}`));
  });

  it("holds nothing back when inline comments are off", async () => {
    const result = await sampleResult();
    const off = config({ output: { postInline: false, inlineMinSeverity: "critical" } });
    const selected = withInlineSelection(off, result, new Set());
    expect(selected.heldBack).toBeUndefined();
    expect(summaryPlacement(off, selected).summary).not.toContain("Not posted inline");
  });
});

describe("summary only with findings", () => {
  async function clean(status: ReviewResult["status"] = "completed"): Promise<ReviewResult> {
    return { ...(await sampleResult()), findings: [], status };
  }

  async function publishClean(result: ReviewResult, output: ConfigOverride["output"], summaryOnForge: boolean) {
    const { publisher, calls } = recordingPublisher({ summaryOnForge });
    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result,
      config: config({ output }),
      postedFingerprints: new Set(),
    });
    return { publication, calls };
  }

  it("starts no summary comment for a clean review, but still reports the status", async () => {
    const { publication, calls } = await publishClean(await clean(), { summaryOnlyWithFindings: true }, false);
    expect(calls.summaries).toEqual([]);
    expect(publication.summaryCommentId).toBeNull();
    expect(publication.walkthroughLocation).toBeNull();
    expect(calls.statuses).toHaveLength(1);
    expect(publication.errors).toEqual([]);
  });

  it("updates a summary an earlier run left on the change", async () => {
    const { publication, calls } = await publishClean(await clean(), { summaryOnlyWithFindings: true }, true);
    expect(calls.summaries).toHaveLength(1);
    expect(publication.summaryCommentId).toBe("s1");
  });

  it("still posts the summary for a partial review, a review with findings, or with the option off", async () => {
    expect((await publishClean(await clean("partial"), { summaryOnlyWithFindings: true }, false)).calls.summaries).toHaveLength(1);
    expect((await publishClean(await sampleResult(), { summaryOnlyWithFindings: true }, false)).calls.summaries).toHaveLength(1);
    expect((await publishClean(await clean(), {}, false)).calls.summaries).toHaveLength(1);
  });
});

describe("walkthrough placement and labels", () => {
  async function publish(output: ConfigOverride["output"], options: { description?: string; failDescription?: boolean } = {}) {
    const result = await sampleResult();
    const { publisher, calls } = recordingPublisher(options);
    const publication = await publishReview({
      publisher,
      changeSet: makeChangeSet(),
      result,
      config: config({ output }),
      postedFingerprints: new Set(),
    });
    return { result, calls, publication };
  }

  it("opens the review comment with the walkthrough, under one heading", async () => {
    const { calls, result, publication } = await publish({});
    expect(calls.comments).toEqual([]);
    expect(calls.descriptions).toEqual([]);
    expect(calls.summaries).toEqual([toMarkdown(result, { walkthrough: true })]);
    expect(calls.summaries[0]).toMatch(/^## Summary\n\nAdds b and c\./);
    expect(calls.summaries[0]).not.toContain("### Code review");
    expect(publication.walkthroughLocation).toBe("comment");
  });

  it("leaves the stats line out when reviewStats is off", async () => {
    const { calls, result } = await publish({ reviewStats: false });
    expect(calls.summaries).toEqual([toMarkdown(result, { walkthrough: true, stats: false })]);
    expect(calls.summaries[0]).not.toContain("<sub>Reviewed `");
  });

  it("leaves the walkthrough's labels and blast radius out when turned off", async () => {
    const { calls, result } = await publish({ walkthroughLabels: false, walkthroughBlastRadius: false });
    expect(calls.summaries).toEqual([toMarkdown(result, { walkthrough: true, labels: false, blastRadius: false })]);
    expect(calls.summaries[0]).not.toMatch(/Labels:|Blast radius:/);
    expect(calls.summaries[0]).toContain("Review effort:");

    const own = await publish({ postSummary: false, walkthroughBlastRadius: false });
    expect(own.calls.comments[0]!.body).toBe(
      `${walkthroughMarkdown(own.result, { blastRadius: false })}\n${WALKTHROUGH_MARKER}\n`,
    );
    expect(own.calls.comments[0]!.body).not.toContain("Blast radius:");
  });

  it("leaves the finding counts line out when findingCounts is off", async () => {
    const { calls, result } = await publish({ findingCounts: false });
    expect(calls.summaries).toEqual([toMarkdown(result, { walkthrough: true, counts: false })]);
    expect(calls.summaries[0]).not.toContain("in the sections below.");
  });

  it("leaves the lifecycle block out when findingLifecycle is off", async () => {
    const result = await sampleResult();
    const rerun = { ...result, lifecycle: { new: [], stillOpen: result.findings.map((f) => f.fingerprint), reopened: [], gone: [] } };
    const summary = (output: NonNullable<ConfigOverride["output"]>) => summaryPlacement(config({ output }), rerun).summary!;
    expect(summary({})).toContain("Since the last review");
    expect(summary({ findingLifecycle: false })).toBe(toMarkdown(rerun, { walkthrough: true, lifecycle: false }));
    expect(summary({ findingLifecycle: false })).not.toContain("Since the last review");
  });

  it("adds the agent prompts by default and leaves each out when turned off", async () => {
    const on = await publish({});
    expect(on.calls.summaries[0]).toContain("Prompt for AI agents (4 findings)");
    expect(on.calls.inline.length).toBeGreaterThan(0);
    for (const comment of on.calls.inline) expect(comment.body).toContain("Prompt for AI agents");

    const off = await publish({ agentPrompts: false, agentPromptAll: false });
    expect(off.calls.summaries).toEqual([toMarkdown(off.result, { walkthrough: true, agentPrompt: false })]);
    for (const comment of off.calls.inline) expect(comment.body).not.toContain("Prompt for AI agents");
  });

  it("ignores a legacy summary location", async () => {
    const { calls, result } = await publish({ summaryLocation: "description" });
    expect(calls.descriptions).toEqual([]);
    expect(calls.summaries).toEqual([toMarkdown(result, { walkthrough: true })]);
  });

  it("posts the walkthrough as a comment of its own when the review comment is off", async () => {
    const { calls, result, publication } = await publish({ postSummary: false });
    expect(calls.summaries).toEqual([]);
    expect(calls.comments).toEqual([
      { marker: WALKTHROUGH_MARKER, body: `${walkthroughMarkdown(result)}\n${WALKTHROUGH_MARKER}\n` },
    ]);
    expect(publication.walkthroughLocation).toBe("comment");
  });

  it("takes an earlier version's block out of the description and keeps the author's text", async () => {
    const earlier = `Fixes the login bug.\n\n${DESCRIPTION_START}\n## Sentryward summary\n\nOld.\n${DESCRIPTION_END}\n`;
    const { calls } = await publish({}, { description: earlier });
    expect(calls.descriptions).toEqual(["Fixes the login bug."]);
  });

  it("leaves a description without a block untouched", async () => {
    const { calls } = await publish({}, { description: "Fixes the login bug.\n\n" });
    expect(calls.descriptions).toEqual([]);
  });

  it("does not fail the publication when the description cannot be cleaned", async () => {
    const { calls, publication } = await publish({}, { failDescription: true });
    expect(publication.errors).toEqual([]);
    expect(calls.summaries).toHaveLength(1);
  });

  it("sets the estimate labels and takes off the family's other values", async () => {
    const { calls, publication } = await publish({ blastRadiusLabel: true, effortLabel: true });
    expect(calls.labels).toHaveLength(1);
    expect(calls.labels[0]!.add).toEqual(["Small blast radius", "1-5 Minutes"]);
    expect(calls.labels[0]!.remove).toContain("Large blast radius");
    expect(calls.labels[0]!.remove).toContain("10-20 Minutes");
    expect(calls.labels[0]!.remove).not.toContain("1-5 Minutes");
    expect(publication.labels).toEqual(["Small blast radius", "1-5 Minutes"]);

    const off = await publish({});
    expect(off.calls.labels).toEqual([]);
  });
});
