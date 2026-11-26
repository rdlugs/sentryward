import { prisma } from "../lib/prisma.ts";
import { normaliseTitle } from "../review/core/fingerprint.ts";
import { gapIssueRef } from "../review/core/requirementGaps.ts";
import type { InvalidatedReason, Lifecycle, ReviewResult } from "../review/core/models.ts";
import type { Severity } from "../review/core/severity.ts";

export interface SyncFindingsInput {
  repositoryId: string;
  number: number;
  jobId: string;
  author?: string;
  result: ReviewResult;
  // The thread updates the publisher attempted and which of them failed, or
  // null when thread resolution did not run (turned off, nothing published).
  threads?: ThreadOutcome | null;
}

export interface ThreadOutcome {
  attempted: string[];
  failed: string[];
}

export interface FindingRow {
  fingerprint: string;
  state: string;
  file: string;
  threadPending?: boolean;
}

export interface FindingTransitions {
  // Open findings this run no longer reports.
  resolved: string[];
  // Resolved findings this run reports again.
  reopened: string[];
}

// An earlier finding as its row last recorded it, enough to tell what became
// of it and to list it once it is gone.
export interface KnownFinding extends FindingRow {
  title: string;
  startLine: number;
  endLine?: number | null;
  severity: Severity;
  category: string;
  kind: string;
  // Absent on rows read without them (tests); null as stored.
  ruleId?: string | null;
  model?: string | null;
}

// The same problem, wherever it is: the fingerprint without the file. Rule
// findings stay apart from each other and from model findings by rule.
function problem(finding: { category: string; kind: string; title: string; ruleId?: string | null }): string {
  return [finding.category, finding.kind, finding.ruleId ?? "", normaliseTitle(finding.title)].join("|");
}

// Earlier open findings that moved to another file, mapped to where they are
// now (the fingerprint includes the file, so a move otherwise reads as a fix
// plus a new finding). Only the file is known to have changed, not the code,
// so a match must be hard to make by accident: the finding now sits in a file
// the change adds or renames (code extracted into a new module, or the file
// itself moved), and the problem is the only one of its kind on both sides. A
// generic title that happens to appear in an existing file stays a fix plus a
// new finding. The old file may have been skipped for budget; the match alone
// says the finding left it.
function movedFindings(existing: KnownFinding[], result: ReviewResult): Map<string, string> {
  const known = new Set(existing.map((row) => row.fingerprint));
  const added = new Set(
    result.files.filter((file) => file.changeType === "added" || file.changeType === "renamed").map((file) => file.path),
  );
  const reported = new Set(result.findings.map((finding) => finding.fingerprint));
  const group = <T>(items: T[], key: (item: T) => string) => {
    const groups = new Map<string, T[]>();
    for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
    return groups;
  };
  // Every match of a pattern rule has the rule's title, so the problem key
  // cannot tell one from another: they are never paired as a move. The row's
  // ruleId without a model is a pattern match; the finding says so by source.
  const before = group(
    existing.filter((row) => row.state === "open" && !reported.has(row.fingerprint) && !(row.ruleId && !row.model)),
    problem,
  );
  // A run can report the same fingerprint twice (overlapping chunks).
  const fresh = [...new Map(result.findings.map((finding) => [finding.fingerprint, finding])).values()];
  const after = group(
    fresh.filter(
      (finding) =>
        !known.has(finding.fingerprint) && added.has(finding.file) && !(finding.source === "rule" && !finding.model),
    ),
    (finding) => problem({ ...finding, ruleId: finding.source === "rule" ? finding.ruleId : null }),
  );
  const moved = new Map<string, string>();
  for (const [key, rows] of before) {
    const matches = after.get(key);
    if (rows.length === 1 && matches?.length === 1) moved.set(rows[0]!.fingerprint, matches[0]!.fingerprint);
  }
  return moved;
}

// Whether a run that no longer reports an open requirement gap settles it. A
// gap comes from the walkthrough's linked-issue check, not from reading its
// file, so only that check can: its issue was split into requirements again
// without it, or the change no longer links the issue. A failed walkthrough,
// an unreadable tracker or the setting turned off made no check
// (requirementChecks absent), and an issue the model left out or gave no
// requirements for was not checked either. A run that hit max_findings may
// have cut the gap rather than not found it.
function gapSettledBy(result: ReviewResult): (row: KnownFinding) => boolean {
  const checks = result.walkthrough?.requirementChecks;
  if (!checks || (result.validation.dropped.over_limit ?? 0) > 0) return () => false;
  const linked = new Set(checks.linked);
  const assessed = new Set(checks.assessed);
  return (row) => {
    const ref = gapIssueRef(row.title);
    if (ref === undefined) return false;
    return !linked.has(ref) || assessed.has(ref);
  };
}

// Which findings one run moves between open and resolved. A finding is resolved
// only when this run actually read its file (or the file left the change, or
// the change deletes it, or the finding moved to another file); a partial run
// that skipped the file for budget says nothing about it. Ignoring is the
// user's call, so no run undoes it. The publisher resolves forge threads from
// the same answer before the rows are written, so the two cannot disagree.
export function findingTransitions(existing: KnownFinding[], result: ReviewResult): FindingTransitions {
  if (result.status === "failed") return { resolved: [], reopened: [] };
  const reviewed = new Set(result.coverage.reviewedFiles);
  const changed = new Set(result.files.map((file) => file.path));
  const deleted = new Set(result.files.filter((file) => file.changeType === "deleted").map((file) => file.path));
  const reported = new Set(result.findings.map((finding) => finding.fingerprint));
  const moved = movedFindings(existing, result);
  const gapSettled = gapSettledBy(result);
  return {
    resolved: existing
      .filter((row) => row.state === "open" && !reported.has(row.fingerprint))
      .filter((row) =>
        row.kind === "requirement_gap"
          ? gapSettled(row)
          : reviewed.has(row.file) || !changed.has(row.file) || deleted.has(row.file) || moved.has(row.fingerprint),
      )
      .map((row) => row.fingerprint),
    reopened: existing.filter((row) => row.state === "resolved" && reported.has(row.fingerprint)).map((row) => row.fingerprint),
  };
}

// Sorts one run's findings against the ones earlier runs left on the change:
// new, still open, reopened (resolved before, reported again), or gone, and a
// gone one into fixed or invalidated. Only the file is known to have changed,
// not the lines, so a finding counts as invalidated when its file was renamed,
// deleted or dropped from the change, or when it moved to another file
// (movedFindings). That moved finding is still open, not new. Undefined for a
// change's first review and for a failed run, which says nothing about earlier
// findings.
export function findingLifecycle(existing: KnownFinding[], result: ReviewResult): Lifecycle | undefined {
  if (result.status === "failed" || !existing.length) return undefined;
  const state = new Map(existing.map((row) => [row.fingerprint, row.state]));
  const renamed = new Set(result.files.flatMap((file) => (file.previousPath && file.previousPath !== file.path ? [file.previousPath] : [])));
  const deleted = new Set(result.files.filter((file) => file.changeType === "deleted").map((file) => file.path));
  const changed = new Set(result.files.map((file) => file.path));
  // A run can report the same fingerprint twice (overlapping chunks).
  const reported = [...new Set(result.findings.map((finding) => finding.fingerprint))];
  const moved = movedFindings(existing, result);
  const movedHere = new Set(moved.values());

  const resolving = new Set(findingTransitions(existing, result).resolved);
  const gone = existing
    .filter((row) => resolving.has(row.fingerprint))
    .map((row): Lifecycle["gone"][number] => {
      let reason: InvalidatedReason | undefined;
      if (renamed.has(row.file)) reason = "renamed";
      else if (deleted.has(row.file)) reason = "deleted";
      else if (!changed.has(row.file)) reason = "left_change";
      else if (moved.has(row.fingerprint)) reason = "moved";
      return {
        fingerprint: row.fingerprint,
        title: row.title,
        file: row.file,
        startLine: row.startLine,
        ...(row.endLine != null ? { endLine: row.endLine } : {}),
        severity: row.severity,
        outcome: reason ? "invalidated" : "fixed",
        ...(reason ? { reason } : {}),
      };
    });

  return {
    new: reported.filter((print) => !state.has(print) && !movedHere.has(print)),
    stillOpen: reported.filter((print) => (state.has(print) && state.get(print) !== "resolved") || movedHere.has(print)),
    reopened: reported.filter((print) => state.get(print) === "resolved"),
    gone,
  };
}

export interface ThreadOperations {
  resolve: string[];
  reopen: string[];
}

// The forge threads to move this run: every transition, plus earlier ones whose
// thread update failed, retried toward the state the finding will have after
// this run. An ignored finding's thread is left as it is.
export function threadOperations(existing: FindingRow[], transitions: FindingTransitions): ThreadOperations {
  const resolve = new Set(transitions.resolved);
  const reopen = new Set(transitions.reopened);
  for (const row of existing) {
    if (!row.threadPending || resolve.has(row.fingerprint) || reopen.has(row.fingerprint)) continue;
    if (row.state === "resolved") resolve.add(row.fingerprint);
    else if (row.state === "open") reopen.add(row.fingerprint);
  }
  return { resolve: [...resolve], reopen: [...reopen] };
}

// Brings the change's findings table in step with one run's result.
export async function syncFindings({ repositoryId, number, jobId, author, result, threads }: SyncFindingsInput): Promise<void> {
  // Retries happen even on a failed run, so their outcome is kept either way.
  if (result.status === "failed") {
    if (threads) await prisma.$transaction((tx) => recordThreads(tx, repositoryId, number, threads));
    return;
  }
  const now = new Date();
  // A run can report the same fingerprint twice (overlapping chunks); one row each.
  const reported = new Map(result.findings.map((finding) => [finding.fingerprint, finding]));

  await prisma.$transaction(async (tx) => {
    const existing = await tx.finding.findMany({
      where: { repositoryId, number },
      select: { id: true, confidence: true, ...KNOWN_FINDING },
    });
    const known = new Map(existing.map((row) => [row.fingerprint, row]));
    // The worker worked the lifecycle out before publishing and the summary
    // comment shows it; taking it as is keeps the rows in step with that
    // comment. Callers that did not store one get it from this read.
    const lifecycle = result.lifecycle ?? findingLifecycle(existing, result);
    const stillOpen = new Set(lifecycle?.stillOpen);
    // Findings this run says nothing about (a file skipped for budget, or an
    // ignored one no longer reported) were reported earlier and are not known
    // to be gone; the rows below then set what this run did report or resolve.
    await tx.finding.updateMany({
      where: { repositoryId, number, state: { not: "resolved" }, lifecycle: { in: ["new", "reopened"] } },
      data: { lifecycle: "still_open" },
    });

    for (const finding of reported.values()) {
      const snapshot = {
        title: finding.title,
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        severity: finding.severity,
        category: finding.category,
        kind: finding.kind,
        changeTitle: result.change.title,
        lastSeenAt: now,
        // Backfilled rows have no author; keep a known one if the forge stops saying.
        ...(author ? { author } : {}),
      };
      // Only team rules are counted per rule; an analyzer's rule id is the
      // analyzer's business.
      const source = {
        model: finding.model ?? null,
        ruleId: finding.source === "rule" ? (finding.ruleId ?? null) : null,
        lastJobId: jobId,
      };
      const row = known.get(finding.fingerprint);
      // Calibration buckets a finding by the confidence it was first reported
      // with, matching its first_seen_at window, so a later run only fills a
      // gap. Confidence is only a model's to report, including for a rule
      // violation it found; tool and pattern rule findings carry a fixed one.
      const reportedConfidence = finding.source === "llm" || (finding.source === "rule" && finding.model) ? finding.confidence : null;
      const confidence = row?.confidence ?? reportedConfidence;
      if (!row) {
        // A finding that moved here from another file is the same problem, still open.
        await tx.finding.create({
          data: {
            repositoryId,
            number,
            fingerprint: finding.fingerprint,
            ...snapshot,
            ...source,
            confidence,
            lifecycle: stillOpen.has(finding.fingerprint) ? "still_open" : "new",
          },
        });
      } else if (row.state === "resolved") {
        await tx.finding.update({
          where: { id: row.id },
          data: { ...snapshot, ...source, confidence, state: "open", resolvedAt: null, lifecycle: "reopened" },
        });
      } else if (row.state === "ignored") {
        // The dismissal belongs to the run (and model) the user dismissed: a
        // later model repeating the finding must not take the blame for it,
        // and the details sheet keeps showing what was dismissed.
        await tx.finding.update({ where: { id: row.id }, data: { ...snapshot, lifecycle: "still_open" } });
      } else {
        await tx.finding.update({ where: { id: row.id }, data: { ...snapshot, ...source, confidence, lifecycle: "still_open" } });
      }
    }

    // The lifecycle's gone list is exactly findingTransitions' resolved list.
    // Only open rows move: one the user ignored while the job was publishing
    // stays ignored, though the summary comment already lists it as gone.
    for (const outcome of ["fixed", "invalidated"] as const) {
      const prints = (lifecycle?.gone ?? []).filter((gone) => gone.outcome === outcome).map((gone) => gone.fingerprint);
      if (!prints.length) continue;
      await tx.finding.updateMany({
        where: { repositoryId, number, state: "open", fingerprint: { in: prints } },
        data: { state: "resolved", resolvedAt: now, lifecycle: outcome },
      });
    }
    if (threads) await recordThreads(tx, repositoryId, number, threads);
  });
}

// The columns findingLifecycle reads, for the worker's query and this one.
export const KNOWN_FINDING = {
  fingerprint: true,
  state: true,
  file: true,
  threadPending: true,
  title: true,
  startLine: true,
  endLine: true,
  severity: true,
  category: true,
  kind: true,
  ruleId: true,
  model: true,
} as const;

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// A thread that was found and moved, or was already where it should be (or
// does not exist), is settled; a failed one stays pending for the next run.
async function recordThreads(tx: Tx, repositoryId: string, number: number, threads: ThreadOutcome): Promise<void> {
  const failed = new Set(threads.failed);
  const settled = threads.attempted.filter((print) => !failed.has(print));
  if (failed.size) {
    await tx.finding.updateMany({
      where: { repositoryId, number, fingerprint: { in: [...failed] } },
      data: { threadPending: true },
    });
  }
  if (settled.length) {
    await tx.finding.updateMany({
      where: { repositoryId, number, fingerprint: { in: settled } },
      data: { threadPending: false },
    });
  }
}
