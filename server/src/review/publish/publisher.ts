import type { Config } from "../config/schema.ts";
import type { ChangeSet, ReviewResult } from "../core/models.ts";
import type { ForgePublisher, PostedComment } from "../forge/types.ts";
import { inlineLimits, inlineSelection } from "../core/buckets.ts";
import { WALKTHROUGH_MARKER, withDescriptionSummary } from "../core/markers.ts";
import { descriptionSummaryBlock, toMarkdown, walkthroughMarkdown, walkthroughOptions } from "../render/markdown.ts";
import { inlineComments } from "./inline.ts";
import { labelChanges } from "./labels.ts";
import { commitStatus } from "./status.ts";

export interface PublishInput {
  publisher: ForgePublisher;
  changeSet: ChangeSet;
  result: ReviewResult;
  config: Config;
  // Fingerprints already posted on this change, from the database.
  postedFingerprints: Set<string>;
  // Threads to resolve, or reopen (threadOperations): this run's transitions
  // plus earlier updates that failed.
  resolvedFingerprints?: string[];
  reopenedFingerprints?: string[];
  // Where the commit status links: the review in the dashboard.
  targetUrl?: string;
  // Asked before each step; false stops publishing (the job was cancelled).
  proceed?: () => Promise<boolean>;
}

export interface Publication {
  inlinePosted: PostedComment[];
  inlineSkipped: number;
  inlineFailed: { fingerprint: string; error: string }[];
  summaryCommentId: string | null;
  statusState: string | null;
  // Where the walkthrough went, when it was published. Older rows may say
  // "description", from before it moved into the review comment.
  walkthroughLocation?: "description" | "comment" | null;
  labels?: string[];
  // Inline threads this run resolved or reopened, by fingerprint.
  threadsResolved?: string[];
  threadsReopened?: string[];
  // Threads that could not be moved; they are retried on the next run.
  threadsFailed?: string[];
  // Publishing stopped partway because proceed() said so.
  stopped?: boolean;
  // ReviewResult.heldBack as this run decided it; the caller stores it in the
  // result so a re-render of the summary holds back the same findings.
  heldBack?: string[];
  errors: string[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Inline comments, the summary and the commit status are published
// independently: one failing never stops the others, and each failure is
// recorded rather than thrown. A cancel is checked between steps: a write
// already under way still finishes, but nothing after it is sent.
export async function publishReview(input: PublishInput): Promise<Publication> {
  const { publisher, changeSet, config } = input;
  const ref = changeSet.forgeRef;
  // Which findings get a thread depends on the threads already on the change,
  // so it is decided before the summary, which lists the rest. The forge's
  // own markers cover a database row that was never written.
  let posted = input.postedFingerprints;
  if (config.output.postInline) {
    const onForge = await publisher.listPostedFingerprints(ref).catch(() => new Set<string>());
    posted = new Set([...posted, ...onForge]);
  }
  const result = withInlineSelection(config, input.result, posted);
  const publication: Publication = {
    inlinePosted: [],
    inlineSkipped: 0,
    inlineFailed: [],
    summaryCommentId: null,
    statusState: null,
    walkthroughLocation: null,
    labels: [],
    threadsResolved: [],
    threadsReopened: [],
    threadsFailed: [],
    errors: [],
    ...(result.heldBack ? { heldBack: result.heldBack } : {}),
  };
  const placement = summaryPlacement(config, result);
  const halted = async () => {
    if (!input.proceed || (await input.proceed())) return false;
    publication.stopped = true;
    return true;
  };

  // The summary goes first so it sits at the top of the conversation, above
  // the inline comments, even when no progress comment was posted.
  if (await halted()) return publication;
  if (placement.summary !== null) {
    try {
      // A clean review under output.summaryOnlyWithFindings only updates a
      // summary an earlier run left, so it stops showing findings now gone.
      publication.summaryCommentId = await publisher.upsertSummaryComment(ref, placement.summary, {
        create: placement.summaryCreate,
      });
      if (publication.summaryCommentId && placement.walkthrough) publication.walkthroughLocation = "comment";
    } catch (err) {
      publication.errors.push(`Summary comment failed: ${message(err)}`);
    }
  }

  if (placement.walkthroughComment !== null) {
    if (await halted()) return publication;
    try {
      await publisher.upsertComment(ref, WALKTHROUGH_MARKER, placement.walkthroughComment);
      publication.walkthroughLocation = "comment";
    } catch (err) {
      publication.errors.push(`Summary comment failed: ${message(err)}`);
    }
  }

  if (config.output.postInline) {
    if (await halted()) return publication;
    try {
      const heldBack = new Set(result.heldBack ?? []);
      const comments = inlineComments(result.findings, changeSet, ref.provider, posted, {
        agentPrompt: config.output.agentPrompts,
        rules: config.rules,
        heldBack,
      });
      // A finding with a thread is never held back, so this counts every
      // thread this review stands behind that was already there.
      publication.inlineSkipped = result.findings.filter((f) => f.bucket === "actionable" && posted.has(f.fingerprint)).length;
      const outcome = await publisher.postInlineComments(ref, comments);
      publication.inlinePosted = outcome.posted;
      publication.inlineFailed = outcome.failed;
      if (outcome.failed.length) {
        publication.errors.push(`${outcome.failed.length} inline comment(s) could not be posted`);
      }
    } catch (err) {
      publication.errors.push(`Inline comments failed: ${message(err)}`);
    }
  }

  // Threads follow the findings table: only what this run resolved or brought
  // back is touched, so a thread someone resolved or reopened by hand stays so.
  if (resolvesThreads(config)) {
    const steps = [
      { prints: input.resolvedFingerprints ?? [], resolved: true, verb: "resolved" },
      { prints: input.reopenedFingerprints ?? [], resolved: false, verb: "reopened" },
    ] as const;
    for (const step of steps) {
      if (step.prints.length === 0) continue;
      if (await halted()) return publication;
      try {
        const outcome = await publisher.setThreadsResolved(ref, step.prints, step.resolved);
        if (step.resolved) publication.threadsResolved = outcome.updated;
        else publication.threadsReopened = outcome.updated;
        if (outcome.failed.length) {
          publication.threadsFailed!.push(...outcome.failed.map((f) => f.fingerprint));
          publication.errors.push(`${outcome.failed.length} inline thread(s) could not be ${step.verb}`);
        }
      } catch (err) {
        publication.threadsFailed!.push(...step.prints);
        publication.errors.push(`Inline threads could not be ${step.verb}: ${message(err)}`);
      }
    }
  }

  // The high-level summary, when it goes in the description, plus
  // housekeeping for changes an earlier version wrote the walkthrough into.
  // Adapters skip the write when nothing changed. Only a summary this run
  // meant to write counts as a failure: a token that cannot edit the PR/MR
  // body must not mark every review partial.
  const summary = descriptionSummary(config, result);
  if (await halted()) return publication;
  await publisher.updateDescription(ref, (description) => withDescriptionSummary(description, summary)).catch((err: unknown) => {
    if (summary) publication.errors.push(`Description summary failed: ${message(err)}`);
  });

  if (result.walkthrough) {
    const { add, remove } = labelChanges(result.walkthrough, config.output);
    if (add.length || remove.length) {
      if (await halted()) return publication;
      try {
        await publisher.setLabels(ref, add, remove);
        publication.labels = add;
      } catch (err) {
        publication.errors.push(`Labels failed: ${message(err)}`);
      }
    }
  }

  if (config.output.postCheck) {
    if (await halted()) return publication;
    const status = commitStatus(result, input.targetUrl);
    try {
      await publisher.setCommitStatus(ref, status);
      publication.statusState = status.state;
    } catch (err) {
      publication.errors.push(`Commit status failed: ${message(err)}`);
    }
  }

  return publication;
}

export interface SummaryPlacement {
  // The review comment's body, or null when it is turned off.
  summary: string | null;
  // Whether the review comment may be started, or only an existing one
  // updated: false for a clean review under output.summaryOnlyWithFindings.
  summaryCreate: boolean;
  // The walkthrough as rendered on its own; empty when the review has none.
  walkthrough: string;
  // A comment of its own for the walkthrough, only while the review comment
  // is off; otherwise the walkthrough opens the review comment.
  walkthroughComment: string | null;
}

// One comment per review. Shared with the preview so the two cannot disagree.
export function summaryPlacement(config: Config, result: ReviewResult): SummaryPlacement {
  const options = walkthroughOptions(config.output);
  const walkthrough = walkthroughMarkdown(result, options);
  const { postSummary, findingCounts, reviewStats, findingLifecycle, agentPromptAll, summaryOnlyWithFindings } = config.output;
  // Only a completed review is clean: a partial or failed one with no
  // findings still has its coverage or failure to report.
  const clean = result.status === "completed" && result.findings.length === 0;
  return {
    summary: postSummary
      ? toMarkdown(result, {
          walkthrough: true,
          counts: findingCounts,
          stats: reviewStats,
          lifecycle: findingLifecycle,
          agentPrompt: agentPromptAll,
          rules: config.rules,
          findingPrompts: config.output.agentPrompts,
          ...options,
        })
      : null,
    summaryCreate: !(summaryOnlyWithFindings && clean),
    walkthrough,
    walkthroughComment: !postSummary && walkthrough ? `${walkthrough}\n${WALKTHROUGH_MARKER}\n` : null,
  };
}

// The result with ReviewResult.heldBack set from the inline limits, given the
// fingerprints of the threads already on the change. Nothing is held back
// from threads that are not posted at all. Shared with the preview.
export function withInlineSelection(config: Config, result: ReviewResult, posted: ReadonlySet<string>): ReviewResult {
  const { heldBack: _stale, ...rest } = result;
  if (!config.output.postInline) return rest;
  const { heldBack } = inlineSelection(result.findings, inlineLimits(config.output), posted);
  return heldBack.length ? { ...rest, heldBack: heldBack.map((f) => f.fingerprint) } : rest;
}

// The block for the description: the summary to write, "" to remove an old
// one (the setting is off or the summary moved into the walkthrough), or null
// to leave whatever is there (this run produced none).
export function descriptionSummary(config: Config, result: ReviewResult): string | null {
  const { walkthrough, highLevelSummary, highLevelSummaryPlacement } = config.output;
  if (!walkthrough || !highLevelSummary || highLevelSummaryPlacement !== "description") return "";
  return descriptionSummaryBlock(result) || null;
}

// Threads hang off inline comments, so resolving them needs both switches.
export function resolvesThreads(config: Config): boolean {
  return config.output.postInline && config.output.resolveFixedThreads;
}

export function publishes(config: Config): boolean {
  const { output } = config;
  return (
    output.postInline ||
    output.postSummary ||
    output.postCheck ||
    output.walkthrough ||
    output.blastRadiusLabel ||
    output.effortLabel
  );
}
