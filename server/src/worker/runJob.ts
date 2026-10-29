import { env } from "../config/env.ts";
import type { ForgeConnection, IgnoreReason, ReviewJob } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { skipFilterReason } from "../review/config/filters.ts";
import { loadDashboardConfig, loadReviewConfig } from "../review/config/load.ts";
import type { Config } from "../review/config/schema.ts";
import type { ChangeSet, RejectedFinding, ToolAnnotation } from "../review/core/models.ts";
import { priceUsage } from "../review/core/pricing/pricing.ts";
import type { ContextSource } from "../review/context/gather.ts";
import { cacheKey, cached, forgeCache, type ForgeCache } from "../review/forge/cache.ts";
import { ForgeError } from "../review/forge/http.ts";
import type { CommitStatus } from "../review/forge/types.ts";
import { searchTerms } from "../review/forge/issues.ts";
import {
  abortableGenerate,
  createGenerate,
  modelChain,
  type ApiKeys,
  type Endpoint,
  type Generate,
  type GenerateOptions,
  type ProviderBaseUrls,
} from "../review/llm/providers.ts";
import {
  abortableGenerateAgentic,
  createGenerateAgentic,
  type GenerateAgentic,
} from "../review/llm/agentic.ts";
import type { WalkthroughIssues } from "../review/llm/walkthrough.ts";
import { runReview } from "../review/pipeline.ts";
import { publishes, publishReview, resolvesThreads } from "../review/publish/publisher.ts";
import { pendingStatus } from "../review/publish/status.ts";
import { summarize } from "../review/render/json.ts";
import { cancelledMarkdown, progressMarkdown } from "../review/render/progress.ts";
import { adapterForConnection, type Forge } from "../services/forge.ts";
import {
  CREDENTIALS_REJECTED_REASON,
  credentialsRefused,
  isCredentialRejection,
  recordCredentials,
} from "../services/providers/credentials.ts";
import { llmCredentialsFor } from "../services/llm.ts";
import { auditedGenerate, auditedGenerateAgentic, auditedProbe, type AuditContext } from "../services/llmAudit.ts";
import { guardModels, policyFor, type EffectivePolicy } from "../services/privacyPolicy.ts";
import type { Resolve } from "../lib/hostSafety.ts";
import { priceOverridesFor } from "../services/modelPrices.ts";
import { probeModel } from "../services/llmProbe.ts";
import { prepareCapabilities, type Probe } from "./capabilities.ts";
import { CLOSE_CHECK_INTERVAL_MS, watchForClose } from "./closeWatch.ts";
import { resolveLlm, type LlmCredentials } from "./llmEndpoint.ts";
import { incrementFor } from "./incremental.ts";
import { progressRecorder, type WriteProgress } from "./progress.ts";
import {
  ACCESS_LOST_REASON,
  claimState,
  CLOSED_REASON,
  complete,
  DISABLED_REASON,
  NO_REPOSITORY_REASON,
  recordTitle,
} from "./queue.ts";
import { findingLifecycle, findingTransitions, KNOWN_FINDING, syncFindings, threadOperations, type ThreadOutcome } from "./syncFindings.ts";

// How many recent dismissals to feed into the review prompt; bounded so a noisy
// repository cannot grow the prompt without limit.
const MAX_REJECTED_FINDINGS = 20;

export interface RunJobDeps {
  adapterFor: (connection: ForgeConnection) => Forge;
  // Whether the forge refuses the connection's credentials outright.
  credentialsRefused?: (connection: ForgeConnection) => Promise<boolean>;
  generateFor: (keys: ApiKeys, endpoint?: Endpoint, baseUrls?: ProviderBaseUrls, options?: GenerateOptions) => Generate;
  credentialsFor: (workspaceId: string) => Promise<LlmCredentials>;
  // Model calls for agentic passes (review.context: agentic).
  generateAgenticFor?: (
    keys: ApiKeys,
    endpoint?: Endpoint,
    baseUrls?: ProviderBaseUrls,
    options?: GenerateOptions,
  ) => GenerateAgentic;
  // Checks what a model supports the first time a review needs to know.
  probe?: Probe;
  // Absent means every read goes to the forge, as with review.disableCache.
  cache?: ForgeCache;
  closeCheckIntervalMs?: number;
  // The workspace's effective privacy policy, and the DNS lookup local-only
  // mode checks hosts with.
  policyFor?: (workspaceId: string) => Promise<EffectivePolicy>;
  resolveHost?: Resolve;
  // Where the dashboard's progress is written; absent means the job row.
  recordProgress?: WriteProgress;
}

const defaultDeps: RunJobDeps = {
  adapterFor: adapterForConnection,
  credentialsRefused,
  generateFor: createGenerate,
  credentialsFor: llmCredentialsFor,
  cache: forgeCache,
};

// Decided here rather than in the webhook handler, because only now is the
// full configuration known, including the repository file. A manual review is
// never skipped; someone asked for it, and so did a permitted review command.
export function skipReason(
  job: { trigger: ReviewJob["trigger"]; event?: string | null; actor?: string | null },
  config: Config,
  change: Parameters<typeof skipFilterReason>[1] & { isDraft: boolean },
): string | null {
  const { triggers } = config;
  if (job.trigger === "webhook") {
    if (triggers.review === "manual") return "Automatic reviews are turned off for this repository";
    if (change.isDraft && triggers.review !== "all") return "Draft changes are not reviewed automatically";
    if (job.event === "push" && !triggers.reviewOnPush) return "New commits are not reviewed automatically";
    return skipFilterReason(triggers, change, job.actor);
  }
  if (job.trigger === "comment" && !triggers.command) {
    return "Review commands are turned off for this repository";
  }
  return null;
}

// Automatic reviews include the walkthrough only when the summary trigger
// allows it; a requested review follows the walkthrough setting alone.
export function walkthroughEnabled(trigger: ReviewJob["trigger"], config: Config, isDraft: boolean): boolean {
  if (!config.output.walkthrough) return false;
  if (trigger !== "webhook") return true;
  return config.triggers.summary === "published" && !isDraft;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Issues for the walkthrough, best effort: a tracker the token cannot read
// (or one that is turned off) costs a warning, never the review.
async function walkthroughIssues(forge: Forge, changeSet: ChangeSet, config: Config, warnings: string[]): Promise<WalkthroughIssues> {
  const issues: WalkthroughIssues = {};
  if (config.output.assessLinkedIssues) {
    issues.linked = await forge.getLinkedIssues(changeSet).catch((err: unknown) => {
      warnings.push(`Linked issues could not be read: ${message(err)}`);
      return undefined;
    });
  }
  if (config.output.relatedIssues) {
    const terms = searchTerms(changeSet.title);
    const linked = new Set((issues.linked ?? []).map((issue) => issue.ref));
    const found = terms.length
      ? await forge.searchIssues(changeSet.forgeRef.project, terms).catch((err: unknown) => {
          warnings.push(`Related issues could not be searched: ${message(err)}`);
          return undefined;
        })
      : [];
    issues.candidates = found?.filter((issue) => !linked.has(issue.ref));
  }
  return issues;
}

// Static analyzer results, best effort like the issues above: a forge that
// will not show them (most often a GitHub App without the Checks permission)
// costs a warning, and the review goes on with the model's findings alone.
async function toolAnnotations(forge: Forge, changeSet: ChangeSet, warnings: string[]): Promise<ToolAnnotation[] | undefined> {
  try {
    const results = await forge.getToolAnnotations(changeSet.forgeRef);
    warnings.push(...results.warnings);
    return results.annotations;
  } catch (err) {
    const denied = err instanceof ForgeError && (err.status === 403 || err.status === 404);
    warnings.push(
      denied && changeSet.forgeRef.provider === "github"
        ? "Static analysis results could not be read; the GitHub App needs the Checks (read) permission"
        : `Static analysis results could not be read: ${message(err)}`,
    );
    return undefined;
  }
}

function connectionRefused(connection: ForgeConnection, deps: RunJobDeps): Promise<boolean> {
  return (deps.credentialsRefused ?? credentialsRefused)(connection);
}

// Loads everything a review needs, runs it, publishes it and stores the
// result. Anything thrown before the review starts (the repository vanished,
// the forge is down, no model key) fails the job through the worker, and
// nothing has been posted yet. Problems inside the review or while publishing
// are recorded instead.
export async function runJob(job: ReviewJob, deps: RunJobDeps = defaultDeps): Promise<void> {
  const repo = await prisma.repository.findUnique({
    where: { id: job.repositoryId },
    include: { connection: { include: { workspace: { select: { reviewSettings: true, name: true } } } } },
  });
  if (!repo) {
    throw new Error(NO_REPOSITORY_REASON);
  }
  // Turning a repository off cancels its jobs, but one claimed just before the
  // cancel still lands here. Checked here rather than in claimNext, which would
  // leave such a job queued until the repository came back on.
  if (!repo.enabled) {
    const error = repo.accessLostAt ? ACCESS_LOST_REASON : DISABLED_REASON;
    await complete(job.id, { status: "skipped", verdict: null, error });
    return;
  }
  // Queued before the forge refused the credentials. Dashboard reviews and
  // reruns still get a run, which doubles as a check of a replaced token;
  // `/sentryward review` comments arrive through the paused repository hook
  // and are dropped there.
  if (repo.connection.credentialsRejectedAt && job.trigger === "webhook") {
    await complete(job.id, { status: "skipped", verdict: null, error: CREDENTIALS_REJECTED_REASON });
    return;
  }

  const progress = progressRecorder(job, deps.recordProgress);
  progress.set({ stage: "fetching" });
  const forge = deps.adapterFor(repo.connection);
  const saved = {
    globalSettings: repo.connection.workspace.reviewSettings,
    repoSettings: repo.settings,
    followGlobal: repo.followGlobal,
  };
  // The repository file can only be read once the change is known, so the
  // first reads go by the dashboard settings alone.
  const cacheFor = (disabled: boolean) => (disabled ? undefined : deps.cache);
  const savedDisablesCache = loadDashboardConfig(saved).review.disableCache;
  // The PR may have moved since the job was queued; review what is there now
  // and record which head that was.
  let changeSet;
  try {
    changeSet = await forge.getChange(repo.fullPath, job.number, cacheFor(savedDisablesCache));
  } catch (err) {
    // A refusal for one change (a deleted MR, a repository the token lost)
    // says nothing about the connection, so it is flagged only when the
    // account check is refused too. GitHub App connections are never flagged
    // (an uninstall detaches them), so they skip the extra check.
    const refused =
      repo.connection.kind !== "github_app" &&
      isCredentialRejection(err) &&
      (await connectionRefused(repo.connection, deps).catch(() => false));
    if (!refused) throw err;
    await recordCredentials(repo.connection, false);
    throw new Error(CREDENTIALS_REJECTED_REASON);
  }
  if (repo.connection.credentialsRejectedAt) await recordCredentials(repo.connection, true);
  // Stored now, not with the result, so a run that is skipped, cancelled or
  // fails from here on can still be found by the change's title.
  await recordTitle(job.id, changeSet.title);
  const loaded = await loadReviewConfig({
    adapter: forge,
    project: repo.fullPath,
    ref: changeSet.forgeRef.baseSha,
    ...saved,
    cache: cacheFor(savedDisablesCache),
  });

  const { config } = loaded;
  // The repository file asked for fresh reads after a cached one was used.
  if (config.review.disableCache && !savedDisablesCache && deps.cache) {
    changeSet = await forge.getChange(repo.fullPath, job.number);
    await recordTitle(job.id, changeSet.title);
  }
  const skip = skipReason(job, config, changeSet);
  if (skip) {
    await complete(job.id, {
      status: "skipped",
      verdict: null,
      resolvedConfig: { config, sources: loaded.sources, repoFile: loaded.repoFile },
      error: skip,
      headSha: changeSet.forgeRef.headSha,
      baseSha: changeSet.forgeRef.baseSha,
    });
    return;
  }

  progress.plan([
    "fetching",
    "preparing",
    "reviewing",
    ...(config.review.verify !== "off" ? (["verifying"] as const) : []),
    ...(publishes(config) ? (["publishing"] as const) : []),
  ]);
  progress.set({ stage: "preparing" });
  const walkthrough = walkthroughEnabled(job.trigger, config, changeSet.isDraft);
  // Only the models this review will call are checked, so a walkthrough or
  // verify model left set while that pass is off does not fail the job.
  const primary = [modelChain(config.llm, "review")[0]];
  if (walkthrough) primary.push(modelChain(config.llm, "walkthrough")[0]);
  if (config.review.verify !== "off") primary.push(modelChain(config.llm, "verify")[0]);
  const models = [...new Set(primary)];

  // Prices are loaded before any model call, so a failed lookup ends the job
  // before tokens are spent rather than losing a review already paid for.
  const [credentials, priceOverrides] = await Promise.all([
    deps.credentialsFor(repo.connection.workspaceId),
    priceOverridesFor(repo.connection.workspaceId),
  ]);
  const { keys, baseUrls, endpoint, fallbackModels: keyed, warnings: llmWarnings } = resolveLlm(config, models, credentials);
  const warnings = [...loaded.warnings, ...llmWarnings];

  // The privacy policy is checked against every model this run may call before
  // anything is posted: a refused primary model fails the job with the policy's
  // reason, a refused fallback is left out as an unkeyed one is. The repository
  // file can name any model, so this is checked here rather than on save.
  const policy = await (deps.policyFor ?? policyFor)(repo.connection.workspaceId);
  const configured = [...modelChain(config.llm, "review"), ...modelChain(config.llm, "walkthrough"), ...modelChain(config.llm, "verify")];
  const guard = await guardModels(policy, [...models, ...keyed, ...configured], endpoint, baseUrls, deps.resolveHost);
  const refused = models.find((model) => guard.rejected.has(model));
  if (refused) throw guard.rejected.get(refused)!;
  const fallbackModels = keyed.filter((model) => {
    const violation = guard.rejected.get(model);
    if (violation) warnings.push(`Fallback model ${model} skipped: ${violation.message}`);
    return !violation;
  });
  const reviewConfig: Config = { ...config, llm: { ...config.llm, fallbackModels } };
  const audit: AuditContext = {
    workspaceId: repo.connection.workspaceId,
    workspaceName: repo.connection.workspace.name,
    repositoryId: repo.id,
    repository: `${repo.host}/${repo.fullPath}`,
    changeNumber: job.number,
    jobId: job.id,
  };

  const targetUrl = `${env.CLIENT_ORIGIN}/reviews/${job.id}`;
  const ref = changeSet.forgeRef;
  const resolvedConfig = { config, sources: loaded.sources, repoFile: loaded.repoFile };

  // A person can cancel any running job, so it is always watched. Closing the
  // change cancels its queued jobs from the webhook; with abortOnClose this also
  // catches the rest: a close the webhook missed, and one that lands mid-review.
  // A run that lost its claim (failed on timeout, or recovered and claimed
  // again) stops too, so it never publishes for a job it no longer owns.
  let cancelledBy: "manual" | "closed" | "disabled" | "lost" | undefined;
  const ownsClaim = async () => {
    const claim = await claimState(job.id, job.attempts);
    if (claim === "owned") return true;
    cancelledBy = claim === "cancelled" ? "manual" : claim;
    return false;
  };
  const watch = watchForClose(async () => {
    if (!(await ownsClaim())) return true;
    if (!config.triggers.abortOnClose) return false;
    const { state } = await forge.getChangeHead(repo.fullPath, job.number);
    if (state !== "closed" && state !== "merged") return false;
    cancelledBy = "closed";
    return true;
  }, deps.closeCheckIntervalMs ?? CLOSE_CHECK_INTERVAL_MS);
  // Whether the summary comment (progress note or review) is on the change, so
  // a cancel knows to replace it.
  let summaryPosted = false;
  const cancel = async (posted: boolean) => {
    watch.stop();
    // The job belongs to whoever holds it now: the worker that failed it, or
    // another run that claimed it again. complete() only checks the status, so
    // writing here could finish that run's job, and a status could overwrite
    // its pending one.
    if (cancelledBy === "lost") return;
    const reason =
      cancelledBy === "closed" ? CLOSED_REASON : cancelledBy === "disabled" ? DISABLED_REASON : "Review cancelled";
    // Best effort, and only over what this run already put on the change.
    if (summaryPosted) {
      await forge.upsertSummaryComment(ref, cancelledMarkdown(reason)).catch(() => undefined);
    }
    if (posted && config.output.postCheck) {
      // A repository turned off runs no more reviews, so an error here would
      // block a required check for good; success clears it.
      const status: CommitStatus =
        cancelledBy === "disabled"
          ? { state: "success", description: "Reviews turned off for this repository", targetUrl }
          : {
              state: "error",
              description: cancelledBy === "closed" ? "Review cancelled: the change was closed" : "Review cancelled",
              targetUrl,
            };
      await forge.setCommitStatus(ref, status).catch(() => undefined);
    }
    // A manual or turn-off cancel already stored its reason and status, so
    // this only finishes a job the change being closed stopped.
    await complete(job.id, {
      status: "cancelled",
      verdict: null,
      resolvedConfig,
      error: reason,
      headSha: ref.headSha,
      baseSha: ref.baseSha,
    });
  };
  if (await watch.closedNow()) {
    await cancel(false);
    return;
  }

  if (publishes(config)) {
    // Best effort: a review must not fail because its progress note did.
    if (config.output.postSummary) {
      const outputs = { walkthrough, inline: config.output.postInline, status: config.output.postCheck };
      await forge
        .upsertSummaryComment(ref, progressMarkdown(changeSet, outputs))
        .then(() => {
          summaryPosted = true;
        })
        .catch((err: unknown) => {
          warnings.push(`Progress comment failed: ${message(err)}`);
        });
    }
    if (config.output.postCheck) {
      await forge.setCommitStatus(ref, pendingStatus(targetUrl)).catch((err: unknown) => {
        warnings.push(`Pending status failed: ${message(err)}`);
      });
    }
  }

  const issues = walkthrough ? await walkthroughIssues(forge, changeSet, config, warnings) : undefined;
  // Probed with the fallbacks the policy allows, not every configured one.
  const capabilities = await prepareCapabilities({
    workspaceId: repo.connection.workspaceId,
    config: reviewConfig,
    keys,
    endpoint,
    baseUrls,
    probe: auditedProbe(deps.probe ?? probeModel, audit, guard),
    warnings,
  });
  const generateOptions: GenerateOptions = { ledger: capabilities.ledger, override: config.llm.capabilities };
  const generate = auditedGenerate(deps.generateFor(keys, endpoint, baseUrls, generateOptions), guard.target, audit, guard);
  const generateAgentic =
    config.review.context === "agentic"
      ? auditedGenerateAgentic(
          (deps.generateAgenticFor ?? createGenerateAgentic)(keys, endpoint, baseUrls, generateOptions),
          guard.target,
          audit,
          guard,
        )
      : undefined;
  // Files at the head sha never change, so they share the config file's cache
  // key shape. Code search results are not fixed by a sha and stay uncached.
  const fileCache = cacheFor(config.review.disableCache);
  const context: ContextSource = {
    readFile: (path) =>
      cached(fileCache, cacheKey("file", forge.host, repo.fullPath, path, ref.headSha), () =>
        forge.getFileAtRef(repo.fullPath, path, ref.headSha),
      ),
    searchCode: (term) => forge.searchCode(repo.fullPath, term, ref.headSha),
  };
  // Findings this team dismissed as false positives or deliberate: never repost
  // them on this change, and tell the model what the repo has recently rejected.
  // fix_later / not_specified are not suppression signals.
  let ignoredFingerprints: Set<string> | undefined;
  let rejectedFindings: RejectedFinding[] | undefined;
  if (config.review.suppressIgnored) {
    const dismissed = { in: ["false_positive", "intentional"] satisfies IgnoreReason[] };
    const [sameChange, recent] = await Promise.all([
      prisma.finding.findMany({
        where: { repositoryId: repo.id, number: job.number, state: "ignored", ignoreReason: dismissed },
        select: { fingerprint: true },
      }),
      prisma.finding.findMany({
        where: { repositoryId: repo.id, state: "ignored", ignoreReason: dismissed },
        orderBy: { ignoredAt: "desc" },
        take: MAX_REJECTED_FINDINGS,
        select: { title: true, category: true, file: true, ignoreNote: true },
      }),
    ]);
    ignoredFingerprints = new Set(sameChange.map((row) => row.fingerprint));
    rejectedFindings = recent.map((row) => ({
      title: row.title,
      category: row.category,
      file: row.file,
      ...(row.ignoreNote ? { note: row.ignoreNote } : {}),
    }));
  }

  const tools = config.review.toolFindings ? await toolAnnotations(forge, changeSet, warnings) : undefined;

  const increment = await incrementFor({
    job,
    project: repo.fullPath,
    changeSet,
    config,
    forge,
    cache: fileCache,
    warnings,
  });

  let result;
  try {
    result = await runReview(
      {
        changeSet,
        config: { ...reviewConfig, output: { ...config.output, walkthrough } },
        warnings,
        issues,
        ignoredFingerprints,
        rejectedFindings,
        increment,
        toolAnnotations: tools,
      },
      {
        generate: abortableGenerate(generate, watch.signal),
        context,
        onProgress: progress.set,
        ...(generateAgentic ? { generateAgentic: abortableGenerateAgentic(generateAgentic, watch.signal) } : {}),
      },
    );
  } finally {
    watch.stop();
    // What the calls learned holds whether or not this run is kept.
    await capabilities.persist();
  }
  if (capabilities.usage.length) result = { ...result, usage: [...capabilities.usage, ...result.usage] };
  // Costs are fixed here, at the workspace's prices, before anything renders
  // or stores them.
  result = { ...result, usage: priceUsage(result.usage, priceOverrides) };
  // Nothing is published for a review cancelled or a change no longer open.
  if (await watch.closedNow()) {
    await cancel(publishes(config));
    return;
  }

  // What became of the earlier findings goes into the result itself, so the
  // summary comment and any later re-render of it show the same thing.
  const findings = await prisma.finding.findMany({
    where: { repositoryId: repo.id, number: job.number },
    select: KNOWN_FINDING,
  });
  const lifecycle = findingLifecycle(findings, result);
  if (lifecycle) result = { ...result, lifecycle };

  let publication = null;
  let threadOutcome: ThreadOutcome | null = null;
  if (publishes(config)) {
    const already = await prisma.postedFinding.findMany({
      where: { repositoryId: repo.id, number: job.number },
      select: { fingerprint: true },
    });
    // The same transitions syncFindings writes after the job is stored, plus
    // thread updates an earlier run could not make.
    const threads = threadOperations(findings, findingTransitions(findings, result));
    progress.set({ stage: "publishing" });
    publication = await publishReview({
      publisher: forge,
      changeSet,
      result,
      config,
      postedFingerprints: new Set(already.map((row) => row.fingerprint)),
      resolvedFingerprints: threads.resolve,
      reopenedFingerprints: threads.reopen,
      targetUrl,
      // A cancel can land while publishing; the watch is stopped by now, so
      // the claim is checked before each step instead.
      proceed: ownsClaim,
    });
    if (publication.summaryCommentId) summaryPosted = true;
    if (resolvesThreads(config)) {
      threadOutcome = { attempted: [...threads.resolve, ...threads.reopen], failed: publication.threadsFailed ?? [] };
    }
    if (publication.inlinePosted.length) {
      await prisma.postedFinding.createMany({
        data: publication.inlinePosted.map((posted) => ({
          repositoryId: repo.id,
          number: job.number,
          fingerprint: posted.fingerprint,
          forgeCommentId: posted.forgeCommentId,
        })),
        skipDuplicates: true,
      });
    }
    // The comments that did go up are recorded above so a later run does not
    // repost them; the job itself keeps the cancel, and findings are not synced.
    if (publication.stopped) {
      await cancel(true);
      return;
    }
  }

  // A review that ran but could not be fully published is partial: the result
  // stands, and the job says what did not reach the forge.
  const errors = [...result.errors, ...(publication?.errors ?? [])];
  const status = result.status === "completed" && publication?.errors.length ? "partial" : result.status;
  // Writes after this find the job finished and change nothing; waiting just
  // keeps them from racing the result.
  await progress.flush();
  const stored = await complete(job.id, {
    status,
    verdict: result.verdict.verdict,
    result,
    summary: summarize(result),
    publication,
    resolvedConfig,
    error: errors.length ? errors.join("\n") : null,
    headSha: ref.headSha,
    baseSha: ref.baseSha,
  });
  // A run superseded or cancelled meanwhile no longer speaks for the change.
  // The review itself is stored by now, so a failed sync must not fail the job.
  if (stored) {
    await syncFindings({
      repositoryId: repo.id,
      number: job.number,
      jobId: job.id,
      author: changeSet.author,
      result,
      threads: threadOutcome,
    }).catch(
      (err: unknown) => console.error(`[worker] could not sync findings for job ${job.id}`, err),
    );
  }
}
