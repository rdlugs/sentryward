import type { Request, Response } from "express";
import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { MISSING_REVISION_MESSAGE, settingsRevision } from "../lib/settingsRevision.ts";
import { CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW } from "../review/context/budget.ts";
import { CATEGORIES, SEVERITIES } from "../review/core/severity.ts";
import { THINKING_BUDGETS } from "../review/llm/thinking.ts";
import { PROFILES } from "../review/config/profiles.ts";
import { skipReason, walkthroughEnabled, type ReviewTrigger } from "../review/config/filters.ts";
import { repoSettingsRuleIssues } from "../review/config/load.ts";
import { resolveConfig } from "../review/config/resolve.ts";
import {
  DEFAULT_CONFIG,
  PROFILE_NAMES,
  RULE_PATTERN_ERROR,
  SPECIALISTS,
  dashboardOverrideSchema,
  rulePatternCompiles,
} from "../review/config/schema.ts";
import { previewPublication } from "../review/preview/preview.ts";
import {
  checkRulePatternsSchema,
  configPreviewSchema,
  triggerCheckSchema,
  updateGlobalConfigSchema,
} from "../schemas/config.schema.ts";
import { requireStoredLlmConnection } from "../services/llm.ts";

// What the settings UI needs to render choices and show inherited values.
export function getConfigSchema(_req: Request, res: Response) {
  res.json({
    defaults: DEFAULT_CONFIG,
    profiles: Object.fromEntries(PROFILE_NAMES.map((name) => [name, PROFILES[name]])),
    severities: SEVERITIES,
    categories: CATEGORIES,
    specialists: SPECIALISTS,
    // What promptCeiling resolves an "auto" context budget from.
    contextWindows: CONTEXT_WINDOW,
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    thinkingBudgets: THINKING_BUDGETS,
  });
}

// The saved global config and what it resolves to on its own, before any
// repository settings or repository file.
function globalConfigBody(saved: unknown) {
  // Same tolerance as a review: settings saved under an older schema are
  // reported, not fatal.
  const parsed = dashboardOverrideSchema.safeParse(saved);
  const warnings = parsed.success ? [] : ["Saved global settings are no longer valid and were ignored"];
  const settings = parsed.success ? parsed.data : {};
  const { ruleIssues: _ruleIssues, ...resolved } = resolveConfig({ global: settings });
  return { settings, ...resolved, warnings: [...warnings, ...resolved.warnings] };
}

// The global rules always win, so a save is not refused when they leave a
// repository's own rules out; the owner is told which repositories lost them,
// on every read until it is fixed.
async function repositoryRuleWarnings(workspaceId: string, globalSettings: unknown): Promise<string[]> {
  return repositoryRuleIssues(await loadRuleRepositories(prisma, workspaceId), globalSettings);
}

export type RuleRepository = { fullPath: string; settings: unknown; directories: unknown };

// The workspace's repositories with rules of their own (or in a folder) that
// the global settings apply under. Shared with rule suggestion approvals, so
// what an approval refuses and what this page warns about cannot drift apart.
export async function loadRuleRepositories(db: PrismaClient | Prisma.TransactionClient, workspaceId: string): Promise<RuleRepository[]> {
  const repos = await db.repository.findMany({
    where: { connection: { workspaceId }, followGlobal: false },
    select: { fullPath: true, settings: true, directories: true },
  });
  const hasRules = (settings: unknown) => {
    const rules = (settings as { rules?: unknown[] } | null)?.rules;
    return Array.isArray(rules) && rules.length > 0;
  };
  return repos.filter((repo) => {
    const directories = Array.isArray(repo.directories) ? (repo.directories as { settings?: unknown }[]) : [];
    return hasRules(repo.settings) || directories.some((dir) => hasRules(dir?.settings));
  });
}

// The repository and folder rules these global settings leave out, one
// message each, prefixed with the repository.
export function repositoryRuleIssues(repos: RuleRepository[], globalSettings: unknown): string[] {
  return repos.flatMap((repo) =>
    repoSettingsRuleIssues({ globalSettings, repoSettings: repo.settings, directories: repo.directories }).map(
      (issue) => `${repo.fullPath}: ${issue.message}`,
    ),
  );
}

export async function getGlobalConfig(req: Request, res: Response) {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: req.workspaceId! },
    select: { reviewSettings: true },
  });
  res.json(await globalConfigResponse(req.workspaceId!, workspace.reviewSettings));
}

async function globalConfigResponse(workspaceId: string, saved: unknown) {
  const body = globalConfigBody(saved);
  const repositories = await repositoryRuleWarnings(workspaceId, saved);
  return { ...body, revision: settingsRevision(saved), warnings: [...body.warnings, ...repositories] };
}

export async function updateGlobalConfig(req: Request, res: Response) {
  const { settings, revision } = updateGlobalConfigSchema.parse(req.body);
  // Before any other check, so a page loaded before revisions existed is told
  // to reload rather than shown an error about its settings.
  if (revision === undefined) throw new HttpError(409, MISSING_REVISION_MESSAGE);
  if (!settings.llm?.connection) {
    throw new HttpError(400, "Validation failed", { connection: ["Select an LLM connection"] });
  }
  await requireStoredLlmConnection(req.workspaceId!, settings.llm.connection);
  // Under the workspace row lock a rule suggestion approval takes, so the
  // revision check and the write cannot interleave with a rule being added.
  const workspace = await prisma.$transaction(async (tx) => {
    const [current] = await tx.$queryRaw<{ review_settings: unknown }[]>`
      SELECT review_settings FROM workspaces WHERE id = ${req.workspaceId!}::uuid FOR NO KEY UPDATE
    `;
    if (revision !== settingsRevision(current!.review_settings)) {
      throw new HttpError(409, "The global settings changed since the page loaded; reload and try again");
    }
    return tx.workspace.update({
      where: { id: req.workspaceId! },
      data: { reviewSettings: settings },
      select: { reviewSettings: true },
    });
  });
  res.json(await globalConfigResponse(req.workspaceId!, workspace.reviewSettings));
}

// Renders what a review of a sample change would post with these settings. No
// model call and nothing stored: the sample's model answers are scripted.
export async function previewConfig(req: Request, res: Response) {
  const { provider, base, settings } = configPreviewSchema.parse(req.body);
  const { config } = resolveConfig({ global: base, repoSettings: settings });
  res.json(await previewPublication(config, provider));
}

// What the worker would do with a sample change under unsaved trigger
// settings, from the same skipReason it runs. The repository file is not part
// of it, as with the preview.
const CHECK_JOB: Record<"opened" | "push" | "command", { trigger: ReviewTrigger; event?: string }> = {
  opened: { trigger: "webhook" },
  push: { trigger: "webhook", event: "push" },
  command: { trigger: "comment" },
};

export function checkTriggers(req: Request, res: Response) {
  const { base, settings, event, change, actor } = triggerCheckSchema.parse(req.body);
  const { config } = resolveConfig({ global: base, repoSettings: settings });
  const job = CHECK_JOB[event];
  const reason = skipReason({ ...job, actor }, config, change);
  res.json({
    reason,
    // Only a push can review just its new commits.
    fullReview: reason === null && (event !== "push" || config.triggers.fullReviewOnPush),
    walkthrough: reason === null && walkthroughEnabled(job.trigger, config, change.isDraft),
  });
}

// One answer per pattern, in order: null when it compiles, the same message a
// save would give when it does not.
export function checkRulePatterns(req: Request, res: Response) {
  const { patterns } = checkRulePatternsSchema.parse(req.body);
  res.json({ errors: patterns.map((pattern) => (pattern === "" || rulePatternCompiles(pattern) ? null : RULE_PATTERN_ERROR)) });
}
