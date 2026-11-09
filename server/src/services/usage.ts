import type { ForgeProvider } from "../review/core/models.ts";
import { addUsage, roundUsd, usedTokens, type UsageByModel } from "../review/core/pricing/pricing.ts";

export const USAGE_PERIODS = ["24h", "7d", "30d", "90d", "all"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

// A review job as the usage page needs it: the digest, never the full result.
export interface UsageJob {
  id: string;
  number: number;
  createdAt: Date;
  // Absent on callers that only read the digest; the digest's title is the fallback.
  title?: string | null;
  summary: unknown;
  // provider, so the client writes the change number the forge's way (#42, !42).
  repository: { id: string; fullPath: string; provider: ForgeProvider };
}

type Unit = "hour" | "day" | "month";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD_MS: Record<Exclude<UsagePeriod, "all">, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY };
// Past this span "all" is charted by month, so years of history stay readable.
const MAX_DAILY_SPAN = 90 * DAY;

export function periodStart(period: UsagePeriod, now: Date): Date | null {
  return period === "all" ? null : new Date(now.getTime() - PERIOD_MS[period]);
}

// Buckets are UTC so every viewer and test sees the same boundaries.
function floorTo(date: Date, unit: Unit): Date {
  const d = new Date(date);
  if (unit === "month") d.setUTCDate(1);
  if (unit !== "hour") d.setUTCHours(0);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

function next(date: Date, unit: Unit): Date {
  const d = new Date(date);
  if (unit === "hour") d.setUTCHours(d.getUTCHours() + 1);
  else if (unit === "day") d.setUTCDate(d.getUTCDate() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

function digestOf(job: UsageJob) {
  const summary = job.summary as { title?: string; usageByModel?: UsageByModel } | null;
  return { title: job.title ?? summary?.title ?? null, byModel: summary?.usageByModel ?? null };
}

const providerOf = (model: string) => model.split("/")[0]!;

// The models a review called, from its digest.
export function digestModels(summary: unknown): string[] {
  const byModel = (summary as { usageByModel?: UsageByModel } | null)?.usageByModel ?? {};
  return Object.entries(byModel)
    .filter(([, usage]) => usedTokens(usage))
    .map(([model]) => model);
}

// Tokens and the recorded cost of a set of models. Digests stored before costs
// were recorded add their tokens but no cost; unpricedCalls counts the calls
// no price was known for, so a reader can say the cost is unknown.
export function totalsOf(byModel: UsageByModel) {
  const totals = { calls: 0, unpricedCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, usd: 0 };
  for (const usage of Object.values(byModel)) {
    totals.calls += usage.calls;
    totals.unpricedCalls += usage.unpricedCalls ?? 0;
    totals.inputTokens += usage.inputTokens;
    totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    totals.outputTokens += usage.outputTokens;
    totals.usd += usage.cost?.total ?? 0;
  }
  return { ...totals, usd: roundUsd(totals.usd) };
}

// One review's totals, summed the way the usage page sums them so the Reviews
// stats tile and the Usage page agree. Digests from before per-model usage
// have only usageTotals: their tokens count, at no cost.
export function digestTotals(summary: unknown) {
  const digest = summary as {
    usageByModel?: UsageByModel;
    usageTotals?: { calls?: number; inputTokens?: number; outputTokens?: number };
  } | null;
  if (digest?.usageByModel) return totalsOf(digest.usageByModel);
  const old = digest?.usageTotals;
  return {
    calls: old?.calls ?? 0,
    unpricedCalls: 0,
    inputTokens: old?.inputTokens ?? 0,
    cachedInputTokens: 0,
    outputTokens: old?.outputTokens ?? 0,
    usd: 0,
  };
}

const later = (a: Date | null, b: Date) => (a && a > b ? a : b);

// The parts the usage table shows: cache writes are input and reasoning is
// output, as a bill lists them.
export interface CostBreakdown {
  input: number;
  cached: number;
  output: number;
  total: number;
}

export interface UsageReport {
  period: UsagePeriod;
  unit: Unit;
  totals: {
    reviews: number;
    calls: number;
    unpricedCalls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    cost: { usd: number };
  };
  series: { start: string; calls: number; tokens: number; usd: number }[];
  byModel: {
    model: string;
    provider: string;
    calls: number;
    unpricedCalls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    lastUsed: string;
    cost: CostBreakdown;
  }[];
  byProvider: { provider: string; calls: number; tokens: number; usd: number }[];
  byRepository: {
    repositoryId: string;
    fullPath: string;
    reviews: number;
    calls: number;
    unpricedCalls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    lastUsed: string | null;
    usd: number;
  }[];
}

export interface RecentUsage {
  id: string;
  number: number;
  title: string | null;
  fullPath: string;
  provider: ForgeProvider;
  createdAt: string;
  models: string[];
  // With unpricedCalls, so a review no call had a price for reads as unknown.
  calls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

// Everything the usage page shows, summed from the costs each review recorded
// when it ran; nothing is priced here, so past figures never change. Runs
// whose digest predates per-model usage count as reviews and add nothing else.
export function buildUsageReport(jobs: UsageJob[], period: UsagePeriod, now: Date): UsageReport {
  const all: UsageByModel = {};
  const modelLastUsed = new Map<string, Date>();

  const start = periodStart(period, now) ?? jobs.reduce<Date>((min, job) => (job.createdAt < min ? job.createdAt : min), now);
  const unit: Unit = period === "24h" ? "hour" : now.getTime() - start.getTime() > MAX_DAILY_SPAN ? "month" : "day";
  const buckets = new Map<number, UsageByModel>();
  for (let at = floorTo(start, unit); at <= now; at = next(at, unit)) buckets.set(at.getTime(), {});

  const repos = new Map<string, { fullPath: string; reviews: number; byModel: UsageByModel; lastUsed: Date | null }>();

  // Newest first, so repositories are listed by their latest review.
  for (const job of [...jobs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const { byModel } = digestOf(job);
    const repo = repos.get(job.repository.id) ?? { fullPath: job.repository.fullPath, reviews: 0, byModel: {}, lastUsed: null };
    repos.set(job.repository.id, repo);
    repo.reviews += 1;
    if (!byModel) continue;

    addUsage(all, byModel);
    addUsage(repo.byModel, byModel);
    const bucket = buckets.get(floorTo(job.createdAt, unit).getTime());
    if (bucket) addUsage(bucket, byModel);
    if (!Object.values(byModel).some(usedTokens)) continue;

    repo.lastUsed = later(repo.lastUsed, job.createdAt);
    for (const [model, usage] of Object.entries(byModel)) {
      if (usedTokens(usage)) modelLastUsed.set(model, later(modelLastUsed.get(model) ?? null, job.createdAt));
    }
  }

  const byModel: UsageReport["byModel"] = Object.entries(all)
    .filter(([, usage]) => usedTokens(usage))
    .map(([model, usage]) => {
      const cost = usage.cost;
      return {
        model,
        provider: providerOf(model),
        calls: usage.calls,
        unpricedCalls: usage.unpricedCalls ?? 0,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        outputTokens: usage.outputTokens,
        lastUsed: modelLastUsed.get(model)!.toISOString(),
        cost: {
          input: roundUsd((cost?.input ?? 0) + (cost?.cacheWrite ?? 0)),
          cached: cost?.cached ?? 0,
          output: roundUsd((cost?.output ?? 0) + (cost?.reasoning ?? 0)),
          total: cost?.total ?? 0,
        },
      };
    })
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  const providers = new Map<string, UsageReport["byProvider"][number]>();
  for (const row of byModel) {
    const total = providers.get(row.provider) ?? { provider: row.provider, calls: 0, tokens: 0, usd: 0 };
    total.calls += row.calls;
    total.tokens += row.inputTokens + row.outputTokens;
    total.usd = roundUsd(total.usd + row.cost.total);
    providers.set(row.provider, total);
  }

  const { usd, ...tokens } = totalsOf(all);
  return {
    period,
    unit,
    totals: { reviews: jobs.length, ...tokens, cost: { usd } },
    series: [...buckets].map(([at, usage]) => {
      const bucket = totalsOf(usage);
      return {
        start: new Date(at).toISOString(),
        calls: bucket.calls,
        tokens: bucket.inputTokens + bucket.outputTokens,
        usd: bucket.usd,
      };
    }),
    byModel,
    byProvider: [...providers.values()].sort((a, b) => b.tokens - a.tokens),
    byRepository: [...repos].map(([repositoryId, repo]) => ({
      repositoryId,
      fullPath: repo.fullPath,
      reviews: repo.reviews,
      ...totalsOf(repo.byModel),
      lastUsed: repo.lastUsed?.toISOString() ?? null,
    })),
  };
}

// One page of the reviews that used a model, newest first. Served apart from
// the report so a long period never sends every review to show ten of them.
// A page past the end is clamped to the last one, like the client's paginate.
export function buildRecentUsage(jobs: UsageJob[], page: number, limit: number) {
  const used = jobs
    .filter((job) => Object.values(digestOf(job).byModel ?? {}).some(usedTokens))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const current = Math.min(page, Math.max(1, Math.ceil(used.length / limit)));
  const reviews: RecentUsage[] = used.slice((current - 1) * limit, current * limit).map((job) => {
    const { title, byModel } = digestOf(job);
    const totals = totalsOf(byModel!);
    return {
      id: job.id,
      number: job.number,
      title,
      fullPath: job.repository.fullPath,
      provider: job.repository.provider,
      createdAt: job.createdAt.toISOString(),
      models: Object.keys(byModel!).sort(),
      calls: totals.calls,
      unpricedCalls: totals.unpricedCalls,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      usd: totals.usd,
    };
  });
  return { reviews, total: used.length, page: current };
}
