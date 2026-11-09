import type { Request, Response } from "express";
import { env } from "../config/env.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import { csvRow } from "../lib/csv.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import {
  auditExportQuerySchema,
  auditLogQuerySchema,
  instanceAuditFilterSchema,
  instanceSettingsSchema,
  privacyLayerSchema,
} from "../schemas/privacy.schema.ts";
import { instancePolicy, mergePolicy, patternCovers, workspacePolicy } from "../services/privacyPolicy.ts";

// An export is one response; past this many rows the caller narrows the range.
const EXPORT_CAP = 100_000;
const EXPORT_BATCH = 1000;

const AUDIT_FIELDS = {
  id: true,
  createdAt: true,
  workspaceId: true,
  workspaceName: true,
  repositoryId: true,
  repository: true,
  changeNumber: true,
  jobId: true,
  replyId: true,
  userId: true,
  purpose: true,
  provider: true,
  host: true,
  model: true,
  inputTokens: true,
  cachedInputTokens: true,
  outputTokens: true,
  reasoningTokens: true,
  latencyMs: true,
  outcome: true,
  errorKind: true,
} satisfies Prisma.LlmRequestLogSelect;

const CSV_COLUMNS: [string, keyof typeof AUDIT_FIELDS][] = [
  ["time", "createdAt"],
  ["workspace", "workspaceName"],
  ["repository", "repository"],
  ["change", "changeNumber"],
  ["job_id", "jobId"],
  ["reply_id", "replyId"],
  ["user_id", "userId"],
  ["purpose", "purpose"],
  ["provider", "provider"],
  ["host", "host"],
  ["model", "model"],
  ["input_tokens", "inputTokens"],
  ["cached_input_tokens", "cachedInputTokens"],
  ["output_tokens", "outputTokens"],
  ["reasoning_tokens", "reasoningTokens"],
  ["latency_ms", "latencyMs"],
  ["outcome", "outcome"],
  ["error_kind", "errorKind"],
];

// ---- Instance settings (instance admins) ----

async function instanceSettingsBody() {
  const row = await prisma.instanceSettings.findUnique({ where: { id: 1 } });
  return {
    settings: {
      allowedProviders: row?.allowedProviders ?? [],
      allowedHosts: row?.allowedHosts ?? [],
      localOnly: row?.localOnly ?? false,
      retentionDays: row?.retentionDays ?? null,
      auditRetentionDays: row?.auditRetentionDays ?? null,
      allowDirectMemberAdd: row?.allowDirectMemberAdd ?? false,
    },
    // Used when retentionDays is unset; the page says so.
    env: { reviewRetentionDays: env.REVIEW_RETENTION_DAYS ?? null },
  };
}

export async function getInstanceSettings(_req: Request, res: Response) {
  res.json(await instanceSettingsBody());
}

export async function updateInstanceSettings(req: Request, res: Response) {
  const data = instanceSettingsSchema.parse(req.body);
  await prisma.instanceSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  res.json(await instanceSettingsBody());
}

// ---- Workspace privacy ----

async function workspacePrivacyBody(workspaceId: string) {
  const [instance, workspace] = await Promise.all([instancePolicy(), workspacePolicy(workspaceId)]);
  const effective = mergePolicy(instance, workspace);
  return {
    workspace,
    instance: {
      allowedProviders: instance.allowedProviders,
      allowedHosts: instance.allowedHosts,
      localOnly: instance.localOnly,
      retentionDays: instance.retentionDays,
    },
    effective: { localOnly: effective.localOnly, retentionDays: effective.retentionDays },
  };
}

export async function getWorkspacePrivacy(req: Request, res: Response) {
  res.json(await workspacePrivacyBody(req.workspaceId!));
}

// A workspace can only narrow the instance policy. The runtime check applies
// both layers anyway; refusing a wider value here keeps the page from showing
// a setting that has no effect.
export async function updateWorkspacePrivacy(req: Request, res: Response) {
  const data = privacyLayerSchema.parse(req.body);
  const instance = await instancePolicy();
  const errors: Record<string, string[]> = {};
  if (instance.allowedProviders.length) {
    const outside = data.allowedProviders.filter((provider) => !instance.allowedProviders.includes(provider));
    if (outside.length) {
      errors.allowedProviders = [`Not allowed on this instance: ${outside.join(", ")}`];
    }
  }
  if (instance.allowedHosts.length) {
    const outside = data.allowedHosts.filter((host) => !instance.allowedHosts.some((outer) => patternCovers(outer, host)));
    if (outside.length) errors.allowedHosts = [`Not allowed on this instance: ${outside.join(", ")}`];
  }
  if (instance.retentionDays !== null && data.retentionDays !== null && data.retentionDays > instance.retentionDays) {
    const days = instance.retentionDays === 1 ? "1 day" : `${instance.retentionDays} days`;
    errors.retentionDays = [`Must be at most ${days} (the instance limit)`];
  }
  if (Object.keys(errors).length) throw new HttpError(400, "Validation failed", errors);

  const workspaceId = req.workspaceId!;
  await prisma.workspacePrivacy.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
  res.json(await workspacePrivacyBody(workspaceId));
}

// ---- Audit log ----

function auditWhere(
  query: Omit<ReturnType<typeof auditExportQuerySchema.parse>, "format">,
  scope: Prisma.LlmRequestLogWhereInput,
): Prisma.LlmRequestLogWhereInput {
  const where: Prisma.LlmRequestLogWhereInput = { ...scope };
  if (query.provider) where.provider = query.provider;
  if (query.purpose) where.purpose = query.purpose;
  if (query.outcome) where.outcome = query.outcome;
  if (query.from || query.to) where.createdAt = { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) };
  if (query.q) {
    where.OR = [
      { model: { contains: query.q, mode: "insensitive" } },
      { host: { contains: query.q, mode: "insensitive" } },
      { repository: { contains: query.q, mode: "insensitive" } },
      { workspaceName: { contains: query.q, mode: "insensitive" } },
    ];
  }
  return where;
}

const NEWEST_FIRST: Prisma.LlmRequestLogOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

async function listAudit(req: Request, res: Response, scope: Prisma.LlmRequestLogWhereInput) {
  const { page, limit, ...query } = auditLogQuerySchema.parse(req.query);
  const where = auditWhere(query, scope);
  const [entries, total] = await prisma.$transaction([
    prisma.llmRequestLog.findMany({
      where,
      orderBy: NEWEST_FIRST,
      skip: (page - 1) * limit,
      take: limit,
      select: AUDIT_FIELDS,
    }),
    prisma.llmRequestLog.count({ where }),
  ]);
  res.json({ entries, total, page, limit });
}

// Streamed a batch at a time so a large export never sits in memory whole.
async function exportAudit(req: Request, res: Response, scope: Prisma.LlmRequestLogWhereInput) {
  const { format, ...query } = auditExportQuerySchema.parse(req.query);
  const where = auditWhere(query, scope);
  const total = await prisma.llmRequestLog.count({ where });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="sentryward-audit-${stamp}.${format}"`);
  if (total > EXPORT_CAP) res.setHeader("X-Truncated", "true");

  res.write(format === "csv" ? csvRow(CSV_COLUMNS.map(([name]) => name)) : "[");
  let cursor: string | undefined;
  let written = 0;
  while (written < EXPORT_CAP) {
    const rows = await prisma.llmRequestLog.findMany({
      where,
      orderBy: NEWEST_FIRST,
      take: Math.min(EXPORT_BATCH, EXPORT_CAP - written),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: AUDIT_FIELDS,
    });
    for (const row of rows) {
      if (format === "csv") res.write(csvRow(CSV_COLUMNS.map(([, key]) => row[key])));
      else res.write(`${written ? "," : ""}${JSON.stringify(row)}`);
      written++;
    }
    if (rows.length < EXPORT_BATCH) break;
    cursor = rows[rows.length - 1]!.id;
  }
  res.end(format === "csv" ? "" : "]");
}

function instanceScope(req: Request): Prisma.LlmRequestLogWhereInput {
  const { workspaceId } = instanceAuditFilterSchema.parse({ workspaceId: req.query.workspaceId });
  return workspaceId ? { workspaceId } : {};
}

export function listInstanceAuditLog(req: Request, res: Response) {
  return listAudit(req, res, instanceScope(req));
}

export function exportInstanceAuditLog(req: Request, res: Response) {
  return exportAudit(req, res, instanceScope(req));
}

export function listWorkspaceAuditLog(req: Request, res: Response) {
  return listAudit(req, res, { workspaceId: req.workspaceId! });
}

export function exportWorkspaceAuditLog(req: Request, res: Response) {
  return exportAudit(req, res, { workspaceId: req.workspaceId! });
}
