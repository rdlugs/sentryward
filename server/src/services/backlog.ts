import { lockChange } from "../lib/changeLock.ts";
import { prisma } from "../lib/prisma.ts";
import type { BacklogItem, ChangeStateValue } from "../generated/prisma/client.ts";
import { reviewResultSchema, type ReviewResult } from "../review/core/models.ts";
import { parsePatch } from "../review/diff/parse.ts";

// The backlog holds findings that shipped: still open, or ignored as "fix
// later", when their change merged. Only merging moves anything: a change
// closed unmerged never put its code in the repository, and a fix on a change
// still under review is not in the repository yet. So both promoting a
// change's findings and resolving earlier items happen at merge time, from the
// merged change's latest stored review.
//
// A merge is recorded first and applied later. Recording (recordChangeState)
// is one upsert, cheap enough for a webhook to wait on. Applying (applyMerge)
// is done by the worker (applyPendingMerges) once no review of the change is
// queued or running, so a review still running when the change merged has
// synced its findings before they are promoted, and the forge never waits on
// a large merge.

// Items on the branch the change merged into; the caller filters by branch.
export type BacklogCandidate = Pick<BacklogItem, "fingerprint" | "file" | "startLine" | "endLine">;

export interface BacklogTransitions {
  // Its lines were rewritten by a reviewed change that did not report it again.
  fixed: string[];
  // Its file was deleted or renamed: it no longer applies, but was not fixed.
  invalidated: string[];
  // Reported again: still there.
  seenAgain: string[];
}

// Whether a patch removes or rewrites any old-file line in start..end, or
// inserts code between two of them. Context lines are unchanged code, so a
// hunk merely passing by does not count; neither does an insertion just above
// or below the range.
export function patchTouches(patch: string, start: number, end: number): boolean {
  for (const hunk of parsePatch(patch)) {
    let old = hunk.oldStart;
    // The first line of a hunk's content is its @@ header.
    for (const line of hunk.content.split("\n").slice(1)) {
      const marker = line[0];
      if (marker === "\\") continue;
      if (marker === "-") {
        if (old >= start && old <= end) return true;
        old++;
      } else if (marker === "+") {
        // Lands between old lines old-1 and old.
        if (old > start && old <= end) return true;
      } else {
        old++;
      }
    }
  }
  return false;
}

export interface TransitionContext {
  // Fingerprints the merged change's own findings were ignored under (any
  // reason). A per-change dismissal drops a finding before the review reports
  // it, so its silence about them is not a fix.
  ignored?: ReadonlySet<string>;
}

// What one merged change's review says about the backlog of the branch it
// merged into. The same rule a change's own runs use to resolve a finding
// (the run read the file and did not report it), narrowed to changes that
// rewrote the finding's lines: a later change's review looks at its own diff,
// so silence about code it did not touch says nothing. Line numbers are those
// recorded when the item shipped, so later edits above it can shift them;
// that is accepted, and a person can reopen a wrong resolution.
export function backlogTransitions(
  items: BacklogCandidate[],
  result: ReviewResult,
  { ignored }: TransitionContext = {},
): BacklogTransitions {
  const out: BacklogTransitions = { fixed: [], invalidated: [], seenAgain: [] };
  if (result.status === "failed") return out;
  const reported = new Set(result.findings.map((finding) => finding.fingerprint));
  const reviewed = new Set(result.coverage.reviewedFiles);
  // Findings over maxFindings were cut without saying which, so the review's
  // silence about an item proves nothing: it may have been among them.
  const capped = (result.validation.dropped.over_limit ?? 0) > 0;
  for (const item of items) {
    const end = item.endLine ?? item.startLine;
    if (reported.has(item.fingerprint)) {
      out.seenAgain.push(item.fingerprint);
      continue;
    }
    const gone = result.files.some(
      (file) =>
        (file.changeType === "deleted" && file.path === item.file) ||
        (file.changeType === "renamed" && file.previousPath === item.file && file.path !== item.file),
    );
    if (gone) {
      out.invalidated.push(item.fingerprint);
      continue;
    }
    if (capped || ignored?.has(item.fingerprint) || !reviewed.has(item.file)) continue;
    // A finding reported at the same place under another fingerprint (the
    // item's own may have been dropped as its duplicate) is not a fix. The
    // reported lines are the new file's and the item's the old one's, so this
    // is approximate; it only ever keeps an item open.
    const overlapping = result.findings.some(
      (finding) => finding.file === item.file && finding.startLine <= end && finding.endLine >= item.startLine,
    );
    if (overlapping) continue;
    const file = result.files.find((candidate) => candidate.path === item.file);
    // No patch (binary, too large, or a result stored before diffs were kept)
    // means the touched lines are unknown, so nothing is resolved.
    if (!file?.patch) continue;
    if (patchTouches(file.patch, item.startLine, end)) out.fixed.push(item.fingerprint);
  }
  return out;
}

export interface ChangeStateInput {
  repositoryId: string;
  number: number;
  state: ChangeStateValue;
  // The branch the change targets; looked up from its review when unknown.
  baseBranch?: string | null;
  closedAt?: Date | null;
}

export interface MergeOutcome {
  promoted: number;
  fixed: number;
  invalidated: number;
}


// Records what is known about a change being open, closed or merged. A merge
// is only recorded here; the worker applies it (applyPendingMerges). Returns
// true when the change is newly recorded as merged: a webhook delivered twice,
// or the sweep and a webhook both noticing, record it once.
export async function recordChangeState(input: ChangeStateInput): Promise<boolean> {
  const { repositoryId, number, state } = input;
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await lockChange(tx, "backlog", repositoryId, number);
    const existing = await tx.changeState.findUnique({ where: { repositoryId_number: { repositoryId, number } } });
    if (existing?.state === "merged") {
      // Still merged, and recorded once; but a later observation can say more.
      // A closedAt passed in is the forge's own merge time (the close watch and
      // the GitLab webhook pass none and fall back to the time we noticed), so
      // it replaces whatever was stored. Every forge source reports the same
      // time for one merge, so repeated deliveries stay idempotent. The branch
      // is only filled in: applyMerge writes the one it used.
      await tx.changeState.update({
        where: { id: existing.id },
        data: {
          checkedAt: now,
          ...(input.closedAt ? { closedAt: input.closedAt } : {}),
          ...(existing.baseBranch === null && input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        },
      });
      return false;
    }
    // Open is the default for a change with no row: only one recorded as
    // closed needs saying so (a reopened change).
    if (state === "open" && !existing) return false;
    const closedAt = state === "open" ? null : (input.closedAt ?? existing?.closedAt ?? now);
    const baseBranch = input.baseBranch ?? existing?.baseBranch ?? null;
    await tx.changeState.upsert({
      where: { repositoryId_number: { repositoryId, number } },
      create: { repositoryId, number, state, baseBranch, closedAt, checkedAt: now },
      update: { state, baseBranch, closedAt, checkedAt: now },
    });
    return state === "merged";
  });
}

// For callers that must not fail on it (the worker's close watch, webhooks
// after their main work): a failed record is retried by the sweep.
export function recordChangeStateQuietly(input: ChangeStateInput): Promise<boolean> {
  return recordChangeState(input).catch((err: unknown) => {
    // A constant format string: state and number arrive from webhook payloads.
    console.error("[backlog] could not record %s for change %d", input.state, input.number, err);
    return false;
  });
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// The newest review of a change that stored a result, which speaks for what
// merged. A push after it that was never reviewed is not seen; nothing better
// is known.
async function latestResult(tx: Tx, repositoryId: string, number: number, jobId?: string | null) {
  const job = await tx.reviewJob.findFirst({
    where: {
      repositoryId,
      number,
      status: { in: ["completed", "partial"] },
      resultExpiredAt: null,
      // A trial does not speak for what merged.
      trial: false,
      ...(jobId ? { id: jobId } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, result: true },
  });
  const parsed = job?.result ? reviewResultSchema.safeParse(job.result) : null;
  return job && parsed?.success ? { jobId: job.id, result: parsed.data } : null;
}

async function ignoredOn(tx: Tx, repositoryId: string, number: number): Promise<Set<string>> {
  const rows = await tx.finding.findMany({ where: { repositoryId, number, state: "ignored" }, select: { fingerprint: true } });
  return new Set(rows.map((row) => row.fingerprint));
}

// Resolves the open items among `items` that `result` (merged change `number`)
// shows were fixed or no longer apply, and marks the ones it reported again
// as seen at `seenAt`.
async function resolveFrom(
  tx: Tx,
  repositoryId: string,
  items: BacklogCandidate[],
  merged: { number: number; jobId: string; result: ReviewResult; ignored: Set<string> },
  now: Date,
  seenAt: Date,
): Promise<{ fixed: number; invalidated: number }> {
  if (!items.length) return { fixed: 0, invalidated: 0 };
  const moves = backlogTransitions(items, merged.result, { ignored: merged.ignored });
  const resolve = async (prints: string[], resolution: "fixed" | "invalidated") =>
    prints.length
      ? (
          await tx.backlogItem.updateMany({
            where: { repositoryId, state: "open", fingerprint: { in: prints } },
            data: { state: "resolved", resolution, resolvedNumber: merged.number, resolvedJobId: merged.jobId, resolvedAt: now },
          })
        ).count
      : 0;
  const fixed = await resolve(moves.fixed, "fixed");
  const invalidated = await resolve(moves.invalidated, "invalidated");
  if (moves.seenAgain.length) {
    await tx.backlogItem.updateMany({
      where: { repositoryId, state: "open", fingerprint: { in: moves.seenAgain }, lastSeenAt: { lt: seenAt } },
      data: { lastSeenAt: seenAt },
    });
  }
  return { fixed, invalidated };
}

const CANDIDATE_FIELDS = { fingerprint: true, file: true, startLine: true, endLine: true } as const;

// Applies a recorded merge to the backlog, once: earlier items its review
// shows were fixed are resolved first, then its own unaddressed findings are
// added (in that order, so the change's own findings are never resolved by
// its own review), then merges into the same branch that were applied before
// this one but happened after it are replayed against what was just added.
// Returns null when there is nothing to apply (not merged, or already applied).
export async function applyMerge(repositoryId: string, number: number): Promise<MergeOutcome | null> {
  const now = new Date();
  return prisma.$transaction(
    async (tx) => {
      // Per repository: resolving and promoting read and write the whole
      // branch's backlog, so two merges must not interleave.
      await lockChange(tx, "backlog", repositoryId, 0);
      const state = await tx.changeState.findUnique({ where: { repositoryId_number: { repositoryId, number } } });
      if (state?.state !== "merged" || state.mergeAppliedAt) return null;

      const merged = await latestResult(tx, repositoryId, number);
      const repo = await tx.repository.findUniqueOrThrow({ where: { id: repositoryId }, select: { defaultBranch: true } });
      const branch = state.baseBranch ?? merged?.result.change.baseRef ?? repo.defaultBranch;
      const mergedAt = state.closedAt ?? now;

      let fixed = 0;
      let invalidated = 0;
      if (merged) {
        const open = await tx.backlogItem.findMany({
          where: { repositoryId, state: "open", baseBranch: branch },
          select: CANDIDATE_FIELDS,
        });
        const ignored = await ignoredOn(tx, repositoryId, number);
        ({ fixed, invalidated } = await resolveFrom(tx, repositoryId, open, { number, ...merged, ignored }, now, now));
      }

      const promotedPrints = await promote(tx, repositoryId, number, branch, mergedAt);

      // A merge found late (a missed webhook the sweep caught) is applied
      // after merges that happened later. Those already ran against a backlog
      // without this change's items, so they are replayed against them, in
      // the order they happened. One whose result retention expired cannot be.
      if (promotedPrints.length) {
        const later = await tx.changeState.findMany({
          where: { repositoryId, state: "merged", baseBranch: branch, mergeAppliedAt: { not: null }, closedAt: { gt: mergedAt } },
          orderBy: { closedAt: "asc" },
          select: { number: true, appliedJobId: true, closedAt: true },
        });
        for (const change of later) {
          if (!change.appliedJobId) continue;
          const replayed = await latestResult(tx, repositoryId, change.number, change.appliedJobId);
          if (!replayed) continue;
          const items = await tx.backlogItem.findMany({
            where: { repositoryId, state: "open", fingerprint: { in: promotedPrints } },
            select: CANDIDATE_FIELDS,
          });
          if (!items.length) break;
          const ignored = await ignoredOn(tx, repositoryId, change.number);
          const moved = await resolveFrom(
            tx,
            repositoryId,
            items,
            { number: change.number, ...replayed, ignored },
            now,
            change.closedAt ?? now,
          );
          fixed += moved.fixed;
          invalidated += moved.invalidated;
        }
      }

      await tx.changeState.update({
        where: { id: state.id },
        data: { baseBranch: branch, mergeAppliedAt: now, appliedJobId: merged?.jobId ?? null },
      });
      return { promoted: promotedPrints.length, fixed, invalidated };
    },
    // Runs in the worker, not a request; a merge with hundreds of findings and
    // a replay can outlast Prisma's 5s default.
    { timeout: 30_000 },
  );
}

// Adds a merged change's unaddressed findings to the backlog and returns the
// fingerprints added or reopened. Ignored for any other reason than "fix
// later" (a false positive, intentional) is a decision already made about the
// finding, not work left to do. Requirement gaps stay with the change: what a
// linked issue still asks for is the issue's to track, and a backlog item
// resolves only when a later review reads its file, which a gap does not have.
async function promote(tx: Tx, repositoryId: string, number: number, branch: string, mergedAt: Date): Promise<string[]> {
  const findings = await tx.finding.findMany({
    where: {
      repositoryId,
      number,
      kind: { not: "requirement_gap" },
      OR: [{ state: "open" }, { state: "ignored", ignoreReason: "fix_later" }],
    },
  });
  if (!findings.length) return [];
  const existing = await tx.backlogItem.findMany({
    where: { repositoryId, fingerprint: { in: findings.map((finding) => finding.fingerprint) } },
    select: { id: true, fingerprint: true, state: true },
  });
  const byPrint = new Map(existing.map((item) => [item.fingerprint, item]));
  const snapshot = (finding: (typeof findings)[number]) => ({
    baseBranch: branch,
    sourceNumber: number,
    sourceChangeTitle: finding.changeTitle,
    author: finding.author,
    title: finding.title,
    file: finding.file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    severity: finding.severity,
    category: finding.category,
    kind: finding.kind,
    ruleId: finding.ruleId,
    model: finding.model,
    origin: finding.state === "ignored" ? ("fix_later" as const) : ("open" as const),
    ignoreNote: finding.state === "ignored" ? finding.ignoreNote : null,
    mergedAt,
    lastSeenAt: finding.lastSeenAt,
  });

  const promoted: string[] = [];
  const fresh = findings.filter((finding) => !byPrint.has(finding.fingerprint));
  if (fresh.length) {
    // Nothing else creates items while the backlog lock is held, so every
    // fresh one is created; skipDuplicates only guards the unique key.
    await tx.backlogItem.createMany({
      data: fresh.map((finding) => ({
        repositoryId,
        fingerprint: finding.fingerprint,
        firstSeenAt: finding.firstSeenAt,
        ...snapshot(finding),
      })),
      skipDuplicates: true,
    });
    promoted.push(...fresh.map((finding) => finding.fingerprint));
  }
  for (const finding of findings) {
    const item = byPrint.get(finding.fingerprint);
    // Dismissing is a person's call (a retention tombstone is one too);
    // shipping the problem again does not undo it.
    if (!item || item.state === "dismissed") continue;
    // Open: the same problem shipped again, refreshed. Resolved: it is back.
    // The dismiss route does not hold the backlog lock, so a dismissal can
    // land after the read above: the write checks again.
    const { count } = await tx.backlogItem.updateMany({
      where: { id: item.id, state: { not: "dismissed" } },
      data: {
        ...snapshot(finding),
        state: "open",
        resolution: null,
        resolvedNumber: null,
        resolvedJobId: null,
        resolvedAt: null,
      },
    });
    if (count) promoted.push(finding.fingerprint);
  }
  return promoted;
}

export interface ApplyResult {
  applied: number;
  promoted: number;
  resolved: number;
  failed: number;
}

// Applies recorded merges, oldest first, skipping a change while a review of
// it is queued or running: that review syncs the change's findings when it
// finishes, and the merge must promote those, not the ones before it. A trial
// syncs no findings, so there is nothing to wait for.
export async function applyPendingMerges({ batchSize = 25 }: { batchSize?: number } = {}): Promise<ApplyResult> {
  const pending = await prisma.$queryRaw<{ repository_id: string; number: number }[]>`
    SELECT s.repository_id, s.number
    FROM change_states s
    WHERE s.state = 'merged' AND s.merge_applied_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM review_jobs j
        WHERE j.repository_id = s.repository_id AND j.number = s.number AND j.status IN ('queued', 'running')
          AND j.trial = false
      )
    ORDER BY s.closed_at NULLS LAST, s.checked_at
    LIMIT ${batchSize}
  `;
  const out: ApplyResult = { applied: 0, promoted: 0, resolved: 0, failed: 0 };
  for (const { repository_id: repositoryId, number } of pending) {
    try {
      const outcome = await applyMerge(repositoryId, number);
      if (!outcome) continue;
      out.applied++;
      out.promoted += outcome.promoted;
      out.resolved += outcome.fixed + outcome.invalidated;
    } catch (err) {
      out.failed++;
      console.error("[backlog] could not apply the merge of change %d in %s", number, repositoryId, err);
    }
  }
  return out;
}
