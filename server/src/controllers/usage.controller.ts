import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.ts";
import { recentUsageQuerySchema, usageQuerySchema } from "../schemas/usage.schema.ts";
import { buildRecentUsage, buildUsageReport, periodStart, type UsagePeriod } from "../services/usage.ts";

// The same runs review stats count, reading the small digest column only.
// "all" scans every run kept; REVIEW_RETENTION_DAYS bounds that. Should it
// get slow, aggregate usageByModel in SQL (jsonb_each, date_trunc) instead.
function loadUsageJobs(workspaceId: string, period: UsagePeriod, repoId: string | undefined, now: Date) {
  const since = periodStart(period, now);
  return prisma.reviewJob.findMany({
    where: {
      repository: { connection: { workspaceId } },
      ...(repoId ? { repositoryId: repoId } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
      status: { notIn: ["superseded", "skipped", "cancelled"] },
    },
    select: {
      id: true,
      number: true,
      createdAt: true,
      title: true,
      summary: true,
      repository: { select: { id: true, fullPath: true, provider: true } },
    },
  });
}

export async function getUsage(req: Request, res: Response) {
  const { period, repoId } = usageQuerySchema.parse(req.query);
  const now = new Date();
  const jobs = await loadUsageJobs(req.workspaceId!, period, repoId, now);
  res.json(buildUsageReport(jobs, period, now));
}

export async function getRecentUsage(req: Request, res: Response) {
  const { period, repoId, page, limit } = recentUsageQuerySchema.parse(req.query);
  const jobs = await loadUsageJobs(req.workspaceId!, period, repoId, new Date());
  res.json(buildRecentUsage(jobs, page, limit));
}
