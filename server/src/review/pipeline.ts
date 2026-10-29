import type { Config } from "./config/schema.ts";
import { verdictFor, blockingFindings } from "./core/verdict.ts";
import {
  RESULT_SCHEMA_VERSION,
  type ChangeSet,
  type Finding,
  type LlmUsage,
  type Omission,
  type OmissionReason,
  type PipelineProgress,
  type RejectedFinding,
  type ReviewResult,
  type ReviewStatus,
  type RiskyArea,
  type ToolAnnotation,
  type Walkthrough,
} from "./core/models.ts";
import { mapLimit } from "./core/mapLimit.ts";
import { contextTokenBudget, estimateTokens, diffTokenBudget } from "./context/budget.ts";
import { planChunks, type Chunk } from "./context/chunk.ts";
import { gatherContext, type ContextSource, type ReachedCaller } from "./context/gather.ts";
import { floorBlastRadius, riskyAreas, withReach } from "./context/risk.ts";
import { classifyFiles } from "./context/ignore.ts";
import { MAX_MANIFEST_CHARS, MAX_REJECTED_CHARS, reviewSystemPrompt, type ManifestEntry } from "./llm/prompt.ts";
import { searchBudget } from "./agent/tools.ts";
import { ToolsUnsupportedError, toolsUnsupportedWarning, type GenerateAgentic } from "./llm/agentic.ts";
import { reviewChunkAgentic } from "./llm/agenticReview.ts";
import { errorMessage, failedUsage, spentBy, type Generate } from "./llm/providers.ts";
import { reviewChunk, type ChunkReview } from "./llm/review.ts";
import { generateWalkthrough, type WalkthroughIssues } from "./llm/walkthrough.ts";
import { compareFindings, validateFindings, validateToolFindings, type DropReason, type TaggedFinding } from "./validate/validator.ts";
import { verifyFindings } from "./validate/verify.ts";
import { checkPatternRules } from "./rules.ts";

export interface ReviewDeps {
  generate: Generate;
  now?: () => Date;
  // Passes run concurrently up to this many at once.
  concurrency?: number;
  // Surrounding code for each pass, when review.fileContext is on. Absent
  // means the passes see the diff alone.
  context?: ContextSource;
  // Passes that may call tools, when review.context is agentic. Needs
  // `context` as well, which the tools read through.
  generateAgentic?: GenerateAgentic;
  // Told each time the review moves on, for the dashboard; never awaited.
  onProgress?: (progress: PipelineProgress) => void;
}

export interface RunReviewInput {
  changeSet: ChangeSet;
  config: Config;
  // Carried into the result, e.g. an ignored repository config file.
  warnings?: string[];
  // Linked and candidate issues for the walkthrough, fetched by the caller.
  issues?: WalkthroughIssues;
  // Fingerprints this team dismissed on this change: a match is dropped before
  // it can be reported again. Fetched by the caller (see worker/runJob.ts).
  ignoredFingerprints?: ReadonlySet<string>;
  // Recent repo-wide dismissals, listed in the prompt so the model learns what
  // this team rejects. Fetched by the caller.
  rejectedFindings?: RejectedFinding[];
  // Review only these files of the change, and keep the earlier review's
  // findings on the rest (worker/incremental.ts). Absent means a full review.
  increment?: Increment;
  // Static analyzer results the forge already holds for the head revision,
  // fetched by the caller when review.toolFindings is on.
  toolAnnotations?: ToolAnnotation[];
}

export interface Increment {
  fromSha: string;
  toSha: string;
  // Paths in the change touched by commits since `fromSha`.
  paths: ReadonlySet<string>;
  // Findings from the review of `fromSha` on files outside `paths`. Those
  // files are the same at both heads, so their lines still hold.
  carried: Finding[];
  // Areas that review reached through callers. This run traces callers
  // from `paths` only, so without them the walkthrough's reach would
  // shrink to whatever the push touched. One can outlive the call that
  // reached it until the next full review, which only keeps the blast
  // radius at medium.
  carriedAreas?: RiskyArea[];
}

// Omissions that mean the change was not fully reviewed. Ignored, binary and
// deleted files were never meant to be.
const INCOMPLETE: ReadonlySet<OmissionReason> = new Set([
  "budget",
  "too_large",
  "patch_unavailable",
  "chunk_failed",
]);

// The title, description, guidance and previously-rejected list are bounded but
// not counted exactly, so they get a generous fixed allowance next to the
// measured system prompt. The last term covers the rejected section (its
// MAX_REJECTED_CHARS at ~4 chars/token) so it cannot crowd out the diff.
const USER_PROMPT_ALLOWANCE = 3_000 + Math.ceil(MAX_REJECTED_CHARS / 4);
// A multi-pass review also lists the whole change in every pass, capped at
// MAX_MANIFEST_CHARS.
const MANIFEST_ALLOWANCE = Math.ceil(MAX_MANIFEST_CHARS / 4);
// The agentic instructions and the tool definitions, on top of the review's.
const AGENTIC_ALLOWANCE = 2_000;

function lineCounts(changeSet: ChangeSet): ReviewResult["files"] {
  return changeSet.files.map((file) => {
    let additions = 0;
    let deletions = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.content.split("\n").slice(1)) {
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) deletions += 1;
      }
    }
    return {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      changeType: file.changeType,
      additions,
      deletions,
    };
  });
}

// A tool finding the model also reported: same file and category, with
// overlapping lines, or the very same fingerprint.
function sameProblem(model: Finding, tool: Finding): boolean {
  if (model.fingerprint === tool.fingerprint) return true;
  return (
    model.file === tool.file &&
    model.category === tool.category &&
    model.startLine <= tool.endLine &&
    tool.startLine <= model.endLine
  );
}

// One review, start to finish, with no I/O but the model calls. Every failure
// below the top is recorded in the result rather than thrown: a failed pass
// makes the review partial, a failed walkthrough is a warning.
export async function runReview(input: RunReviewInput, deps: ReviewDeps): Promise<ReviewResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { changeSet, config } = input;
  const errors: string[] = [];
  const warnings = [...(input.warnings ?? [])];
  const usage: LlmUsage[] = [];
  const report = deps.onProgress ?? (() => undefined);
  report({ stage: "planning" });

  const { reviewable, omissions: classified } = classifyFiles(changeSet.files, config.ignorePaths);
  // An incremental review plans passes over the files changed since the last
  // review only. The rest were reviewed then and are not omissions; the
  // walkthrough and manifest still describe the whole change.
  const { increment } = input;
  const scoped = increment ? reviewable.filter((file) => increment.paths.has(file.path)) : reviewable;
  const agentic = config.review.context === "agentic" && !!deps.generateAgentic && !!deps.context;
  if (config.review.context === "agentic" && !agentic) {
    warnings.push("Agentic context needs a code source and a tool-capable model call; passes used static context");
  }
  // An agentic pass's conversation grows by what its tools return, so that
  // much of the window is kept free of diff.
  let overhead =
    estimateTokens(reviewSystemPrompt(config)) +
    USER_PROMPT_ALLOWANCE +
    (agentic ? AGENTIC_ALLOWANCE + config.review.agent.maxToolTokens : 0);
  let plan = planChunks(scoped, diffTokenBudget(config, overhead), config.review.maxChunks);
  // Only a change that needs several passes gets the manifest, so only then is
  // it paid for, and a single-pass review is planned exactly as before. Should
  // the smaller budget ever leave one pass, the prompt simply omits the list.
  const multiPass = plan.chunks.length > 1;
  if (multiPass) {
    overhead += MANIFEST_ALLOWANCE;
    plan = planChunks(scoped, diffTokenBudget(config, overhead), config.review.maxChunks);
  }
  const omissions: Omission[] = [...classified, ...plan.omissions];

  // What the diff alone shows is ready now, so the walkthrough can weigh it
  // without waiting for context; callers traced below are added after.
  const diffRisks = riskyAreas(reviewable);
  // The walkthrough runs alongside, so it is a stage only while the review
  // is left waiting for it.
  let walkthroughSettled = false;
  const walkthroughTask: Promise<Walkthrough | undefined> =
    config.output.walkthrough && reviewable.length > 0
      ? generateWalkthrough(deps.generate, changeSet, reviewable, config, input.issues, diffRisks)
          .then(
            ({ walkthrough, usage: callUsage, failedUsage: failed }) => {
              usage.push(...failed, callUsage);
              return walkthrough;
            },
            (err: unknown) => {
              // A failed walkthrough still spent what its models billed.
              usage.push(...failedUsage(spentBy(err), "walkthrough"));
              warnings.push(`Walkthrough failed: ${errorMessage(err)}`);
              return undefined;
            },
          )
          .finally(() => {
            walkthroughSettled = true;
          })
      : Promise.resolve(undefined);
  const awaitWalkthrough = () => {
    if (!walkthroughSettled && config.output.walkthrough && reviewable.length > 0) report({ stage: "walkthrough" });
    return walkthroughTask;
  };

  // Gathered after planning, into whatever budget each pass has left, so it
  // can never cost the diff a hunk.
  let chunks: Chunk[] = plan.chunks;
  let reach: ReachedCaller[] = [];
  if (config.review.fileContext && deps.context && chunks.length > 0) {
    report({ stage: "context" });
    try {
      const gathered = await gatherContext({
        chunks,
        changeSet,
        source: deps.context,
        budgetFor: (chunk) => contextTokenBudget(config, overhead, chunk.tokens),
        concurrency: deps.concurrency ?? 3,
        depth: config.review.impactDepth,
      });
      chunks = chunks.map((chunk, index) => ({ ...chunk, context: gathered.contexts[index] ?? "" }));
      reach = gathered.reach;
      warnings.push(...gathered.warnings);
    } catch (err) {
      warnings.push(`Review context failed, the diff was reviewed without it: ${errorMessage(err)}`);
    }
  }

  // Several passes wait for the walkthrough (started above, alongside context
  // gathering) so each can be told what the files it cannot see do. A failed
  // walkthrough still leaves the file list.
  let manifest: ManifestEntry[] | undefined;
  if (multiPass) {
    const summaries = new Map(((await awaitWalkthrough())?.fileSummaries ?? []).map((entry) => [entry.path, entry.summary]));
    const paths = new Set(reviewable.map((file) => file.path));
    manifest = lineCounts(changeSet)
      .filter((file) => paths.has(file.path))
      .map((file) => {
        const summary = summaries.get(file.path);
        return summary ? { ...file, summary } : file;
      });
  }

  const raw: TaggedFinding[] = [];
  let failedPasses = 0;
  // Shared by every pass: GitHub rate-limits code search per token.
  const searches = searchBudget(config.review.agent.maxSearches);
  type PassOutcome =
    | { chunk: Chunk; review: ChunkReview; error?: undefined; spent?: undefined }
    | { chunk: Chunk; review?: undefined; error: string; spent: LlmUsage[] };
  const reviewPass = async (chunk: Chunk): Promise<PassOutcome> => {
    const review = () => reviewChunk(deps.generate, changeSet, chunk, chunks.length, config, input.rejectedFindings, manifest);
    if (!agentic) return { chunk, review: await review() };
    try {
      const { toolContext, ...result } = await reviewChunkAgentic(
        deps.generateAgentic!,
        changeSet,
        chunk,
        chunks.length,
        config,
        { source: deps.context!, searches },
        input.rejectedFindings,
        manifest,
      );
      return { chunk: toolContext ? { ...chunk, toolContext } : chunk, review: result };
    } catch (err) {
      if (!(err instanceof ToolsUnsupportedError)) throw err;
      // Without tools the pass is still worth a static review.
      const fallback = await review();
      const refused = failedUsage(err.spent, "review", chunk.index);
      return {
        chunk,
        review: {
          ...fallback,
          failedUsage: [...refused, ...fallback.failedUsage],
          warnings: [toolsUnsupportedWarning(err.model), ...fallback.warnings],
        },
      };
    }
  };
  let passesDone = 0;
  const reportPasses = () => report({ stage: "reviewing", passes: { done: passesDone, total: chunks.length } });
  reportPasses();
  const outcomes = await mapLimit(chunks, deps.concurrency ?? 3, async (chunk): Promise<PassOutcome> => {
    try {
      return await reviewPass(chunk);
    } catch (err) {
      return { chunk, error: errorMessage(err), spent: failedUsage(spentBy(err), "review", chunk.index) };
    } finally {
      passesDone += 1;
      reportPasses();
    }
  });
  for (const outcome of outcomes) {
    if (outcome.review) {
      const { model } = outcome.review.usage;
      raw.push(...outcome.review.findings.map((finding) => ({ ...finding, model })));
      usage.push(...outcome.review.failedUsage, outcome.review.usage);
      warnings.push(...outcome.review.warnings);
      continue;
    }
    usage.push(...outcome.spent);
    failedPasses += 1;
    errors.push(`Review pass ${outcome.chunk.index} failed: ${outcome.error}`);
    for (const part of outcome.chunk.parts) {
      omissions.push({ path: part.file.path, reason: "chunk_failed", detail: `pass ${outcome.chunk.index}` });
    }
  }
  const generated = await awaitWalkthrough();
  // The floor is applied here rather than left to the model, so a removed
  // auth check or a route the change reaches is never reported as small.
  // The areas themselves are part of the blast radius, so its setting keeps
  // them out of the stored result, where the dashboard would show them.
  const risks = generated ? withReach([...diffRisks, ...(increment?.carriedAreas ?? [])], reach) : [];
  const walkthrough: Walkthrough | undefined = generated && {
    ...generated,
    ...(risks.length
      ? {
          ...(config.output.walkthroughBlastRadius !== false ? { riskyAreas: risks } : {}),
          blastRadius: floorBlastRadius(generated.blastRadius, risks),
        }
      : {}),
  };

  // Files only count as reviewed if a pass that included them succeeded and
  // none of their hunks were left out.
  const incomplete = new Set(omissions.filter((o) => INCOMPLETE.has(o.reason)).map((o) => o.path));
  const succeeded = outcomes.filter((outcome) => outcome.review).flatMap((outcome) => outcome.chunk.parts);
  const reviewedFiles = [...new Set(succeeded.map((part) => part.file.path))].filter((path) => !incomplete.has(path));
  const validation = validateFindings(
    raw,
    changeSet,
    scoped.filter((file) => succeeded.some((part) => part.file === file)),
    config,
    input.ignoredFingerprints,
  );
  // After validation, so only findings that would be published are checked,
  // and before the verdict, so a refuted blocker cannot fail the status.
  if (config.review.verify !== "off") report({ stage: "verifying" });
  const verified = await verifyFindings({
    findings: validation.findings,
    changeSet,
    chunks: outcomes.filter((outcome) => outcome.review).map((outcome) => outcome.chunk),
    config,
    generate: deps.generate,
    concurrency: deps.concurrency ?? 3,
    ignoredFingerprints: input.ignoredFingerprints,
  });
  usage.push(...verified.usage);
  warnings.push(...verified.warnings);
  // Carried findings join after validation and verification: they passed both
  // when first reported, and only a dismissal since then removes them. A file
  // ignored since then drops its findings too, as a full review would (the
  // worker reviews in full when ignore_paths changes, this keeps it true here).
  // Tool findings skip verification (the analyzer is the evidence) and need
  // no successful pass, only a file in scope. Where the model reported the
  // same problem, its finding is kept: it explains more and may suggest a fix.
  const tools = config.review.toolFindings
    ? validateToolFindings(input.toolAnnotations ?? [], changeSet, scoped, config, input.ignoredFingerprints)
    : undefined;
  const toolFindings = (tools?.findings ?? []).filter(
    (finding) => !verified.findings.some((model) => sameProblem(model, finding)),
  );
  const toolDuplicates = (tools?.findings.length ?? 0) - toolFindings.length;
  // Pattern rules, like tool findings, skip verification (the match is the
  // evidence) and need only a file in scope, not a successful pass.
  // Files only the repository file or trigger ignores still get the
  // dashboard's pattern rules (ruleGuard); the model never saw them.
  const guardReviewable = config.ruleGuard ? classifyFiles(changeSet.files, config.ruleGuard.ignorePaths).reviewable : [];
  const reviewablePaths = new Set(reviewable.map((file) => file.path));
  const guardedPaths = new Set(guardReviewable.map((file) => file.path).filter((path) => !reviewablePaths.has(path)));
  const guardedOnly = guardReviewable.filter((file) => guardedPaths.has(file.path) && (!increment || increment.paths.has(file.path)));
  const patternRules = checkPatternRules(scoped, changeSet, config, input.ignoredFingerprints, guardedOnly);
  const reviewed = [...verified.findings, ...toolFindings, ...patternRules.findings].sort(compareFindings);
  // The cap covers model, tool and rule findings together; the model's own
  // were already capped by the validator.
  const overLimit = Math.max(0, reviewed.length - config.review.maxFindings);
  const fresh = new Set(reviewed.map((finding) => finding.fingerprint));
  const carried = (increment?.carried ?? []).filter(
    (finding) =>
      !increment?.paths.has(finding.file) &&
      (reviewablePaths.has(finding.file) || (finding.source === "rule" && guardedPaths.has(finding.file))) &&
      !fresh.has(finding.fingerprint) &&
      !input.ignoredFingerprints?.has(finding.fingerprint),
  );
  const capped = overLimit > 0 ? reviewed.slice(0, config.review.maxFindings) : reviewed;
  const findings = carried.length ? [...capped, ...carried].sort(compareFindings) : capped;
  const dropped: Partial<Record<DropReason, number>> = { ...validation.dropped };
  const extra: [DropReason, number][] = [
    ...(Object.entries(verified.dropped) as [DropReason, number][]),
    ...(Object.entries(tools?.dropped ?? {}) as [DropReason, number][]),
    ...(Object.entries(patternRules.dropped) as [DropReason, number][]),
    ["duplicate", toolDuplicates],
    ["over_limit", overLimit],
  ];
  for (const [reason, count] of extra) {
    if (count > 0) dropped[reason] = (dropped[reason] ?? 0) + count;
  }

  let status: ReviewStatus = "completed";
  if (plan.chunks.length > 0 && failedPasses === plan.chunks.length) status = "failed";
  else if (omissions.some((omission) => INCOMPLETE.has(omission.reason))) status = "partial";

  const blockOn = config.review.blockOn;
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    status,
    errors,
    // Passes and checks repeat the same note (one per call), so each is listed once.
    warnings: [...new Set(warnings)],
    change: {
      ...changeSet.forgeRef,
      title: changeSet.title,
      ...(changeSet.baseRef ? { baseRef: changeSet.baseRef } : {}),
      ...(changeSet.headRef ? { headRef: changeSet.headRef } : {}),
      isDraft: changeSet.isDraft,
    },
    files: lineCounts(changeSet),
    findings,
    ...(walkthrough ? { walkthrough } : {}),
    ...(increment
      ? {
          incremental: {
            fromSha: increment.fromSha,
            toSha: increment.toSha,
            files: scoped.map((file) => file.path),
            carried: carried.length,
          },
        }
      : {}),
    coverage: { reviewedFiles, omissions, passes: plan.chunks.length },
    validation: { dropped, demoted: validation.demoted + verified.demoted },
    usage,
    verdict: {
      verdict: verdictFor(status, findings, blockOn, config.review.toolFindingsBlock),
      blockOn,
      blocking: blockingFindings(findings, blockOn, config.review.toolFindingsBlock).map((finding) => finding.fingerprint),
    },
    startedAt,
    finishedAt: now().toISOString(),
  };
}
