import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../src/generated/prisma/client.ts";
import { app } from "../src/app.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { prisma } from "../src/lib/prisma.ts";
import { summarize } from "../src/review/render/json.ts";
import { toMarkdown } from "../src/review/render/markdown.ts";
import { claimNext, recordTitle } from "../src/worker/queue.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { sampleResult } from "./helpers/result.ts";
import { createTeam, createUser, inWorkspace } from "./helpers/users.ts";

let cookie: string;
let repoId: string;

const MR_URL = "https://gitlab.com/Team/Web/-/merge_requests/7";
const mrRoute = (sha = "abc123") => ({
  url: /\/api\/v4\/projects\/team%2Fweb\/merge_requests\/7$/,
  body: { state: "opened", sha, title: "T", diff_refs: { base_sha: "b", start_sha: "s", head_sha: sha } },
});

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const created = await createUser();
  cookie = created.cookie;
  const connection = await prisma.forgeConnection.create({
    data: {
      workspaceId: created.workspace.id,
      provider: "gitlab",
      host: "gitlab.com",
      kind: "token",
      accountLogin: "dev",
      encryptedToken: encrypt("glpat"),
    },
  });
  const repo = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "gitlab",
      host: "gitlab.com",
      fullPath: "team/web",
      externalId: "1",
      defaultBranch: "main",
      enabled: true,
    },
  });
  repoId = repo.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function completedJob(number = 7) {
  const result = await sampleResult();
  const job = await prisma.reviewJob.create({
    data: {
      repositoryId: repoId,
      number,
      headSha: "head",
      trigger: "manual",
      status: "completed",
      verdict: "blocked",
      result,
      summary: summarize(result) as object,
    },
  });
  // Written the way the worker writes it, so search tests cover that path.
  await recordTitle(job.id, result.change.title);
  return prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
}

describe("POST /api/reviews", () => {
  it("queues a review of the PR's current head", async () => {
    vi.stubGlobal("fetch", fetchStub([mrRoute("abc123")]).fetch);

    const res = await request(app).post("/api/reviews").set("Cookie", cookie).send({ url: MR_URL });

    expect(res.status).toBe(202);
    expect(res.body.review).toMatchObject({
      number: 7,
      headSha: "abc123",
      status: "queued",
      trigger: "manual",
      repository: { fullPath: "team/web" },
    });
  });

  it("returns the same job when that head is already queued", async () => {
    vi.stubGlobal("fetch", fetchStub([mrRoute()]).fetch);

    const first = await request(app).post("/api/reviews").set("Cookie", cookie).send({ url: MR_URL });
    const second = await request(app).post("/api/reviews").set("Cookie", cookie).send({ url: MR_URL });

    expect(second.body.review.id).toBe(first.body.review.id);
  });

  it("rejects a URL that is not a pull or merge request", async () => {
    const res = await request(app).post("/api/reviews").set("Cookie", cookie).send({ url: "https://gitlab.com/team/web" });
    expect(res.status).toBe(400);
  });

  it("404s for a repository that is not connected and 409s for a disabled one", async () => {
    const missing = await request(app)
      .post("/api/reviews")
      .set("Cookie", cookie)
      .send({ url: "https://gitlab.com/team/other/-/merge_requests/1" });
    expect(missing.status).toBe(404);

    await prisma.repository.update({ where: { id: repoId }, data: { enabled: false } });
    const disabled = await request(app).post("/api/reviews").set("Cookie", cookie).send({ url: MR_URL });
    expect(disabled.status).toBe(409);
  });

  it("does not let another user review through someone else's connection", async () => {
    const other = await createUser("other@example.com");
    const res = await request(app).post("/api/reviews").set("Cookie", other.cookie).send({ url: MR_URL });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/reviews by repository", () => {
  it("queues a review of a change picked from the repository", async () => {
    vi.stubGlobal("fetch", fetchStub([mrRoute("abc123")]).fetch);

    const res = await request(app).post("/api/reviews").set("Cookie", cookie).send({ repoId, number: 7 });

    expect(res.status).toBe(202);
    expect(res.body.review).toMatchObject({ number: 7, headSha: "abc123", trigger: "manual", status: "queued" });
  });

  it("validates the body", async () => {
    const res = await request(app).post("/api/reviews").set("Cookie", cookie).send({ repoId, number: 0 });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty("number");
  });

  it("409s for a disabled repository and 404s for another user's", async () => {
    await prisma.repository.update({ where: { id: repoId }, data: { enabled: false } });
    const disabled = await request(app).post("/api/reviews").set("Cookie", cookie).send({ repoId, number: 7 });
    expect(disabled.status).toBe(409);

    const other = await createUser("other@example.com");
    const foreign = await request(app).post("/api/reviews").set("Cookie", other.cookie).send({ repoId, number: 7 });
    expect(foreign.status).toBe(404);
  });
});

describe("GET /api/reviews", () => {
  it("lists newest first in pages with a total and without full results", async () => {
    for (const number of [1, 2, 3]) await completedJob(number);

    const first = await request(app).get("/api/reviews?limit=2").set("Cookie", cookie);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(first.body.reviews.map((r: { number: number }) => r.number)).toEqual([3, 2]);
    expect(first.body.reviews[0].result).toBeUndefined();
    expect(first.body.reviews[0].summary).toMatchObject({ total: 4, hasBlocking: true });

    const second = await request(app).get("/api/reviews?limit=2&page=2").set("Cookie", cookie);
    expect(second.body).toMatchObject({ total: 3, page: 2 });
    expect(second.body.reviews.map((r: { number: number }) => r.number)).toEqual([1]);

    const past = await request(app).get("/api/reviews?limit=2&page=3").set("Cookie", cookie);
    expect(past.body).toMatchObject({ reviews: [], total: 3 });
  });

  it("rejects a page below 1", async () => {
    const res = await request(app).get("/api/reviews?page=0").set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  it("filters by status and hides other users' reviews", async () => {
    await completedJob();
    const other = await createUser("other@example.com");

    expect((await request(app).get("/api/reviews?status=queued").set("Cookie", cookie)).body.reviews).toEqual([]);
    expect((await request(app).get("/api/reviews").set("Cookie", other.cookie)).body).toMatchObject({
      reviews: [],
      total: 0,
    });
  });
});

describe("GET /api/reviews filters", () => {
  const job = (data: Partial<Prisma.ReviewJobUncheckedCreateInput> & { number: number }) =>
    prisma.reviewJob.create({
      data: { repositoryId: repoId, headSha: "h", trigger: "manual", status: "completed", ...data },
    });
  const numbers = (res: request.Response) => res.body.reviews.map((r: { number: number }) => r.number);
  const get = (query: string) => request(app).get(`/api/reviews?${query}`).set("Cookie", cookie);

  it("filters by verdict, trigger and number", async () => {
    await job({ number: 1, verdict: "pass", trigger: "webhook" });
    await job({ number: 2, verdict: "blocked", trigger: "comment" });

    expect(numbers(await get("verdict=pass"))).toEqual([1]);
    expect(numbers(await get("trigger=comment"))).toEqual([2]);
    expect(numbers(await get("number=1"))).toEqual([1]);
  });

  it("searches the repository path, the title and a change number", async () => {
    await completedJob(12);
    await job({ number: 3 });

    expect((await get("q=TEAM/WE")).body.total).toBe(2);
    expect(numbers(await get("q=Add%20b"))).toEqual([12]);
    expect(numbers(await get("q=%2312"))).toEqual([12]);
    expect(numbers(await get("q=!3"))).toEqual([3]);
    expect((await get("q=nothing")).body.total).toBe(0);
  });

  it("searches titles in any case, in both views", async () => {
    await completedJob(12);
    await job({ number: 3, title: "Unrelated" });

    for (const q of ["add%20b%20and", "ADD%20B", "aDd%20B%20aNd%20C"]) {
      expect(numbers(await get(`q=${q}`))).toEqual([12]);
      expect(numbers(await get(`q=${q}&view=changes`))).toEqual([12]);
    }
  });

  it("finds a skipped run by title, though it has no summary", async () => {
    const skipped = await job({ number: 5, status: "skipped" });
    await recordTitle(skipped.id, "Fix login redirect");

    expect(numbers(await get("q=fix%20login"))).toEqual([5]);
    expect(numbers(await get("q=fix%20login&view=changes"))).toEqual([5]);
    expect((await get("q=fix%20login")).body.reviews[0]).toMatchObject({ title: "Fix login redirect", summary: null });
  });

  it("hides superseded runs unless asked for", async () => {
    // Explicit timestamps: back-to-back inserts can share a millisecond, and the
    // tiebreak on a random UUID would then make the order flaky.
    await job({ number: 1, status: "superseded", createdAt: new Date("2026-01-01") });
    await job({ number: 2, createdAt: new Date("2026-01-02") });

    expect(numbers(await get(""))).toEqual([2]);
    expect(numbers(await get("includeSuperseded=true"))).toEqual([2, 1]);
    expect(numbers(await get("status=superseded"))).toEqual([1]);
  });

  it("groups runs by change, newest change first, with a run count", async () => {
    await job({ number: 1, headSha: "a", createdAt: new Date("2026-01-01") });
    await job({ number: 2, headSha: "b", createdAt: new Date("2026-01-02") });
    await job({ number: 1, headSha: "c", status: "failed", createdAt: new Date("2026-01-03") });

    const first = await get("view=changes&limit=1");
    expect(first.body).toMatchObject({ total: 2, page: 1, limit: 1 });
    expect(first.body.reviews).toHaveLength(1);
    expect(first.body.reviews[0]).toMatchObject({ number: 1, headSha: "c", runCount: 2 });

    const second = await get("view=changes&limit=1&page=2");
    expect(second.body.reviews[0]).toMatchObject({ number: 2, headSha: "b", runCount: 1 });

    // Filters apply to runs before grouping.
    const completed = await get("view=changes&status=completed");
    expect(completed.body.reviews.map((r: { headSha: string }) => r.headSha)).toEqual(["b", "a"]);
  });

  it("counts changes the same way the runs view filters them", async () => {
    const { connectionId } = await prisma.repository.findUniqueOrThrow({ where: { id: repoId } });
    const other = await prisma.repository.create({
      data: {
        connectionId,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "team/api_v2",
        externalId: "2",
        defaultBranch: "main",
        enabled: true,
      },
    });
    await job({ number: 1, verdict: "pass", trigger: "webhook", title: "Fix login" });
    await job({ number: 1, status: "failed", verdict: "error", title: "Fix login" });
    await job({ number: 1, status: "superseded", title: "Fix login" });
    await job({ number: 2, verdict: "blocked", trigger: "comment", title: "Add 100% coverage" });
    await job({ number: 3, status: "superseded", title: "Drop cache" });
    await job({ repositoryId: other.id, number: 1, verdict: "pass", trigger: "webhook", title: "Fix logout" });
    await job({ repositoryId: other.id, number: 1, verdict: "pass", title: "Fix logout" });
    await job({ repositoryId: other.id, number: 2, status: "failed", title: "Rename user_id" });

    const queries = [
      "",
      "status=failed",
      "status=superseded",
      "includeSuperseded=true",
      "verdict=pass",
      "trigger=webhook",
      `repoId=${other.id}`,
      "number=1",
      "q=fix%20log",
      "q=API",
      "q=%232",
      "q=100%25",
      "q=user_id",
      // Wildcards in a search behave as they do for the page rows.
      "q=u_er",
      "q=1%25",
      `verdict=pass&trigger=webhook&q=fix&repoId=${repoId}`,
    ];
    for (const query of queries) {
      const runs = (await get(`${query}&limit=100`)).body.reviews as { number: number; repository: { id: string } }[];
      const changes = new Set(runs.map((r) => `${r.repository.id}:${r.number}`));
      expect((await get(`${query}&view=changes`)).body.total, query).toBe(changes.size);
    }
  });
});

describe("GET /api/reviews/stats", () => {
  it("counts recent runs, verdicts and review time for the owner only", async () => {
    const start = Date.now() - 3_600_000;
    const at = (seconds: number) => new Date(start + seconds * 1000);
    await completedJob(1);
    await prisma.reviewJob.createMany({
      data: [
        // A failed run's duration is left out of the median.
        { repositoryId: repoId, number: 2, headSha: "h", trigger: "manual", status: "failed", verdict: "error", startedAt: at(0), finishedAt: at(1) },
        { repositoryId: repoId, number: 3, headSha: "h", trigger: "manual", status: "completed", verdict: "pass", startedAt: at(0), finishedAt: at(60) },
        { repositoryId: repoId, number: 6, headSha: "h", trigger: "manual", status: "partial", verdict: "pass", startedAt: at(0), finishedAt: at(120) },
        { repositoryId: repoId, number: 4, headSha: "h", trigger: "manual", status: "superseded" },
        {
          repositoryId: repoId,
          number: 5,
          headSha: "h",
          trigger: "manual",
          status: "completed",
          verdict: "blocked",
          createdAt: new Date(Date.now() - 10 * 86_400_000),
        },
      ],
    });

    const res = await request(app).get("/api/reviews/stats").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      days: 7,
      runs: 4,
      blocked: 1,
      passed: 2,
      failed: 1,
      duration: { median: 90_000, max: 120_000 },
      // Only the completed job carries a summary digest; the bare rows add nothing.
      tokens: { calls: 2, unpricedCalls: 0, inputTokens: 200, outputTokens: 40 },
      // 200 input and 40 output tokens of claude-sonnet-5-5 at $2 / $10 per million,
      // recorded when the sample review ran.
      cost: { usd: 0.0008 },
    });

    expect((await request(app).get("/api/reviews/stats?days=30").set("Cookie", cookie)).body.runs).toBe(5);

    const other = await createUser("other@example.com");
    expect((await request(app).get("/api/reviews/stats").set("Cookie", other.cookie)).body.runs).toBe(0);
  });
});

describe("GET /api/reviews/attention", () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const failedRun = (number: number, finishedAt: Date, status: "failed" | "completed" = "failed") => ({
    repositoryId: repoId,
    number,
    headSha: "h",
    trigger: "manual" as const,
    status,
    verdict: status === "failed" ? ("error" as const) : ("pass" as const),
    finishedAt,
  });

  it("counts failed runs from the last day until the list is first viewed", async () => {
    await prisma.reviewJob.createMany({
      data: [
        failedRun(1, ago(3_600_000)),
        // Older than a day, or not failed: not flagged.
        failedRun(2, ago(2 * 86_400_000)),
        failedRun(3, ago(60_000), "completed"),
      ],
    });

    const res = await request(app).get("/api/reviews/attention").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.failed).toBe(1);

    const other = await createUser("other@example.com");
    expect((await request(app).get("/api/reviews/attention").set("Cookie", other.cookie)).body.failed).toBe(0);
  });

  it("only counts runs that failed after the last visit, per workspace", async () => {
    await prisma.reviewJob.create({ data: failedRun(1, ago(60_000)) });
    const user = await prisma.user.findFirstOrThrow({ where: { email: "dev@example.com" } });
    const team = await createTeam(user.id);

    expect((await request(app).post("/api/reviews/viewed").set("Cookie", cookie)).status).toBe(204);
    expect((await request(app).get("/api/reviews/attention").set("Cookie", cookie)).body.failed).toBe(0);

    // Queued before the visit, failed after it.
    await prisma.reviewJob.create({ data: failedRun(2, new Date(Date.now() + 1000)) });
    expect((await request(app).get("/api/reviews/attention").set("Cookie", cookie)).body.failed).toBe(1);

    // Viewing the personal workspace leaves the team's visit unrecorded.
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: user.id, workspaceId: team.id } },
    });
    expect(membership.reviewsViewedAt).toBeNull();
    const teamRes = await request(app)
      .get("/api/reviews/attention")
      .set("Cookie", cookie)
      .set(...inWorkspace(team.id));
    expect(teamRes.body.failed).toBe(0);
  });
});

describe("GET /api/reviews/stats cost", () => {
  async function run(number: number, summary: object) {
    await prisma.reviewJob.create({
      data: {
        repositoryId: repoId,
        number,
        headSha: "h",
        trigger: "manual",
        status: "completed",
        verdict: "pass",
        summary: { title: "T", total: 0, ...summary },
      },
    });
  }
  const cost = (total: number) => ({ input: total, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total });

  it("sums the costs reviews recorded per model, counting older digests' tokens at no cost", async () => {
    await run(1, {
      usageByModel: {
        "anthropic/a": { calls: 1, inputTokens: 60, outputTokens: 6, cost: cost(1) },
        "openai/b": { calls: 1, inputTokens: 40, outputTokens: 4, cost: cost(0.25) },
      },
    });
    await run(2, { usageByModel: { "anthropic/a": { calls: 1, inputTokens: 50, outputTokens: 5, cost: cost(0.5) } } });
    // A digest from before per-model usage and costs were recorded.
    await run(3, { usageTotals: { calls: 1, inputTokens: 1000, outputTokens: 100 } });

    const res = await request(app).get("/api/reviews/stats").set("Cookie", cookie);
    expect(res.body.tokens).toEqual({ calls: 4, unpricedCalls: 0, inputTokens: 1150, outputTokens: 115 });
    expect(res.body.cost).toEqual({ usd: 1.75 });
  });

  it("counts the calls no price was known for, so the cost can read as unknown", async () => {
    await run(1, { usageByModel: { "openai/my-proxy": { calls: 2, inputTokens: 60, outputTokens: 6, unpricedCalls: 2 } } });

    const res = await request(app).get("/api/reviews/stats").set("Cookie", cookie);
    expect(res.body.tokens).toMatchObject({ calls: 2, unpricedCalls: 2 });
    expect(res.body.cost).toEqual({ usd: 0 });
  });
});

describe("GET /api/reviews/:id and /markdown", () => {
  it("serves the result with its summary", async () => {
    const job = await completedJob();

    const res = await request(app).get(`/api/reviews/${job.id}`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.review.result.findings).toHaveLength(4);
    expect(res.body.review.result.summary.total).toBe(4);
    expect(res.body.review.result.usageTotals.calls).toBe(2);
    expect(res.body.review.result.usageTotals.costUsd).toBe(0.0008);
    expect(res.body.review.result.usage[0].cost.total).toBe(0.0004);
  });

  it("serves exactly the document toMarkdown renders", async () => {
    const job = await completedJob();

    const res = await request(app).get(`/api/reviews/${job.id}/markdown`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/markdown/);
    // No stored output config: a job from before the agent prompt existed.
    expect(res.text).toBe(toMarkdown(await sampleResult(), { agentPrompt: false }));
  });

  it("includes the all-comments agent prompt when the review's config had it", async () => {
    const job = await completedJob();
    await prisma.reviewJob.update({
      where: { id: job.id },
      data: { resolvedConfig: { config: { output: { agentPromptAll: true } } } },
    });

    const res = await request(app).get(`/api/reviews/${job.id}/markdown`).set("Cookie", cookie);

    expect(res.text).toBe(toMarkdown(await sampleResult()));
    expect(res.text).toContain("Prompt for AI agents (4 findings)");
  });

  it("leaves out the stats line when the review's config turned it off", async () => {
    const job = await completedJob();
    await prisma.reviewJob.update({
      where: { id: job.id },
      data: { resolvedConfig: { config: { output: { reviewStats: false } } } },
    });

    const res = await request(app).get(`/api/reviews/${job.id}/markdown`).set("Cookie", cookie);

    expect(res.text).toBe(toMarkdown(await sampleResult(), { stats: false, agentPrompt: false }));
    expect(res.text).not.toContain("<sub>Reviewed `");
  });

  it("leaves out the walkthrough's labels and blast radius when the review's config turned them off", async () => {
    const job = await completedJob();
    await prisma.reviewJob.update({
      where: { id: job.id },
      data: { resolvedConfig: { config: { output: { walkthroughLabels: false, walkthroughBlastRadius: false } } } },
    });

    const res = await request(app).get(`/api/reviews/${job.id}/markdown`).set("Cookie", cookie);

    expect(res.text).toBe(toMarkdown(await sampleResult(), { labels: false, blastRadius: false, agentPrompt: false }));
    expect(res.text).not.toMatch(/Labels:|Blast radius:/);
  });

  it("leaves out the finding counts line when the review's config turned it off", async () => {
    const job = await completedJob();
    await prisma.reviewJob.update({
      where: { id: job.id },
      data: { resolvedConfig: { config: { output: { findingCounts: false } } } },
    });

    const res = await request(app).get(`/api/reviews/${job.id}/markdown`).set("Cookie", cookie);

    expect(res.text).toBe(toMarkdown(await sampleResult(), { counts: false, agentPrompt: false }));
    expect(res.text).not.toContain("in the sections below.");
  });

  it("409s for markdown before there is a result", async () => {
    const job = await prisma.reviewJob.create({
      data: { repositoryId: repoId, number: 7, headSha: "h", trigger: "manual" },
    });
    const res = await request(app).get(`/api/reviews/${job.id}/markdown`).set("Cookie", cookie);
    expect(res.status).toBe(409);
  });

  it("marks a result expired by retention, and 410s for its markdown", async () => {
    const job = await completedJob();
    const expiredAt = new Date("2026-01-01T00:00:00Z");
    await prisma.reviewJob.update({
      where: { id: job.id },
      data: { result: Prisma.DbNull, resolvedConfig: Prisma.DbNull, resultExpiredAt: expiredAt },
    });

    const detail = await request(app).get(`/api/reviews/${job.id}`).set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.review.result).toBeNull();
    expect(detail.body.review.resultExpiredAt).toBe(expiredAt.toISOString());
    expect(detail.body.review.summary).not.toBeNull();

    const res = await request(app).get(`/api/reviews/${job.id}/markdown`).set("Cookie", cookie);
    expect(res.status).toBe(410);
    expect(res.body.message).toMatch(/expired/);
  });

  it("404s for another user's review", async () => {
    const job = await completedJob();
    const other = await createUser("other@example.com");
    expect((await request(app).get(`/api/reviews/${job.id}`).set("Cookie", other.cookie)).status).toBe(404);
  });

  it("says what a stored error is about, so the page can link to its fix", async () => {
    const completed = await completedJob();
    const skipped = await prisma.reviewJob.create({
      data: {
        repositoryId: repoId,
        number: 8,
        headSha: "head",
        trigger: "webhook",
        status: "skipped",
        error: "Draft changes are not reviewed automatically",
      },
    });

    const get = (id: string) => request(app).get(`/api/reviews/${id}`).set("Cookie", cookie);

    expect((await get(completed.id)).body.review.errorKind).toBeNull();
    expect((await get(skipped.id)).body.review.errorKind).toBe("trigger");
  });
});

describe("POST /api/reviews/:id/rerun", () => {
  it("queues a fresh review of the latest head", async () => {
    const job = await completedJob();
    vi.stubGlobal("fetch", fetchStub([mrRoute("newsha")]).fetch);

    const res = await request(app).post(`/api/reviews/${job.id}/rerun`).set("Cookie", cookie);

    expect(res.status).toBe(202);
    expect(res.body.review.id).not.toBe(job.id);
    expect(res.body.review).toMatchObject({ number: 7, headSha: "newsha", status: "queued" });
  });

  it("409s for a repository whose reviews are turned off, and queues nothing", async () => {
    const job = await completedJob();
    await prisma.repository.update({ where: { id: repoId }, data: { enabled: false } });
    vi.stubGlobal("fetch", fetchStub([mrRoute("newsha")]).fetch);

    const res = await request(app).post(`/api/reviews/${job.id}/rerun`).set("Cookie", cookie);

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Reviews are turned off for");
    expect(await claimNext()).toBeNull();
  });
});

describe("POST /api/reviews/:id/cancel", () => {
  const job = (status: "queued" | "running" | "completed" | "failed" | "cancelled") =>
    prisma.reviewJob.create({ data: { repositoryId: repoId, number: 7, headSha: "h", trigger: "manual", status } });

  it("cancels a queued review so no worker claims it", async () => {
    const queued = await job("queued");

    const res = await request(app).post(`/api/reviews/${queued.id}/cancel`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({ id: queued.id, status: "cancelled" });
    expect(res.body.review.error).toBe("Cancelled by Dev");
    expect(await claimNext()).toBeNull();
  });

  it("cancels a running review and records who and when", async () => {
    const running = await job("running");

    const res = await request(app).post(`/api/reviews/${running.id}/cancel`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: running.id } });
    expect(stored).toMatchObject({ status: "cancelled", error: "Cancelled by Dev", lockedAt: null });
    expect(stored.finishedAt).not.toBeNull();
  });

  it("409s for a review that already finished", async () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const finished = await job(status);
      const res = await request(app).post(`/api/reviews/${finished.id}/cancel`).set("Cookie", cookie);
      expect(res.status).toBe(409);
      expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: finished.id } })).status).toBe(status);
    }
  });

  it("404s for another workspace's review and leaves it running", async () => {
    const queued = await job("queued");
    const other = await createUser("other@example.com");

    const res = await request(app).post(`/api/reviews/${queued.id}/cancel`).set("Cookie", other.cookie);

    expect(res.status).toBe(404);
    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("queued");
  });
});
