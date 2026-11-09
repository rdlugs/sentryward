import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { prisma } from "../src/lib/prisma.ts";
import type { ModelUsage, UsageByModel } from "../src/review/core/pricing/pricing.ts";
import { buildRecentUsage, buildUsageReport, type UsageJob } from "../src/services/usage.ts";
import { createUser } from "./helpers/users.ts";

const NOW = new Date("2026-10-23T12:30:00Z");
const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const PROXY = "openai/my-proxy";

// One model's usage in a digest, with the cost it recorded (input and output
// parts only, enough to check the sums).
const usage = (inputTokens: number, outputTokens: number, usd = { input: 0, output: 0 }, cachedInputTokens = 0, calls = 1): ModelUsage => ({
  calls,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  cost: { input: usd.input, cached: 0, cacheWrite: 0, output: usd.output, reasoning: 0, total: usd.input + usd.output },
});

let seq = 0;
function job(createdAt: string, byModel: UsageByModel | null, repo: UsageJob["repository"] = { id: "r1", fullPath: "team/web", provider: "github" }): UsageJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    number: seq,
    createdAt: new Date(createdAt),
    repository: repo,
    summary: { title: `Change ${seq}`, ...(byModel ? { usageByModel: byModel } : {}) },
  };
}

describe("buildUsageReport", () => {
  it("charts the last 24 hours by hour and earlier periods by day, zero-filled", () => {
    const jobs = [job("2026-10-23T11:10:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) })];

    const hourly = buildUsageReport(jobs, "24h", NOW);
    expect(hourly.unit).toBe("hour");
    // 12:00 yesterday through 12:00 today.
    expect(hourly.series).toHaveLength(25);
    expect(hourly.series.find((b) => b.start === "2026-10-23T11:00:00.000Z")).toEqual({
      start: "2026-10-23T11:00:00.000Z",
      calls: 1,
      tokens: 1_000_000,
      usd: 2,
    });
    expect(hourly.series.filter((b) => b.tokens > 0)).toHaveLength(1);

    const daily = buildUsageReport(jobs, "7d", NOW);
    expect(daily.unit).toBe("day");
    expect(daily.series.map((b) => b.start.slice(0, 10))).toEqual([
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
  });

  it("charts a long all-time history by month", () => {
    const jobs = [job("2026-01-05T00:00:00Z", { [SONNET]: usage(10, 10) }), job("2026-10-01T00:00:00Z", { [SONNET]: usage(10, 10) })];
    const report = buildUsageReport(jobs, "all", NOW);
    expect(report.unit).toBe("month");
    expect(report.series[0]!.start).toBe("2026-01-01T00:00:00.000Z");
    expect(report.series).toHaveLength(10);
  });

  it("sums the costs each review recorded, per model and provider", () => {
    const report = buildUsageReport(
      [
        job("2026-10-22T10:00:00Z", {
          [SONNET]: usage(1_000_000, 100_000, { input: 1.28, output: 1 }, 400_000),
          [HAIKU]: usage(1_000_000, 1_000_000, { input: 0.1, output: 0.5 }),
        }),
        job("2026-10-23T10:00:00Z", { [SONNET]: usage(0, 100_000, { input: 0, output: 1 }) }),
      ],
      "7d",
      NOW,
    );

    expect(report.totals).toEqual({
      reviews: 2,
      calls: 3,
      unpricedCalls: 0,
      inputTokens: 2_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 1_200_000,
      cost: { usd: 3.88 },
    });
    expect(report.byModel).toEqual([
      {
        model: HAIKU,
        provider: "anthropic",
        calls: 1,
        unpricedCalls: 0,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        lastUsed: "2026-10-22T10:00:00.000Z",
        cost: { input: 0.1, cached: 0, output: 0.5, total: 0.6 },
      },
      {
        model: SONNET,
        provider: "anthropic",
        calls: 2,
        unpricedCalls: 0,
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        outputTokens: 200_000,
        lastUsed: "2026-10-23T10:00:00.000Z",
        cost: { input: 1.28, cached: 0, output: 2, total: 3.28 },
      },
    ]);
    expect(report.byProvider).toEqual([{ provider: "anthropic", calls: 3, tokens: 3_200_000, usd: 3.88 }]);
  });

  it("shows cache writes as input and reasoning as output in the table", () => {
    const report = buildUsageReport(
      [
        job("2026-10-23T10:00:00Z", {
          [SONNET]: {
            calls: 1,
            inputTokens: 100,
            outputTokens: 100,
            cost: { input: 1, cached: 0.1, cacheWrite: 0.5, output: 2, reasoning: 3, total: 6.6 },
          },
        }),
      ],
      "7d",
      NOW,
    );
    expect(report.byModel[0]!.cost).toEqual({ input: 1.5, cached: 0.1, output: 5, total: 6.6 });
  });

  it("counts a model with no price at $0, and older digests without cost the same way", () => {
    const jobs = [
      job("2026-10-23T08:00:00Z", { [PROXY]: usage(10, 10) }),
      job("2026-10-23T09:00:00Z", { [SONNET]: { calls: 1, inputTokens: 1_000_000, outputTokens: 0 } }),
      job("2026-10-23T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) }),
    ];
    const report = buildUsageReport(jobs, "7d", NOW);

    expect(report.totals).toMatchObject({ reviews: 3, inputTokens: 2_000_010, cost: { usd: 2 } });
    expect(report.byModel.find((m) => m.model === PROXY)!.cost.total).toBe(0);
    expect(buildRecentUsage(jobs, 1, 10).reviews.map((r) => r.usd)).toEqual([2, 0, 0]);
  });

  it("gives each recent review its calls and unpriced calls, so its cost can read as unknown", () => {
    const jobs = [job("2026-10-23T08:00:00Z", { [PROXY]: { calls: 2, unpricedCalls: 2, inputTokens: 10, outputTokens: 10 } })];
    expect(buildRecentUsage(jobs, 1, 10).reviews[0]).toMatchObject({ calls: 2, unpricedCalls: 2, usd: 0 });
  });

  it("counts the calls no price was known for, so the page can show their cost as unknown", () => {
    const report = buildUsageReport(
      [job("2026-10-23T08:00:00Z", { [PROXY]: { calls: 2, inputTokens: 10, outputTokens: 10, unpricedCalls: 2 } })],
      "7d",
      NOW,
    );
    expect(report.byModel[0]).toMatchObject({ calls: 2, unpricedCalls: 2 });
    expect(report.byRepository[0]).toMatchObject({ calls: 2, unpricedCalls: 2 });
    expect(report.totals.unpricedCalls).toBe(2);
  });

  it("counts runs without usage as reviews but leaves their tokens out", () => {
    const report = buildUsageReport(
      [job("2026-10-23T09:00:00Z", null), job("2026-10-23T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) })],
      "7d",
      NOW,
    );

    expect(report.totals).toMatchObject({ reviews: 2, inputTokens: 1_000_000, cost: { usd: 2 } });
    expect(report.byRepository).toEqual([
      expect.objectContaining({ fullPath: "team/web", reviews: 2, inputTokens: 1_000_000, usd: 2 }),
    ]);
  });

  it("groups by repository", () => {
    const api = { id: "r2", fullPath: "team/api", provider: "gitlab" as const };
    const report = buildUsageReport(
      [
        job("2026-10-21T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) }),
        job("2026-10-23T10:00:00Z", { [HAIKU]: usage(1_000_000, 0, { input: 0.1, output: 0 }) }, api),
        job("2026-10-22T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) }),
      ],
      "7d",
      NOW,
    );

    expect(report).not.toHaveProperty("recent");
    expect(report.byRepository.map((r) => [r.fullPath, r.reviews, r.usd, r.lastUsed])).toEqual(
      expect.arrayContaining([
        ["team/web", 2, 4, "2026-10-22T10:00:00.000Z"],
        ["team/api", 1, 0.1, "2026-10-23T10:00:00.000Z"],
      ]),
    );
  });

  it("is empty without runs", () => {
    const report = buildUsageReport([], "all", NOW);
    expect(report.totals).toMatchObject({ reviews: 0, calls: 0, cost: { usd: 0 } });
    expect(report.byModel).toEqual([]);
  });
});

describe("buildRecentUsage", () => {
  it("lists the reviews that used a model, newest first, with their totals", () => {
    const api = { id: "r2", fullPath: "team/api", provider: "gitlab" as const };
    const jobs = [
      job("2026-10-21T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) }),
      job("2026-10-23T10:00:00Z", { [HAIKU]: usage(1_000_000, 0, { input: 0.1, output: 0 }) }, api),
      // No digest usage, or none that used tokens: not listed.
      job("2026-10-23T11:00:00Z", null),
      job("2026-10-23T11:30:00Z", { [SONNET]: usage(0, 0) }),
      job("2026-10-22T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) }),
    ];

    const recent = buildRecentUsage(jobs, 1, 10);

    expect(recent.total).toBe(3);
    expect(recent.reviews.map((r) => [r.fullPath, r.provider])).toEqual([
      ["team/api", "gitlab"],
      ["team/web", "github"],
      ["team/web", "github"],
    ]);
    expect(recent.reviews[0]).toMatchObject({ models: [HAIKU], inputTokens: 1_000_000, usd: 0.1 });
  });

  it("returns one page, clamping a page past the end to the last", () => {
    const jobs = Array.from({ length: 12 }, (_, i) =>
      job(`2026-10-23T${String(i).padStart(2, "0")}:00:00Z`, { [SONNET]: usage(1_000, 0) }),
    );
    const newestFirst = jobs.map((j) => j.id).reverse();

    expect(buildRecentUsage(jobs, 1, 10)).toMatchObject({ total: 12, page: 1 });
    expect(buildRecentUsage(jobs, 1, 10).reviews.map((r) => r.id)).toEqual(newestFirst.slice(0, 10));
    const last = buildRecentUsage(jobs, 2, 10);
    expect(last.reviews.map((r) => r.id)).toEqual(newestFirst.slice(10));
    expect(buildRecentUsage(jobs, 9, 10)).toEqual(last);
    expect(buildRecentUsage([], 3, 10)).toEqual({ reviews: [], total: 0, page: 1 });
  });

  it("titles a review from the stored column before the digest", () => {
    const run = { ...job("2026-10-23T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) }), title: "Fix login redirect" };
    const older = job("2026-10-23T09:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) });

    const recent = buildRecentUsage([run, older], 1, 10);

    expect(recent.reviews.map((r) => r.title)).toEqual(["Fix login redirect", `Change ${older.number}`]);
  });
});

describe("GET /api/usage", () => {
  let cookie: string;
  let repoId: string;
  let otherRepoId: string;

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
    const repo = (fullPath: string, externalId: string) =>
      prisma.repository.create({
        data: { connectionId: connection.id, provider: "gitlab", host: "gitlab.com", fullPath, externalId, defaultBranch: "main", enabled: true },
      });
    repoId = (await repo("team/web", "1")).id;
    otherRepoId = (await repo("team/api", "2")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function run(repositoryId: string, number: number, byModel: UsageByModel, status: "completed" | "superseded" = "completed") {
    await prisma.reviewJob.create({
      data: { repositoryId, number, headSha: "h", trigger: "manual", status, summary: { title: `Change ${number}`, usageByModel: byModel } as object },
    });
  }

  it("reports the workspace's usage from recorded costs, scoped by repository", async () => {
    await run(repoId, 1, { [PROXY]: usage(1_000_000, 1_000_000, { input: 1, output: 3 }) });
    await run(otherRepoId, 2, { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) });
    // Superseded runs are not counted, as in review stats.
    await run(repoId, 3, { [SONNET]: usage(5_000_000, 0, { input: 10, output: 0 }) }, "superseded");

    const all = await request(app).get("/api/usage?period=30d").set("Cookie", cookie);
    expect(all.status).toBe(200);
    expect(all.body.period).toBe("30d");
    expect(all.body.totals).toMatchObject({ reviews: 2, inputTokens: 2_000_000, cost: { usd: 6 } });

    const scoped = await request(app).get(`/api/usage?repoId=${otherRepoId}`).set("Cookie", cookie);
    expect(scoped.body.period).toBe("7d");
    expect(scoped.body.totals).toMatchObject({ reviews: 1, cost: { usd: 2 } });
  });

  it("shows nothing of another workspace and rejects an unknown period", async () => {
    await run(repoId, 1, { [SONNET]: usage(10, 10) });
    const other = await createUser("other@example.com");

    const res = await request(app).get("/api/usage").set("Cookie", other.cookie);
    expect(res.body.totals.reviews).toBe(0);

    expect((await request(app).get("/api/usage?period=1y").set("Cookie", cookie)).status).toBe(400);
    expect((await request(app).get("/api/usage")).status).toBe(401);
  });

  it("pages the recent reviews apart from the report", async () => {
    for (let n = 1; n <= 3; n += 1) await run(repoId, n, { [SONNET]: usage(1_000, 0) });
    await run(otherRepoId, 4, { [SONNET]: usage(1_000, 0) });

    const first = await request(app).get("/api/usage/recent?period=30d&limit=2").set("Cookie", cookie);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 4, page: 1 });
    expect(first.body.reviews).toHaveLength(2);
    const second = await request(app).get("/api/usage/recent?period=30d&page=2&limit=2").set("Cookie", cookie);
    expect(second.body.reviews).toHaveLength(2);

    const scoped = await request(app).get(`/api/usage/recent?repoId=${otherRepoId}`).set("Cookie", cookie);
    expect(scoped.body.reviews.map((r: { number: number; provider: string }) => [r.number, r.provider])).toEqual([[4, "gitlab"]]);

    const report = await request(app).get("/api/usage").set("Cookie", cookie);
    expect(report.body).not.toHaveProperty("recent");
  });

  it("keeps recent reviews to the workspace and bounds the page size", async () => {
    await run(repoId, 1, { [SONNET]: usage(10, 10) });
    const other = await createUser("other@example.com");

    const res = await request(app).get("/api/usage/recent").set("Cookie", other.cookie);
    expect(res.body).toEqual({ reviews: [], total: 0, page: 1 });

    expect((await request(app).get("/api/usage/recent?limit=101").set("Cookie", cookie)).status).toBe(400);
    expect((await request(app).get("/api/usage/recent?page=0").set("Cookie", cookie)).status).toBe(400);
    expect((await request(app).get("/api/usage/recent")).status).toBe(401);
  });
});
