import { isDeepStrictEqual } from "node:util";
import type { ReviewJob } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { DEFAULT_CONFIG, type Config } from "../review/config/schema.ts";
import { reviewResultSchema, type ChangeSet } from "../review/core/models.ts";
import { isAgentFilePath } from "../review/context/agentFiles.ts";
import type { ForgeCache } from "../review/forge/cache.ts";
import type { ForgeAdapter } from "../review/forge/types.ts";
import type { Increment } from "../review/pipeline.ts";

export interface IncrementInput {
  job: Pick<ReviewJob, "id" | "repositoryId" | "number" | "trigger" | "event">;
  project: string;
  changeSet: ChangeSet;
  config: Config;
  forge: Pick<ForgeAdapter, "compareCommits">;
  cache?: ForgeCache;
  // Why a push that could have been incremental was reviewed in full.
  warnings: string[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The settings that decide which findings a file gets. Carried findings were
// made under the last review's settings, and a file it ignored was never
// reviewed, so a change to any of these needs every file read again. Verdict
// and publishing settings apply to carried findings as they are.
function reviewSettings(config: Config) {
  const { disableCache: _disableCache, blockOn: _blockOn, ...review } = config.review;
  // Through JSON, as the stored copy was, so an unset optional compares equal.
  return JSON.parse(
    JSON.stringify({
      llm: config.llm,
      review,
      ignorePaths: config.ignorePaths,
      instructions: config.instructions,
      languageInstructions: config.languageInstructions,
      // Configs stored before rules existed have none, which is no rules, so
      // they do not force a full review.
      rules: config.rules ?? [],
      // A reviewer added, removed or rescoped changes which files get its
      // pass, and carried findings would keep a removed one's reports. As
      // with rules, configs stored before reviewers existed have none.
      reviewers: config.reviewers ?? [],
    }),
  ) as unknown;
}

// Why the instruction files may differ from the ones the last review read, or
// null when they cannot. Any changed instruction file counts, even one in a
// folder this change does not touch: such edits are rare, and a full review is
// the safe side to err on.
async function agentFilesChanged(
  forge: Pick<ForgeAdapter, "compareCommits">,
  project: string,
  lastBase: string | null,
  base: string,
  cache: ForgeCache | undefined,
): Promise<string | null> {
  if (!lastBase) return "the last review's base revision is unknown, so its agent instruction files cannot be compared";
  if (lastBase === base) return null;
  let changed: string[] | null;
  try {
    changed = await forge.compareCommits(project, lastBase, base, cache);
  } catch (err) {
    return `the base revisions could not be compared for agent instruction file changes: ${message(err)}`;
  }
  if (!changed) return `the last review's base ${lastBase.slice(0, 7)} is no longer an ancestor of the base`;
  return changed.some(isAgentFilePath)
    ? "agent instruction files changed on the base branch since the last review"
    : null;
}

function storedConfig(resolvedConfig: unknown): Config | undefined {
  const config = (resolvedConfig as { config?: Config } | null)?.config;
  return config?.review && config.llm ? config : undefined;
}

// What a push-triggered review may skip: the files no commit touched since the
// last review, as long as that review read the whole change and its head is
// still in the branch's history. Anything else (a manual or command request,
// a partial or failed last review, a force push) is a full review, so the
// worst case is the cost this saves, never a file left unreviewed.
export async function incrementFor({
  job,
  project,
  changeSet,
  config,
  forge,
  cache,
  warnings,
}: IncrementInput): Promise<Increment | undefined> {
  if (job.trigger !== "webhook" || job.event !== "push" || config.triggers.fullReviewOnPush) return undefined;

  // The latest review that ran speaks for the change: findings were last
  // synced from it, so an older completed one behind a partial one would
  // carry findings that run may since have resolved.
  const last = await prisma.reviewJob.findFirst({
    where: {
      repositoryId: job.repositoryId,
      number: job.number,
      status: { in: ["completed", "partial"] },
      id: { not: job.id },
      // A trial's findings were never synced, so it cannot be built on.
      trial: false,
    },
    orderBy: { finishedAt: "desc" },
    select: { headSha: true, baseSha: true, result: true, resolvedConfig: true },
  });
  if (!last) return undefined;
  const parsed = reviewResultSchema.safeParse(last.result);
  if (!parsed.success || parsed.data.status !== "completed") return undefined;
  const previous = parsed.data;
  const stored = storedConfig(last.resolvedConfig);
  // Configs stored before review.impactDepth or review.agentFiles existed
  // have none. Caller context only adds evidence to findings, so it does not
  // force a full review. Agent files were off for every review stored before
  // the setting existed, so the default (off) is what that review used:
  // turning them on since still forces one.
  const lastConfig = stored && {
    ...stored,
    review: {
      ...stored.review,
      impactDepth: stored.review.impactDepth ?? config.review.impactDepth,
      agentFiles: stored.review.agentFiles ?? DEFAULT_CONFIG.review.agentFiles,
    },
  };
  if (!lastConfig || !isDeepStrictEqual(reviewSettings(lastConfig), reviewSettings(config))) {
    warnings.push("Full review: the review settings changed since the last review");
    return undefined;
  }

  // Agent instruction files are read from the base revision, so the settings
  // alone cannot say whether carried findings saw the same guidance: an edit
  // merged to the base branch since then needs every file read again under it.
  if (config.review.agentFiles.enabled) {
    const reason = await agentFilesChanged(forge, project, last.baseSha, changeSet.forgeRef.baseSha, cache);
    if (reason) {
      warnings.push(`Full review: ${reason}`);
      return undefined;
    }
  }

  const toSha = changeSet.forgeRef.headSha;
  const short = last.headSha.slice(0, 7);
  let changed: string[] | null;
  try {
    changed = await forge.compareCommits(project, last.headSha, toSha, cache);
  } catch (err) {
    warnings.push(`Full review: the commits since ${short} could not be compared: ${message(err)}`);
    return undefined;
  }
  if (!changed) {
    warnings.push(`Full review: the last reviewed commit ${short} is no longer an ancestor of the head (force push or rebase)`);
    return undefined;
  }

  // Only files of the change count: a merge from the base branch brings in
  // commits whose files are not part of it.
  const touched = new Set(changed);
  const paths = new Set(
    changeSet.files
      .filter((file) => touched.has(file.path) || (file.previousPath !== undefined && touched.has(file.previousPath)))
      .map((file) => file.path),
  );
  return {
    fromSha: last.headSha,
    toSha,
    paths,
    carried: previous.findings.filter((finding) => !paths.has(finding.file)),
    carriedAreas: previous.walkthrough?.riskyAreas?.filter((area) => area.via) ?? [],
  };
}
