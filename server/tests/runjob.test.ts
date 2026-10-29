import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.ts";
import type { IssueContext, ReviewResult, ToolAnnotation } from "../src/review/core/models.ts";
import { ForgeCache } from "../src/review/forge/cache.ts";
import { ForgeError } from "../src/review/forge/http.ts";
import type { InlineComment } from "../src/review/forge/types.ts";
import type { Forge } from "../src/services/forge.ts";
import {
  cancelForDisabledRepositories,
  cancelJob,
  claimNext,
  DISABLED_REASON,
  enqueue,
  fail,
  recordProgress,
} from "../src/worker/queue.ts";
import { runJob, skipReason, walkthroughEnabled, type RunJobDeps } from "../src/worker/runJob.ts";
import { DEFAULT_CONFIG } from "../src/review/config/schema.ts";
import { fingerprint } from "../src/review/core/fingerprint.ts";
import type { FileDiffInput } from "../src/review/diff/parse.ts";
import { APP_PATCH, makeChangeSet } from "./helpers/changeSet.ts";
import { mergePolicy, OPEN_LAYER, type PolicyLayer } from "../src/services/privacyPolicy.ts";
import { WALKTHROUGH, fakeModel, modelFinding } from "./helpers/model.ts";

let repositoryId: string;
let workspaceId: string;

// The fingerprint the default modelFinding() gets after validation (its kind is
// not demoted, as it carries real evidence), used to seed a prior dismissal.
const DEFAULT_FINGERPRINT = fingerprint({
  file: "src/app.ts",
  category: "bug",
  kind: "potential_issue",
  title: "b overflows for large a",
});

async function seedIgnored(overrides: {
  number: number;
  fingerprint: string;
  title: string;
  ignoreReason: "false_positive" | "intentional" | "fix_later" | "not_specified";
  ignoreNote?: string;
}) {
  await prisma.finding.create({
    data: {
      repositoryId,
      number: overrides.number,
      fingerprint: overrides.fingerprint,
      state: "ignored",
      ignoredAt: new Date(),
      ignoreReason: overrides.ignoreReason,
      ignoreNote: overrides.ignoreNote,
      title: overrides.title,
      file: "src/app.ts",
      startLine: 11,
      severity: "major",
      category: "bug",
      kind: "potential_issue",
      changeTitle: "t",
    },
  });
}

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const workspace = await prisma.workspace.create({
    data: { name: "W", reviewSettings: { llm: { connection: "anthropic" } } },
  });
  workspaceId = workspace.id;
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: workspace.id, provider: "github", host: "github.com", kind: "github_app", installationId: "1", accountLogin: "acme" },
  });
  const repo = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "github",
      host: "github.com",
      fullPath: "acme/web",
      externalId: "1",
      defaultBranch: "main",
      enabled: true,
      settings: { review: { blockOn: "major" } },
      followGlobal: false,
    },
  });
  repositoryId = repo.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

interface Published {
  inline: { fingerprint: string; startLine: number }[];
  summaries: string[];
  statuses: string[];
  descriptions: string[];
  labels: string[][];
  threads: { fingerprints: string[]; resolved: boolean }[];
}

function deps(
  files: Record<string, string>,
  answers: Parameters<typeof fakeModel>[0],
  keys = { anthropic: "k" },
  options: {
    failSummary?: boolean;
    onForge?: string[];
    // What getChangeHead reports, once per call; the last entry repeats.
    states?: ("open" | "closed" | "merged")[];
    issues?: { linked?: IssueContext[]; found?: IssueContext[] };
    title?: string;
    cache?: ForgeCache;
    // Every thread update fails, as a forge outage would.
    failThreads?: boolean;
    // The head getChange reports, and the change's files.
    head?: string;
    files?: FileDiffInput[];
    // What compareCommits answers; recorded as "compare:<from>..<to>".
    compare?: string[] | null | Error;
    // What getToolAnnotations answers; each call is recorded in toolReads.
    tools?: { annotations: ToolAnnotation[]; warnings: string[] } | Error;
    // What getChange throws instead of answering.
    changeError?: Error;
  } = {},
) {
  const reads: string[] = [];
  const toolReads: string[] = [];
  const published: Published = { inline: [], summaries: [], statuses: [], descriptions: [], labels: [], threads: [] };
  const forge = {
    getChange: async (_p: string, _n: number, cache?: ForgeCache) => {
      reads.push(cache ? "change:cached" : "change");
      if (options.changeError) throw options.changeError;
      const change = makeChangeSet(options.files);
      return {
        ...change,
        title: options.title ?? change.title,
        author: "alice",
        forgeRef: { ...change.forgeRef, headSha: options.head ?? "newhead" },
      };
    },
    compareCommits: async (_p: string, from: string, to: string) => {
      reads.push(`compare:${from}..${to}`);
      if (options.compare instanceof Error) throw options.compare;
      return options.compare === undefined ? [] : options.compare;
    },
    getToolAnnotations: async (ref: { headSha: string }) => {
      toolReads.push(ref.headSha);
      if (options.tools instanceof Error) throw options.tools;
      return options.tools ?? { annotations: [], warnings: [] };
    },
    getChangeHead: async () => {
      const states = options.states ?? ["open"];
      const state = states.length > 1 ? states.shift()! : states[0]!;
      return { headSha: "newhead", baseSha: "base", title: "t", state, isDraft: false };
    },
    getLinkedIssues: async () => options.issues?.linked ?? [],
    searchIssues: async (_project: string, terms: string[]) => {
      reads.push(`search:${terms.join(" ")}`);
      return options.issues?.found ?? [];
    },
    getFileAtRef: async (_p: string, path: string, ref: string) => {
      reads.push(`${ref}:${path}`);
      return files[`${ref}:${path}`] ?? null;
    },
    searchCode: async (_p: string, term: string) => {
      reads.push(`code:${term}`);
      return [];
    },
    listPostedFingerprints: async () => new Set(options.onForge ?? []),
    postInlineComments: async (_ref: unknown, comments: InlineComment[]) => {
      published.inline.push(...comments.map((c) => ({ fingerprint: c.fingerprint, startLine: c.startLine })));
      return { posted: comments.map((c) => ({ fingerprint: c.fingerprint, forgeCommentId: `c-${c.fingerprint}` })), failed: [] };
    },
    upsertSummaryComment: async (_ref: unknown, body: string) => {
      if (options.failSummary && !body.includes("Reviewing")) throw new Error("403 Forbidden");
      published.summaries.push(body);
      return "note-1";
    },
    upsertComment: async (_ref: unknown, _marker: string, body: string) => {
      published.summaries.push(body);
      return "note-2";
    },
    updateDescription: async (_ref: unknown, transform: (description: string) => string) => {
      // Like the adapters: only an actual change is written.
      const next = transform("");
      if (next !== "") published.descriptions.push(next);
    },
    setLabels: async (_ref: unknown, add: string[]) => {
      published.labels.push(add);
    },
    setCommitStatus: async (_ref: unknown, status: { state: string }) => {
      published.statuses.push(status.state);
    },
    setThreadsResolved: async (_ref: unknown, fingerprints: string[], resolved: boolean) => {
      if (options.failThreads) throw new Error("502 Bad Gateway");
      published.threads.push({ fingerprints, resolved });
      return { updated: fingerprints, failed: [] };
    },
  } as unknown as Forge;
  const model = fakeModel(answers);
  const connections = Object.fromEntries(
    Object.entries(keys).map(([provider, apiKey]) => [provider, { apiKey }]),
  );
  const runDeps: RunJobDeps = {
    adapterFor: () => forge,
    generateFor: () => model.generate,
    credentialsFor: async () => ({ keys, baseUrls: {}, connections }),
    cache: options.cache,
  };
  return { runDeps, reads, toolReads, model, published };
}

async function claimedJob() {
  await enqueue({ repositoryId, number: 42, headSha: "oldhead", trigger: "manual" });
  return (await claimNext())!;
}

describe("runJob", () => {
  it("reviews the change and stores result, verdict, config and the actual head", async () => {
    const job = await claimedJob();
    const { runDeps, reads } = deps(
      { "base:.sentryward.yaml": "output:\n  walkthrough: true\n" },
      { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH },
    );

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "completed", verdict: "blocked", headSha: "newhead", baseSha: "base", error: null, title: "Add b and c" });
    expect(stored.lockedAt).toBeNull();
    const result = stored.result as ReviewResult;
    expect(result.findings).toHaveLength(1);
    // A change's first review has nothing earlier to compare with.
    expect(result.lifecycle).toBeUndefined();
    // blockOn came from the saved repository settings.
    expect(result.verdict.blockOn).toBe("major");
    expect(stored.resolvedConfig).toMatchObject({ repoFile: ".sentryward.yaml", sources: { "review.blockOn": "repoSettings" } });
    // The repository file is read at the base revision, never the head; review
    // context is read at the head, and callers of the changed main() searched
    // (the search starts before any pass reads).
    expect(reads).toEqual(["change", "base:.sentryward.yaml", "code:main", "newhead:src/app.ts"]);
    // The findings table follows the run, with the change's author.
    const findings = await prisma.finding.findMany({ where: { repositoryId, number: 42 } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ state: "open", lifecycle: "new", author: "alice", lastJobId: job.id });
  });

  it("records each call's cost at the workspace's prices, and as unknown where none is known", async () => {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { reviewSettings: { llm: { connection: "anthropic", walkthroughModel: "anthropic/unpriced-model" } } },
    });
    await prisma.modelPrice.create({ data: { workspaceId, model: "anthropic/claude-sonnet-5-5", input: 10_000, output: 0 } });
    const job = await claimedJob();
    const { runDeps } = deps(
      { "base:.sentryward.yaml": "output:\n  walkthrough: true\n" },
      { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH },
    );

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    const usage = (stored.result as ReviewResult).usage;
    // 100 input tokens at $10,000 per million.
    expect(usage.find((u) => u.purpose === "review")).toMatchObject({ cost: { total: 1 } });
    expect(usage.find((u) => u.purpose === "walkthrough")).toMatchObject({ unpriced: true });
    expect(stored.summary).toMatchObject({
      usageByModel: {
        "anthropic/claude-sonnet-5-5": { cost: { total: 1 }, unpricedCalls: 0, latencyMs: 5 },
        "anthropic/unpriced-model": { unpricedCalls: 1 },
      },
      duplicates: 0,
    });
  });

  it("reports static analysis on changed lines as tool findings that do not block", async () => {
    const job = await claimedJob();
    const annotation: ToolAnnotation = {
      tool: "lint",
      file: "src/app.ts",
      startLine: 12,
      endLine: 12,
      severity: "critical",
      category: "bug",
      ruleId: "no-undef",
      title: "'c' is not defined",
      message: "'c' is not defined.",
    };
    const { runDeps, toolReads, published } = deps(
      {},
      { code_review: { findings: [] }, walkthrough: WALKTHROUGH },
      { anthropic: "k" },
      { tools: { annotations: [annotation], warnings: ["Checks still running when the review started were left out: test"] } },
    );

    await runJob(job, runDeps);

    expect(toolReads).toEqual(["newhead"]);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "completed", verdict: "pass" });
    const result = stored.result as { findings: { source: string; tool?: string }[]; warnings: string[] };
    expect(result.findings).toEqual([expect.objectContaining({ source: "tool", tool: "lint", ruleId: "no-undef" })]);
    expect(result.warnings).toContain("Checks still running when the review started were left out: test");
    expect(published.inline).toHaveLength(1);
  });

  it("warns, and still reviews, when static analysis results cannot be read", async () => {
    const job = await claimedJob();
    const { runDeps } = deps(
      {},
      { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH },
      { anthropic: "k" },
      { tools: new ForgeError(403, "GET check-runs failed (403): Resource not accessible by integration") },
    );

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "completed", verdict: "blocked" });
    const result = stored.result as { findings: unknown[]; warnings: string[] };
    expect(result.findings).toHaveLength(1);
    expect(result.warnings).toContain(
      "Static analysis results could not be read; the GitHub App needs the Checks (read) permission",
    );
  });

  it("does not read static analysis results when tool findings are off", async () => {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { review: { blockOn: "major", toolFindings: false } } },
    });
    const job = await claimedJob();
    const { runDeps, toolReads } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(toolReads).toEqual([]);
  });

  it("never reposts a finding this team dismissed on the same change", async () => {
    const job = await claimedJob();
    await seedIgnored({ number: 42, fingerprint: DEFAULT_FINGERPRINT, title: "b overflows for large a", ignoreReason: "false_positive" });
    const { runDeps, published } = deps({}, { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published.inline).toHaveLength(0);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    const result = stored.result as { findings: unknown[]; validation: { dropped: Record<string, number> } };
    expect(result.findings).toHaveLength(0);
    expect(result.validation.dropped.previously_ignored).toBe(1);
  });

  it("lists recent repo dismissals in the review prompt, excluding fix_later", async () => {
    const job = await claimedJob();
    await seedIgnored({ number: 7, fingerprint: "aaaa000000000000", title: "nullable config read", ignoreReason: "false_positive", ignoreNote: "config is always set by the loader" });
    await seedIgnored({ number: 8, fingerprint: "bbbb000000000000", title: "intentional global mutation", ignoreReason: "intentional" });
    await seedIgnored({ number: 9, fingerprint: "cccc000000000000", title: "fix this later please", ignoreReason: "fix_later" });
    const { runDeps, model } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const review = model.requests.find((r) => r.schemaName === "code_review");
    expect(review?.prompt).toContain("Previously rejected by this team");
    expect(review?.prompt).toContain("nullable config read");
    expect(review?.prompt).toContain("config is always set by the loader");
    expect(review?.prompt).toContain("intentional global mutation");
    expect(review?.prompt).not.toContain("fix this later please");
  });

  it("reports a dismissed finding again when suppression is turned off", async () => {
    const job = await claimedJob();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { review: { blockOn: "major", suppressIgnored: false } } },
    });
    await seedIgnored({ number: 42, fingerprint: DEFAULT_FINGERPRINT, title: "b overflows for large a", ignoreReason: "false_positive" });
    const { runDeps, model, published } = deps({}, { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published.inline).toHaveLength(1);
    const review = model.requests.find((r) => r.schemaName === "code_review");
    expect(review?.prompt).not.toContain("Previously rejected by this team");
  });

  it("stores a failed review as failed with its errors", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: new Error("provider down"), walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "failed", verdict: "error", error: "Review pass 1 failed: provider down" });
    expect(await prisma.finding.count()).toBe(0);
  });

  it("refuses to run without a key for the configured model", async () => {
    const job = await claimedJob();
    const { runDeps, model } = deps({}, {}, {} as never);

    await expect(runJob(job, runDeps)).rejects.toThrow(/selected anthropic LLM connection no longer exists/);
    expect(model.requests).toHaveLength(0);
  });

  it("rejects a fallback that cannot use the selected official connection", async () => {
    const job = await claimedJob();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { llm: { fallbackModels: ["openai/gpt-5"] } } },
    });
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await expect(runJob(job, runDeps)).rejects.toThrow(/anthropic LLM connection.*cannot run model openai\/gpt-5/);
  });

  it("rejects a verify model that cannot use the selected official connection", async () => {
    const job = await claimedJob();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { llm: { verifyModel: "openai/gpt-5" } } },
    });
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await expect(runJob(job, runDeps)).rejects.toThrow(/anthropic LLM connection.*cannot run model openai\/gpt-5/);
  });

  it("ignores a verify model it cannot run while verification is off", async () => {
    const job = await claimedJob();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { llm: { verifyModel: "openai/gpt-5" }, review: { verify: "off" } } },
    });
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("completed");
  });

  it("sends every model call to the endpoint with the chosen key", async () => {
    const job = await claimedJob();
    const baseUrl = "http://host.docker.internal:20128/v1";
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { llm: { model: "openai/cx/gpt-5.6-sol(medium)", connection: "openai" } } },
    });
    const keys = { anthropic: "k", openai: "router-key" };
    const { runDeps, model } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, keys);
    const generateFor: unknown[][] = [];
    runDeps.generateFor = (...args) => {
      generateFor.push(args);
      return model.generate;
    };
    runDeps.credentialsFor = async () => ({
      keys,
      baseUrls: { openai: baseUrl },
      connections: { anthropic: { apiKey: "k" }, openai: { apiKey: "router-key", baseUrl } },
    });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("completed");
    expect(generateFor).toEqual([
      [
        keys,
        { baseUrl, apiKey: "router-key" },
        { openai: baseUrl },
        { ledger: expect.anything(), override: { thinking: "auto", tools: "auto" } },
      ],
    ]);
  });

  it("runs agentic passes, probing the model once and storing what it found", async () => {
    const job = await claimedJob();
    const baseUrl = "http://router.test/v1";
    await prisma.repository.update({
      where: { id: repositoryId },
      data: {
        settings: { llm: { model: "openai/gpt-x", connection: "openai", thinking: "low" }, review: { context: "agentic" } },
      },
    });
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH, verification: { verdict: "confirmed", reason: "" } });
    runDeps.credentialsFor = async () => ({
      keys: { openai: "k" },
      baseUrls: { openai: baseUrl },
      connections: { openai: { apiKey: "k", baseUrl } },
    });
    runDeps.probe = async () => ({
      capabilities: { thinking: "options", tools: true },
      detail: "thinking options work; tool calls work",
      spent: [{ model: "openai/gpt-x", inputTokens: 7, outputTokens: 2, latencyMs: 1 }],
    });
    const agentic: unknown[] = [];
    runDeps.generateAgenticFor = (_keys, _endpoint, _baseUrls, options) => async (request) => {
      agentic.push(request.model);
      // What the call itself learned is stored with the review.
      options?.ledger?.observe({ model: request.model, capabilities: { thinking: "none" }, source: "runtime" });
      return {
        object: { findings: [] } as never,
        model: request.model,
        inputTokens: 500,
        outputTokens: 30,
        latencyMs: 4,
        steps: 3,
        toolCalls: { read_file: 2, report_findings: 1 },
      };
    };

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("completed");
    expect(agentic).toEqual(["openai/gpt-x"]);
    const usage = (stored.result as { usage: { purpose: string; steps?: number }[] }).usage;
    expect(usage[0]).toMatchObject({ purpose: "probe", inputTokens: 7 });
    expect(usage.find((u) => u.purpose === "review")).toMatchObject({ steps: 3 });
    const row = await prisma.llmCapability.findFirstOrThrow({ where: { model: "openai/gpt-x" } });
    expect(row).toMatchObject({ endpoint: baseUrl, thinking: "none", tools: true, source: "runtime" });
  });

  it("refuses to run when the selected connection is not stored", async () => {
    const job = await claimedJob();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { llm: { connection: "google" } } },
    });
    const { runDeps, model } = deps({}, {});

    await expect(runJob(job, runDeps)).rejects.toThrow(/selected google LLM connection no longer exists/);
    expect(model.requests).toHaveLength(0);
  });

  it("posts progress first, then inline comments, the summary and the status", async () => {
    const job = await claimedJob();
    const { runDeps, published } = deps({}, { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published.summaries).toHaveLength(2);
    expect(published.summaries[0]).toMatch(/^⏳ \*\*Reviewing \[?`newhead`/);
    expect(published.summaries[0]).not.toContain("## Summary");
    expect(published.summaries[1]).toMatch(/^## Summary\n/);
    expect(published.statuses).toEqual(["pending", "failure"]);
    expect(published.inline).toHaveLength(1);
    // The walkthrough opens the review comment; the description is left alone.
    expect(published.descriptions).toEqual([]);
    expect(published.summaries[1]).not.toContain("### Walkthrough");
    expect(published.summaries[1]).toContain("Review effort:");

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.publication).toMatchObject({ summaryCommentId: "note-1", statusState: "failure", errors: [] });
    expect(await prisma.postedFinding.count({ where: { repositoryId, number: 42 } })).toBe(1);
  });

  it("never posts the same finding twice across runs", async () => {
    const answers = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };
    await runJob(await claimedJob(), deps({}, answers).runDeps);

    const second = deps({}, answers);
    await enqueue({ repositoryId, number: 42, headSha: "again", trigger: "manual" });
    await runJob((await claimNext())!, second.runDeps);

    expect(second.published.inline).toEqual([]);
    expect(await prisma.postedFinding.count()).toBe(1);
  });

  it("resolves the thread of a fixed finding and reopens it when the finding returns", async () => {
    const found = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };
    const clean = { code_review: { findings: [] }, walkthrough: WALKTHROUGH };
    const first = deps({}, found);
    await runJob(await claimedJob(), first.runDeps);
    const print = first.published.inline[0]!.fingerprint;
    expect(first.published.threads).toEqual([]);

    const fixed = deps({}, clean);
    await enqueue({ repositoryId, number: 42, headSha: "fixed", trigger: "manual" });
    const fixedJob = (await claimNext())!;
    await runJob(fixedJob, fixed.runDeps);
    expect(fixed.published.threads).toEqual([{ fingerprints: [print], resolved: true }]);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: fixedJob.id } });
    expect(stored.publication).toMatchObject({ threadsResolved: [print], threadsReopened: [] });
    expect(await prisma.finding.findFirst({ where: { fingerprint: print } })).toMatchObject({ state: "resolved", lifecycle: "fixed" });
    // The rerun records what became of the finding, and the summary says so.
    expect((stored.result as ReviewResult).lifecycle).toMatchObject({ new: [], stillOpen: [], gone: [{ fingerprint: print, outcome: "fixed" }] });
    expect(fixed.published.summaries.at(-1)).toContain("> 🔄 Since the last review: 1 fixed.");

    const back = deps({}, found);
    await enqueue({ repositoryId, number: 42, headSha: "back", trigger: "manual" });
    const backJob = (await claimNext())!;
    await runJob(backJob, back.runDeps);
    expect(back.published.threads).toEqual([{ fingerprints: [print], resolved: false }]);
    const backResult = (await prisma.reviewJob.findUniqueOrThrow({ where: { id: backJob.id } })).result as ReviewResult;
    expect(backResult.lifecycle).toMatchObject({ new: [], stillOpen: [], reopened: [print], gone: [] });
    expect(await prisma.finding.findFirst({ where: { fingerprint: print } })).toMatchObject({ state: "open", lifecycle: "reopened" });
    expect(back.published.summaries.at(-1)).toContain("> 🔄 Since the last review: 1 reopened.");
  });

  it("retries a thread update that failed on a later run, until it lands", async () => {
    const found = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };
    const clean = { code_review: { findings: [] }, walkthrough: WALKTHROUGH };
    const first = deps({}, found);
    await runJob(await claimedJob(), first.runDeps);
    const print = first.published.inline[0]!.fingerprint;
    const row = () => prisma.finding.findFirstOrThrow({ where: { fingerprint: print } });

    const outage = deps({}, clean, { anthropic: "k" }, { failThreads: true });
    await enqueue({ repositoryId, number: 42, headSha: "fixed", trigger: "manual" });
    const outageJob = (await claimNext())!;
    await runJob(outageJob, outage.runDeps);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: outageJob.id } });
    expect(stored.status).toBe("partial");
    expect(stored.publication).toMatchObject({ threadsFailed: [print] });
    expect(await row()).toMatchObject({ state: "resolved", threadPending: true });

    // Still fixed: no new transition, but the failed resolve is retried.
    const retry = deps({}, clean);
    await enqueue({ repositoryId, number: 42, headSha: "again", trigger: "manual" });
    await runJob((await claimNext())!, retry.runDeps);
    expect(retry.published.threads).toEqual([{ fingerprints: [print], resolved: true }]);
    expect(await row()).toMatchObject({ state: "resolved", threadPending: false });

    // Settled: nothing left to retry.
    const quiet = deps({}, clean);
    await enqueue({ repositoryId, number: 42, headSha: "quiet", trigger: "manual" });
    await runJob((await claimNext())!, quiet.runDeps);
    expect(quiet.published.threads).toEqual([]);
  });

  it("trusts markers already on the forge when the database has no row", async () => {
    const answers = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };
    const first = deps({}, answers);
    await runJob(await claimedJob(), first.runDeps);
    await prisma.postedFinding.deleteMany();

    const second = deps({}, answers, { anthropic: "k" }, { onForge: [first.published.inline[0]!.fingerprint] });
    await enqueue({ repositoryId, number: 42, headSha: "again", trigger: "manual" });
    await runJob((await claimNext())!, second.runDeps);

    expect(second.published.inline).toEqual([]);
  });

  it("marks the job partial when publishing fails, keeping the result", async () => {
    const job = await claimedJob();
    const { runDeps, published } = deps(
      {},
      { code_review: { findings: [] }, walkthrough: WALKTHROUGH },
      { anthropic: "k" },
      { failSummary: true },
    );

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "partial", verdict: "pass", error: "Summary comment failed: 403 Forbidden" });
    expect(stored.result).not.toBeNull();
    // The status still went out even though the summary did not.
    expect(published.statuses).toEqual(["pending", "success"]);
  });

  it("adds the estimate labels when they are turned on", async () => {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { output: { blastRadiusLabel: true, effortLabel: true } } },
    });
    const job = await claimedJob();
    const { runDeps, published } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published.labels).toEqual([["Small blast radius", "1-5 Minutes"]]);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.publication).toMatchObject({ labels: ["Small blast radius", "1-5 Minutes"], walkthroughLocation: "comment" });
  });

  it("records each stage on the job as it runs, ending with publishing", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });
    // What the job row held after each write, as the dashboard would read it.
    const seen: unknown[] = [];
    runDeps.recordProgress = async (id, attempts, progress) => {
      await recordProgress(id, attempts, progress);
      seen.push((await prisma.reviewJob.findUniqueOrThrow({ where: { id } })).progress);
    };

    await runJob(job, runDeps);

    const order = ["fetching", "preparing", "planning", "context", "walkthrough", "reviewing", "verifying", "publishing"];
    const stages = (seen as { stage: string }[]).map((progress) => progress.stage);
    // Updates made while a write is in flight are merged, so some stages may
    // never reach the row, but those that do arrive in order.
    expect(stages[0]).toBe("fetching");
    expect(stages.at(-1)).toBe("publishing");
    expect(stages.map((stage) => order.indexOf(stage))).toEqual([...stages.map((stage) => order.indexOf(stage))].sort((a, b) => a - b));
    expect(seen.at(-1)).toEqual({ stage: "publishing", steps: ["fetching", "preparing", "reviewing", "verifying", "publishing"] });
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("completed");
  });

  it("leaves publishing and verifying out of the steps when they are off", async () => {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: {
        settings: { review: { verify: "off" }, output: { postInline: false, postSummary: false, postCheck: false, walkthrough: false } },
      },
    });
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.progress).toMatchObject({ steps: ["fetching", "preparing", "reviewing"] });
  });

  it("finishes the review when progress cannot be recorded", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });
    runDeps.recordProgress = async () => {
      throw new Error("connection reset");
    };

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("completed");
  });

  it("publishes nothing when every output is turned off", async () => {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { output: { postInline: false, postSummary: false, postCheck: false, walkthrough: false } } },
    });
    const job = await claimedJob();
    const { runDeps, published } = deps({}, { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    expect(published).toEqual({ inline: [], summaries: [], statuses: [], descriptions: [], labels: [], threads: [] });
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.publication).toBeNull();
  });
});

describe("runJob when the change closes", () => {
  const answers = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };

  it("cancels without a model call when the change is already closed", async () => {
    const job = await claimedJob();
    const { runDeps, model, published } = deps({}, answers, undefined, { states: ["merged"] });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "cancelled", verdict: null, error: "The pull or merge request was closed or merged", title: "Add b and c" });
    expect(stored.resolvedConfig).toMatchObject({ config: { triggers: { abortOnClose: true } } });
    expect(model.requests).toHaveLength(0);
    expect(published).toEqual({ inline: [], summaries: [], statuses: [], descriptions: [], labels: [], threads: [] });
  });

  it("publishes nothing when the change closes during the review", async () => {
    const job = await claimedJob();
    const { runDeps, model, published } = deps({}, answers, undefined, { states: ["open", "closed"] });

    await runJob(job, runDeps);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
    expect(model.requests.length).toBeGreaterThan(0);
    // Only the progress note and the pending status went out; both are closed off.
    expect(published.inline).toEqual([]);
    expect(published.summaries).toHaveLength(2);
    expect(published.summaries[1]).toContain("Review cancelled");
    expect(published.summaries[1]).toContain("The pull or merge request was closed or merged");
    expect(published.statuses).toEqual(["pending", "error"]);
  });

  it("hands model calls a signal the watch fires on close", async () => {
    const job = await claimedJob();
    const { runDeps, model } = deps({}, answers, undefined, { states: ["open", "closed"] });
    runDeps.closeCheckIntervalMs = 5;
    const signals: (AbortSignal | undefined)[] = [];
    runDeps.generateFor = () => async (request) => {
      signals.push(request.abortSignal);
      // Slower than the watch, so the close lands mid-call.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return model.generate(request);
    };

    await runJob(job, runDeps);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  it("finishes the review when abort on close is off", async () => {
    await prisma.repository.update({ where: { id: repositoryId }, data: { settings: { triggers: { abortOnClose: false } } } });
    const job = await claimedJob();
    const { runDeps, published } = deps({}, answers, undefined, { states: ["closed"] });

    await runJob(job, runDeps);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("completed");
    expect(published.inline).toHaveLength(1);
  });

  it("keeps a job cancelled from elsewhere cancelled", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, answers);
    runDeps.generateFor = () => async () => {
      await prisma.reviewJob.update({ where: { id: job.id }, data: { status: "cancelled" } });
      throw new Error("aborted");
    };

    await runJob(job, runDeps);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
    expect(await prisma.finding.count()).toBe(0);
  });
});

describe("runJob when cancelled from the dashboard", () => {
  const answers = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };

  for (const abortOnClose of [true, false]) {
    it(`stops model calls and publishes nothing with abort on close ${abortOnClose ? "on" : "off"}`, async () => {
      await prisma.repository.update({ where: { id: repositoryId }, data: { settings: { triggers: { abortOnClose } } } });
      const job = await claimedJob();
      const { runDeps, model, published } = deps({}, answers);
      runDeps.closeCheckIntervalMs = 5;
      const signals: (AbortSignal | undefined)[] = [];
      runDeps.generateFor = () => async (request) => {
        signals.push(request.abortSignal);
        await cancelJob(job.id, workspaceId, "Cancelled by Dev");
        // Slower than the watch, so the cancel lands mid-call.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return model.generate(request);
      };

      await runJob(job, runDeps);

      const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(stored).toMatchObject({ status: "cancelled", verdict: null, error: "Cancelled by Dev" });
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal?.aborted)).toBe(true);
      expect(published.inline).toEqual([]);
      // The progress note is replaced so it no longer promises a review.
      expect(published.summaries).toHaveLength(2);
      expect(published.summaries[1]).toContain("Review cancelled");
      expect(published.statuses).toEqual(["pending", "error"]);
    });
  }
});

describe("runJob when the repository is turned off", () => {
  const answers = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };

  it("skips a job claimed after the repository was turned off, without reading the change", async () => {
    const job = await claimedJob();
    await prisma.repository.update({ where: { id: repositoryId }, data: { enabled: false } });
    const { runDeps, reads, model, published } = deps({}, answers);

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({
      status: "skipped",
      verdict: null,
      error: "Reviews were turned off for this repository",
      lockedAt: null,
    });
    expect(reads).toEqual([]);
    expect(model.requests).toHaveLength(0);
    expect(published).toEqual({ inline: [], summaries: [], statuses: [], descriptions: [], labels: [], threads: [] });
  });

  it("skips with the access-loss reason when the repository was turned off for lost access", async () => {
    const job = await claimedJob();
    await prisma.repository.update({ where: { id: repositoryId }, data: { enabled: false, accessLostAt: new Date() } });
    const { runDeps, reads } = deps({}, answers);

    await runJob(job, runDeps);

    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "skipped",
      error: "Sentryward lost access to this repository",
    });
    expect(reads).toEqual([]);
  });

  it("stops and publishes no review when the repository is turned off mid-review", async () => {
    const job = await claimedJob();
    const { runDeps, model, published } = deps({}, answers);
    runDeps.closeCheckIntervalMs = 5;
    runDeps.generateFor = () => async (request) => {
      await cancelForDisabledRepositories([repositoryId], DISABLED_REASON);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return model.generate(request);
    };

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "cancelled", verdict: null, error: "Reviews were turned off for this repository" });
    expect(published.inline).toEqual([]);
    expect(published.summaries).toHaveLength(2);
    expect(published.summaries[1]).toContain("Reviews were turned off for this repository");
    // Success, not error: no later review would ever clear a required check.
    expect(published.statuses).toEqual(["pending", "success"]);
  });

  it("stops publishing when the repository is turned off partway through", async () => {
    const job = await claimedJob();
    const { runDeps, published } = deps({}, answers);
    const forge = runDeps.adapterFor(null as never);
    const post = forge.postInlineComments.bind(forge);
    forge.postInlineComments = async (ref, comments) => {
      const outcome = await post(ref, comments);
      await cancelForDisabledRepositories([repositoryId], DISABLED_REASON);
      return outcome;
    };

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "cancelled", verdict: null, error: "Reviews were turned off for this repository" });
    // The inline comment already sent is recorded so a later run does not repost it.
    expect(published.inline).toHaveLength(1);
    expect(await prisma.postedFinding.count({ where: { repositoryId } })).toBe(1);
    // No final review status; the summary is replaced by the cancelled note.
    expect(published.statuses).toEqual(["pending", "success"]);
    expect(published.summaries.at(-1)).toContain("Reviews were turned off for this repository");
    // The run no longer speaks for the change, so findings are not synced.
    expect(await prisma.finding.count()).toBe(0);
  });
});

describe("runJob when the forge refuses the connection's credentials", () => {
  const answers = { code_review: { findings: [] } };
  let connectionId: string;

  beforeEach(async () => {
    const repo = await prisma.repository.findUniqueOrThrow({ where: { id: repositoryId } });
    connectionId = repo.connectionId;
    await prisma.forgeConnection.update({
      where: { id: connectionId },
      data: { kind: "token", installationId: null, encryptedToken: "x" },
    });
  });

  const rejectedAt = async () =>
    (await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connectionId } })).credentialsRejectedAt;

  it("fails the job with a reconnect reason and flags the connection", async () => {
    const job = await claimedJob();
    const { runDeps, model } = deps({}, answers, undefined, { changeError: new ForgeError(401, "401 Unauthorized") });
    const checked: string[] = [];
    runDeps.credentialsRefused = async (connection) => {
      checked.push(connection.id);
      return true;
    };

    await expect(runJob(job, runDeps)).rejects.toThrow(/rejected this connection's credentials/);

    expect(checked).toEqual([connectionId]);
    expect(await rejectedAt()).toBeInstanceOf(Date);
    expect(model.requests).toHaveLength(0);
  });

  it("does not flag the connection when only this change is refused", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, answers, undefined, { changeError: new ForgeError(404, "404 Not Found") });
    runDeps.credentialsRefused = async () => false;

    await expect(runJob(job, runDeps)).rejects.toThrow("404 Not Found");
    expect(await rejectedAt()).toBeNull();
  });

  it("does not check the credentials for a rate limit answered with 403", async () => {
    const job = await claimedJob();
    const changeError = new ForgeError(403, "403 rate limit", { rateLimited: true });
    const { runDeps } = deps({}, answers, undefined, { changeError });
    runDeps.credentialsRefused = async () => {
      throw new Error("should not be called");
    };

    await expect(runJob(job, runDeps)).rejects.toThrow("403 rate limit");
    expect(await rejectedAt()).toBeNull();
  });

  it("does not flag a connection that was reconnected while the check ran", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, answers, undefined, { changeError: new ForgeError(401, "401 Unauthorized") });
    // The user connects the account again with a new token mid-check; the
    // refusal was for the old one.
    runDeps.credentialsRefused = async () => {
      await prisma.forgeConnection.update({
        where: { id: connectionId },
        data: { encryptedToken: "new", credentialsRejectedAt: null },
      });
      return true;
    };

    await expect(runJob(job, runDeps)).rejects.toThrow(/rejected this connection's credentials/);
    expect(await rejectedAt()).toBeNull();
  });

  it("does not check the credentials of a GitHub App connection", async () => {
    await prisma.forgeConnection.update({
      where: { id: connectionId },
      data: { kind: "github_app", installationId: "55", encryptedToken: null },
    });
    const job = await claimedJob();
    const { runDeps } = deps({}, answers, undefined, { changeError: new ForgeError(404, "404 Not Found") });
    runDeps.credentialsRefused = async () => {
      throw new Error("should not be called");
    };

    await expect(runJob(job, runDeps)).rejects.toThrow("404 Not Found");
  });

  it("does not check the credentials for an error that is not a refusal", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, answers, undefined, { changeError: new ForgeError(502, "502 Bad Gateway") });
    runDeps.credentialsRefused = async () => {
      throw new Error("should not be called");
    };

    await expect(runJob(job, runDeps)).rejects.toThrow("502 Bad Gateway");
    expect(await rejectedAt()).toBeNull();
  });

  it("skips a webhook job queued before the flag, without reading the change", async () => {
    await enqueue({ repositoryId, number: 42, headSha: "oldhead", trigger: "webhook" });
    const job = (await claimNext())!;
    await prisma.forgeConnection.update({ where: { id: connectionId }, data: { credentialsRejectedAt: new Date() } });
    const { runDeps, reads, model } = deps({}, answers);

    await runJob(job, runDeps);

    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "skipped",
      error: "The forge rejected this connection's credentials; connect the account again to resume reviews",
    });
    expect(reads).toEqual([]);
    expect(model.requests).toHaveLength(0);
  });

  it("still runs a manual review, and clears the flag once the forge answers", async () => {
    await prisma.forgeConnection.update({ where: { id: connectionId }, data: { credentialsRejectedAt: new Date() } });
    const job = await claimedJob();
    const { runDeps } = deps({}, answers);

    await runJob(job, runDeps);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("completed");
    expect(await rejectedAt()).toBeNull();
  });
});

describe("runJob when it loses its claim", () => {
  const answers = { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH };

  it("stops and publishes nothing once the worker failed it on timeout", async () => {
    const job = await claimedJob();
    const { runDeps, model, published } = deps({}, answers);
    runDeps.closeCheckIntervalMs = 5;
    const signals: (AbortSignal | undefined)[] = [];
    runDeps.generateFor = () => async (request) => {
      signals.push(request.abortSignal);
      await fail(job.id, "Review exceeded the maximum run time");
      // Slower than the watch, so the loss is noticed mid-call.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return model.generate(request);
    };

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "failed", error: "Review exceeded the maximum run time" });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    expect(published.inline).toEqual([]);
    expect(published.summaries).toHaveLength(1);
    expect(published.statuses).toEqual(["pending"]);
    expect(await prisma.finding.count()).toBe(0);
  });

  it("leaves a job another worker re-claimed to that worker", async () => {
    const job = await claimedJob();
    const { runDeps, model, published } = deps({}, answers);
    runDeps.closeCheckIntervalMs = 5;
    runDeps.generateFor = () => async (request) => {
      // Recovery requeued it and another worker claimed it again.
      await prisma.reviewJob.update({ where: { id: job.id }, data: { attempts: job.attempts + 1 } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return model.generate(request);
    };

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored).toMatchObject({ status: "running", attempts: job.attempts + 1, finishedAt: null });
    expect(published.inline).toEqual([]);
    expect(published.statuses).toEqual(["pending"]);
  });
});

describe("runJob issues and cache", () => {
  const issue = (ref: string, title: string): IssueContext => ({ ref, title, state: "open", body: `${title} body`, url: `https://github.com/acme/web/issues/${ref.slice(1)}` });

  it("hands linked and related issues to the walkthrough, minus duplicates", async () => {
    const job = await claimedJob();
    const { runDeps, model, reads } = deps(
      {},
      {
        code_review: { findings: [] },
        walkthrough: {
          ...WALKTHROUGH,
          linkedIssues: [{ ref: "#5", assessment: "addressed", note: "Done." }],
          relatedIssues: [{ ref: "#9", reason: "Same parser." }, { ref: "#404", reason: "Invented." }],
        },
      },
      undefined,
      {
        title: "Rework parser tokenizer",
        issues: { linked: [issue("#5", "Parser crash")], found: [issue("#5", "Parser crash"), issue("#9", "Tokenizer speed")] },
      },
    );

    await runJob(job, runDeps);

    expect(reads).toContain("search:rework parser tokenizer");
    const prompt = model.requests.find((r) => r.schemaName === "walkthrough")!.prompt;
    expect(prompt).toContain("Linked issues:\n#5 (open)");
    expect(prompt).toContain("Candidate issues:\n#9 (open)");
    expect(prompt.match(/#5 \(open\)/g)).toHaveLength(1);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    const walkthrough = (stored.result as { walkthrough: Record<string, unknown> }).walkthrough;
    // Bodies are prompt context only; issues the forge did not return are dropped.
    expect(walkthrough.linkedIssues).toEqual([
      { ref: "#5", title: "Parser crash", state: "open", url: "https://github.com/acme/web/issues/5", assessment: "addressed", note: "Done." },
    ]);
    expect(walkthrough.relatedIssues).toEqual([{ ref: "#9", title: "Tokenizer speed", state: "open", url: "https://github.com/acme/web/issues/9", reason: "Same parser." }]);
  });

  it("reads through the cache unless the repository disables it", async () => {
    const cache = new ForgeCache();
    const job = await claimedJob();
    const cached = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, undefined, { cache });
    await runJob(job, cached.runDeps);
    expect(cached.reads[0]).toBe("change:cached");
    // The change, the (missing) repository file and the changed file at head.
    expect(cache.size).toBe(3);
    const again = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, undefined, { cache });
    await runJob(await claimedJob(), again.runDeps);
    expect(again.reads.filter((read) => read.startsWith("newhead:"))).toEqual([]);

    // Turned off by the repository file: the cached read is redone fresh. (A
    // file at a sha never changes, so a new one needs an emptied cache here.)
    cache.clear();
    const second = await claimedJob();
    const fresh = deps({ "base:.sentryward.yaml": "review:\n  disable_cache: true\n" }, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, undefined, { cache });
    await runJob(second, fresh.runDeps);
    expect(fresh.reads.filter((read) => read.startsWith("change"))).toEqual(["change:cached", "change"]);

    // Turned off in the dashboard: nothing goes through the cache at all.
    await prisma.repository.update({ where: { id: repositoryId }, data: { settings: { review: { disableCache: true } } } });
    const third = await claimedJob();
    const none = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH }, undefined, { cache });
    await runJob(third, none.runDeps);
    expect(none.reads.filter((read) => read.startsWith("change"))).toEqual(["change"]);
    expect(none.reads.filter((read) => read.startsWith("newhead:"))).toEqual(["newhead:src/app.ts"]);
  });
});

describe("runJob with the global config", () => {
  it("applies the owner's global config beneath the repository settings", async () => {
    const repo = await prisma.repository.findUniqueOrThrow({ where: { id: repositoryId }, include: { connection: true } });
    await prisma.workspace.update({
      where: { id: repo.connection.workspaceId },
      data: { reviewSettings: { llm: { connection: "anthropic" }, review: { blockOn: "minor", maxFindings: 5 } } },
    });
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.resolvedConfig).toMatchObject({
      config: { review: { blockOn: "major", maxFindings: 5 } },
      sources: { "review.blockOn": "repoSettings", "review.maxFindings": "global" },
    });
  });

  it("ignores the repository settings while the repository follows the global config", async () => {
    const repo = await prisma.repository.update({ where: { id: repositoryId }, data: { followGlobal: true }, include: { connection: true } });
    await prisma.workspace.update({
      where: { id: repo.connection.workspaceId },
      data: { reviewSettings: { llm: { connection: "anthropic" }, review: { blockOn: "minor" } } },
    });
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: { findings: [] }, walkthrough: WALKTHROUGH });

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.resolvedConfig).toMatchObject({
      config: { review: { blockOn: "minor" } },
      sources: { "review.blockOn": "global" },
    });
  });
});

describe("skipReason", () => {
  const triggers = (t: Partial<typeof DEFAULT_CONFIG.triggers>) => ({ ...DEFAULT_CONFIG, triggers: { ...DEFAULT_CONFIG.triggers, ...t } });
  const change = (c: Partial<ReturnType<typeof makeChangeSet>> = {}) => ({ ...makeChangeSet(), ...c });
  const opened = { trigger: "webhook" as const, event: "open", actor: null };
  const pushed = { trigger: "webhook" as const, event: "push", actor: null };

  it("follows the code review trigger for automatic reviews", () => {
    expect(skipReason(opened, DEFAULT_CONFIG, change({ isDraft: true }))).toMatch(/Draft/);
    expect(skipReason(opened, DEFAULT_CONFIG, change())).toBeNull();
    expect(skipReason(opened, triggers({ review: "all" }), change({ isDraft: true }))).toBeNull();
    expect(skipReason(opened, triggers({ review: "manual" }), change())).toMatch(/turned off/);
    expect(skipReason(pushed, triggers({ review: "manual" }), change())).toMatch(/turned off/);
  });

  it("reviews new commits only while review on push is on", () => {
    expect(skipReason(pushed, DEFAULT_CONFIG, change())).toBeNull();
    expect(skipReason(pushed, triggers({ reviewOnPush: false }), change())).toMatch(/New commits/);
    expect(skipReason(opened, triggers({ reviewOnPush: false }), change())).toBeNull();
  });

  it("applies the skip lists to automatic reviews only", () => {
    const skipAll = triggers({ ignoreTitles: ["wip"], skipAuthors: ["dependabot"] });
    expect(skipReason(opened, skipAll, change({ title: "WIP: add b" }))).toMatch(/title contains "wip"/);
    expect(skipReason(opened, skipAll, change({ author: "Dependabot" }))).toMatch(/Dependabot/);
    expect(skipReason({ ...pushed, actor: "dependabot" }, skipAll, change({ author: "alice" }))).toMatch(/dependabot/);
    expect(skipReason({ trigger: "manual" }, skipAll, change({ title: "WIP" }))).toBeNull();
    expect(skipReason({ trigger: "comment" }, skipAll, change({ title: "WIP" }))).toBeNull();
  });

  it("honours the command switch and never skips a manual review", () => {
    expect(skipReason({ trigger: "comment" }, triggers({ command: false }), change())).toMatch(/commands/);
    expect(skipReason({ trigger: "comment" }, DEFAULT_CONFIG, change({ isDraft: true }))).toBeNull();
    expect(skipReason({ trigger: "manual" }, triggers({ review: "manual", command: false }), change({ isDraft: true }))).toBeNull();
  });
});

describe("walkthroughEnabled", () => {
  const withTriggers = (summary: "manual" | "published") => ({
    ...DEFAULT_CONFIG,
    triggers: { ...DEFAULT_CONFIG.triggers, summary },
  });

  it("limits automatic summaries to published changes, or none when manual", () => {
    expect(walkthroughEnabled("webhook", withTriggers("published"), false)).toBe(true);
    expect(walkthroughEnabled("webhook", withTriggers("published"), true)).toBe(false);
    expect(walkthroughEnabled("webhook", withTriggers("manual"), false)).toBe(false);
    expect(walkthroughEnabled("manual", withTriggers("manual"), true)).toBe(true);
    expect(walkthroughEnabled("comment", { ...DEFAULT_CONFIG, output: { ...DEFAULT_CONFIG.output, walkthrough: false } }, false)).toBe(false);
  });
});

describe("runJob with automatic triggers", () => {
  it("records a skipped webhook job without calling the model or the forge", async () => {
    await enqueue({ repositoryId, number: 42, headSha: "oldhead", trigger: "webhook" });
    const job = (await claimNext())!;
    const { runDeps, model, published } = deps({ "base:.sentryward.yaml": "triggers:\n  on_push: false\n" }, {});

    await runJob(job, runDeps);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    // No summary, but the title is stored so the run can be searched for.
    expect(stored).toMatchObject({ status: "skipped", verdict: null, result: null, summary: null, title: "Add b and c" });
    expect(stored.error).toMatch(/turned off/);
    expect(model.requests).toHaveLength(0);
    expect(published).toEqual({ inline: [], summaries: [], statuses: [], descriptions: [], labels: [], threads: [] });
  });
});

describe("runJob on a push after a completed review", () => {
  // Two files: the push below touches only src/util.ts.
  const UTIL_PATCH = ["@@ -1,2 +1,3 @@", " export const x = 1;", "+export const y = x / 0;", " export const z = 2;"].join("\n");
  const FILES: FileDiffInput[] = [
    { path: "src/app.ts", changeType: "modified", patch: APP_PATCH },
    { path: "src/util.ts", changeType: "modified", patch: UTIL_PATCH },
  ];
  const appFinding = modelFinding();
  const utilFinding = modelFinding({ file: "src/util.ts", startLine: 2, endLine: 2, title: "y divides by zero" });
  const both = { code_review: { findings: [appFinding, utilFinding] }, walkthrough: WALKTHROUGH };
  const fixed = { code_review: { findings: [] }, walkthrough: WALKTHROUGH };

  async function reviewFirst() {
    const first = deps({}, both, { anthropic: "k" }, { head: "h1", files: FILES });
    await enqueue({ repositoryId, number: 42, headSha: "h1", trigger: "manual" });
    await runJob((await claimNext())!, first.runDeps);
    expect(first.published.inline).toHaveLength(2);
  }

  async function push(head: string) {
    await enqueue({ repositoryId, number: 42, headSha: head, trigger: "webhook", event: "push" });
    const job = (await claimNext())!;
    return { job, stored: () => prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } }) };
  }

  function reviewPrompts(model: { requests: { schemaName: string; prompt: string }[] }) {
    return model.requests.filter((r) => r.schemaName === "code_review").map((r) => r.prompt).join("\n");
  }

  it("reviews only the files changed since then and keeps the other findings open", async () => {
    await reviewFirst();
    const second = deps({}, fixed, { anthropic: "k" }, { head: "h2", files: FILES, compare: ["src/util.ts"] });
    const { job, stored } = await push("h2");

    await runJob(job, second.runDeps);

    expect(second.reads).toContain("compare:h1..h2");
    const prompts = reviewPrompts(second.model);
    expect(prompts).toContain("export const y = x / 0;");
    expect(prompts).not.toContain("const b = a + 1;");
    const result = (await stored()).result as { status: string; findings: { file: string }[]; incremental: unknown };
    expect(result.status).toBe("completed");
    expect(result.incremental).toEqual({ fromSha: "h1", toSha: "h2", files: ["src/util.ts"], carried: 1 });
    expect(result.findings.map((f) => f.file)).toEqual(["src/app.ts"]);
    // The carried blocker still blocks, and nothing is posted twice.
    expect((await stored()).verdict).toBe("blocked");
    expect(second.published.inline).toEqual([]);
    expect(second.published.summaries.at(-1)).toContain("Incremental review of `h1..h2`");
    const rows = await prisma.finding.findMany({ where: { repositoryId, number: 42 }, orderBy: { file: "asc" } });
    expect(rows.map((row) => [row.file, row.state])).toEqual([
      ["src/app.ts", "open"],
      ["src/util.ts", "resolved"],
    ]);
  });

  it("reviews everything again after a force push", async () => {
    await reviewFirst();
    const second = deps({}, both, { anthropic: "k" }, { head: "h2", files: FILES, compare: null });
    const { job, stored } = await push("h2");

    await runJob(job, second.runDeps);

    expect(reviewPrompts(second.model)).toContain("const b = a + 1;");
    const result = (await stored()).result as { incremental?: unknown; warnings: string[] };
    expect(result.incremental).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/no longer an ancestor/);
  });

  it("reviews everything when the comparison fails", async () => {
    await reviewFirst();
    const second = deps({}, both, { anthropic: "k" }, { head: "h2", files: FILES, compare: new Error("502 Bad Gateway") });
    const { job, stored } = await push("h2");

    await runJob(job, second.runDeps);

    const result = (await stored()).result as { incremental?: unknown; warnings: string[] };
    expect(result.incremental).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/could not be compared: 502/);
  });

  it("reviews everything when full reviews on push are configured", async () => {
    await reviewFirst();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { review: { blockOn: "major" }, triggers: { fullReviewOnPush: true } } },
    });
    const second = deps({}, both, { anthropic: "k" }, { head: "h2", files: FILES, compare: ["src/util.ts"] });
    const { job } = await push("h2");

    await runJob(job, second.runDeps);

    expect(second.reads.filter((read) => read.startsWith("compare:"))).toEqual([]);
    expect(reviewPrompts(second.model)).toContain("const b = a + 1;");
  });

  it("reviews everything when someone asks for it", async () => {
    await reviewFirst();
    const second = deps({}, both, { anthropic: "k" }, { head: "h2", files: FILES, compare: ["src/util.ts"] });
    await enqueue({ repositoryId, number: 42, headSha: "h2", trigger: "comment" });

    await runJob((await claimNext())!, second.runDeps);

    expect(second.reads.filter((read) => read.startsWith("compare:"))).toEqual([]);
    expect(reviewPrompts(second.model)).toContain("const b = a + 1;");
  });

  it("reviews everything when the last review was partial", async () => {
    await reviewFirst();
    const last = await prisma.reviewJob.findFirstOrThrow({ where: { repositoryId, headSha: "h1" } });
    await prisma.reviewJob.update({
      where: { id: last.id },
      data: { result: { ...(last.result as object), status: "partial" } },
    });
    const second = deps({}, both, { anthropic: "k" }, { head: "h2", files: FILES, compare: ["src/util.ts"] });
    const { job } = await push("h2");

    await runJob(job, second.runDeps);

    expect(second.reads.filter((read) => read.startsWith("compare:"))).toEqual([]);
    expect(reviewPrompts(second.model)).toContain("const b = a + 1;");
  });

  it("does not carry a finding dismissed since the last review", async () => {
    await reviewFirst();
    await prisma.finding.updateMany({
      where: { repositoryId, number: 42, file: "src/app.ts" },
      data: { state: "ignored", ignoredAt: new Date(), ignoreReason: "false_positive" },
    });
    const second = deps({}, fixed, { anthropic: "k" }, { head: "h2", files: FILES, compare: ["src/util.ts"] });
    const { job, stored } = await push("h2");

    await runJob(job, second.runDeps);

    const result = (await stored()).result as { findings: unknown[]; incremental: { carried: number } };
    expect(result.findings).toEqual([]);
    expect(result.incremental.carried).toBe(0);
  });

  it("still reviews incrementally after a review stored before rules existed", async () => {
    await reviewFirst();
    const last = await prisma.reviewJob.findFirstOrThrow({ where: { repositoryId, headSha: "h1" } });
    const resolved = structuredClone(last.resolvedConfig) as { config: { rules?: unknown } };
    delete resolved.config.rules;
    await prisma.reviewJob.update({ where: { id: last.id }, data: { resolvedConfig: resolved as object } });
    const second = deps({}, fixed, { anthropic: "k" }, { head: "h2", files: FILES, compare: ["src/util.ts"] });
    const { job, stored } = await push("h2");

    await runJob(job, second.runDeps);

    expect(second.reads).toContain("compare:h1..h2");
    expect(((await stored()).result as { incremental?: unknown }).incremental).toBeDefined();
  });

  it("still reviews incrementally after a review stored before impact depth existed", async () => {
    await reviewFirst();
    const last = await prisma.reviewJob.findFirstOrThrow({ where: { repositoryId, headSha: "h1" } });
    const resolved = structuredClone(last.resolvedConfig) as { config: { review: { impactDepth?: number } } };
    delete resolved.config.review.impactDepth;
    await prisma.reviewJob.update({ where: { id: last.id }, data: { resolvedConfig: resolved as object } });
    const second = deps({}, fixed, { anthropic: "k" }, { head: "h2", files: FILES, compare: ["src/util.ts"] });
    const { job, stored } = await push("h2");

    await runJob(job, second.runDeps);

    expect(second.reads).toContain("compare:h1..h2");
    expect(((await stored()).result as { incremental?: unknown }).incremental).toBeDefined();
  });

  it("keeps the areas the last review reached through callers", async () => {
    await reviewFirst();
    const last = await prisma.reviewJob.findFirstOrThrow({ where: { repositoryId, headSha: "h1" } });
    const reached = { kind: "api", path: "src/routes/r.ts", reason: "calls run2, 2 hops from the change", via: "main -> run2" };
    const previous = last.result as { walkthrough?: Record<string, unknown> };
    expect(previous.walkthrough).toBeDefined();
    await prisma.reviewJob.update({
      where: { id: last.id },
      data: { result: { ...previous, walkthrough: { ...previous.walkthrough, riskyAreas: [reached] } } as object },
    });
    const second = deps({}, fixed, { anthropic: "k" }, { head: "h2", files: FILES, compare: ["src/util.ts"] });
    const { job, stored } = await push("h2");

    await runJob(job, second.runDeps);

    const result = (await stored()).result as { incremental?: unknown; walkthrough: { riskyAreas?: unknown[]; blastRadius?: string } };
    expect(result.incremental).toBeDefined();
    expect(result.walkthrough.riskyAreas).toContainEqual(reached);
    expect(result.walkthrough.blastRadius).not.toBe("small");
  });

  it.each([
    ["the model settings", { llm: { temperature: 0.7 } }],
    ["the ignored paths", { ignorePaths: ["src/app.ts"] }],
  ])("reviews everything when %s changed since the last review", async (_, change) => {
    await reviewFirst();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { review: { blockOn: "major" }, ...change } },
    });
    const second = deps({}, fixed, { anthropic: "k" }, { head: "h2", files: FILES, compare: ["src/util.ts"] });
    const { job, stored } = await push("h2");

    await runJob(job, second.runDeps);

    expect(second.reads.filter((read) => read.startsWith("compare:"))).toEqual([]);
    const result = (await stored()).result as { incremental?: unknown; warnings: string[] };
    expect(result.incremental).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/review settings changed/);
    expect((await stored()).verdict).not.toBe("blocked");
  });
});

describe("privacy policy", () => {
  const policy = (instance: Partial<PolicyLayer> = {}, workspace: Partial<PolicyLayer> = {}) => async () =>
    mergePolicy(
      { ...OPEN_LAYER, auditRetentionDays: null, retentionSource: null, ...instance },
      { ...OPEN_LAYER, ...workspace },
    );
  const publicDns = async () => [{ address: "104.18.1.1" }];
  const auditRows = (jobId: string) => prisma.llmRequestLog.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });

  it("fails before posting anything when the review model's provider is not allowed", async () => {
    const job = await claimedJob();
    const { runDeps, model, published } = deps({}, { code_review: { findings: [] } });

    await expect(
      runJob(job, { ...runDeps, policyFor: policy({ allowedProviders: ["openai"] }) }),
    ).rejects.toThrow(/^Blocked by privacy policy: provider "anthropic" \(model anthropic\/.+\) is not allowed by the instance settings/);
    expect(model.requests).toHaveLength(0);
    expect(published.summaries).toEqual([]);
    expect(published.statuses).toEqual([]);
  });

  it("refuses an official API host in local-only mode", async () => {
    const job = await claimedJob();
    const { runDeps, model } = deps({}, { code_review: { findings: [] } });

    await expect(
      runJob(job, { ...runDeps, policyFor: policy({}, { localOnly: true }), resolveHost: publicDns }),
    ).rejects.toThrow(/local-only mode is on, and model anthropic\/.+ would send requests to api\.anthropic\.com/);
    expect(model.requests).toHaveLength(0);
  });

  it("runs against an internal endpoint in local-only mode", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: { findings: [] } });

    await runJob(job, {
      ...runDeps,
      credentialsFor: async () => ({
        keys: {},
        baseUrls: {},
        connections: { anthropic: { apiKey: "k", baseUrl: "http://llm.internal:4000/v1" } },
      }),
      policyFor: policy({ localOnly: true }),
      resolveHost: async () => [{ address: "10.0.0.8" }],
    });

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("completed");
    const review = (await auditRows(job.id)).find((row) => row.purpose === "review");
    expect(review).toMatchObject({ host: "llm.internal:4000", outcome: "ok" });
  });

  it("leaves out a fallback the policy refuses, with a warning", async () => {
    const job = await claimedJob();
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { settings: { llm: { fallbackModels: ["openai/gpt-5"] } } },
    });
    const { runDeps } = deps({}, { code_review: { findings: [] } });

    await runJob(job, {
      ...runDeps,
      credentialsFor: async () => ({
        keys: {},
        baseUrls: {},
        connections: { anthropic: { apiKey: "k", baseUrl: "https://proxy.example.com/v1" } },
      }),
      policyFor: policy({}, { allowedProviders: ["anthropic"] }),
    });

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    const result = stored.result as unknown as ReviewResult;
    expect(result.warnings.join("\n")).toContain(
      "Fallback model openai/gpt-5 skipped: Blocked by privacy policy: provider \"openai\"",
    );
    expect((stored.resolvedConfig as { config: { llm: { fallbackModels: string[] } } }).config.llm.fallbackModels).toEqual([
      "openai/gpt-5",
    ]);
  });

  it("records each model request in the audit log without any code", async () => {
    const job = await claimedJob();
    const { runDeps } = deps(
      { "base:.sentryward.yaml": "output:\n  walkthrough: true\n" },
      { code_review: { findings: [modelFinding()] }, walkthrough: WALKTHROUGH },
    );

    await runJob(job, runDeps);

    const rows = await auditRows(job.id);
    expect(rows.map((row) => row.purpose).sort()).toEqual(["review", "verify", "walkthrough"]);
    expect(rows.find((row) => row.purpose === "review")).toMatchObject({
      workspaceId,
      workspaceName: "W",
      repositoryId,
      repository: "github.com/acme/web",
      changeNumber: 42,
      provider: "anthropic",
      host: "api.anthropic.com",
      inputTokens: 100,
      outputTokens: 20,
      outcome: "ok",
      errorKind: null,
    });
    const text = JSON.stringify(rows);
    expect(text).not.toContain("overflows");
    expect(text).not.toContain("src/app.ts");
  });

  it("records a failed request by its kind, never its message", async () => {
    const job = await claimedJob();
    const { runDeps } = deps({}, { code_review: new Error("provider down: const secret = 1") });

    await runJob(job, runDeps);

    const row = (await auditRows(job.id)).find((r) => r.purpose === "review");
    expect(row).toMatchObject({ purpose: "review", outcome: "failed", errorKind: "error", inputTokens: 0 });
    expect(JSON.stringify(row)).not.toContain("secret");
  });
});
