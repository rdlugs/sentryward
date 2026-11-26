import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";
import type { Prisma } from "../src/generated/prisma/client.ts";
import type { ReviewResult } from "../src/review/core/models.ts";
import type { ChangeDetails } from "../src/review/forge/types.ts";
import {
  applyMerge,
  applyPendingMerges,
  backlogTransitions,
  patchTouches,
  recordChangeState,
  type BacklogCandidate,
} from "../src/services/backlog.ts";
import { sweepClosedChanges } from "../src/worker/backlogSweep.ts";
import { pruneBacklog, purgeStaleChanges } from "../src/worker/retention.ts";
import { sampleResult } from "./helpers/result.ts";
import { createUser } from "./helpers/users.ts";

let cookie: string;
let workspaceId: string;
let repoId: string;
let base: ReviewResult;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

async function createRepo(owner: string, fullPath = "team/web") {
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: owner, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "dev" },
  });
  const repo = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "gitlab",
      host: "gitlab.com",
      fullPath,
      externalId: fullPath,
      defaultBranch: "main",
      enabled: true,
    },
  });
  return repo.id;
}

// Old lines 20-22 of src/app.ts: 21 is rewritten.
const REWRITE_21 = ["@@ -20,3 +20,3 @@", " keep();", "-broken();", "+fixed();", " keep();"].join("\n");

// One stored result, with only what the backlog reads set.
function result(overrides: Partial<ReviewResult> = {}, files: ReviewResult["files"] = []): ReviewResult {
  return {
    ...base,
    status: "completed",
    findings: [],
    files,
    coverage: { ...base.coverage, reviewedFiles: files.map((file) => file.path) },
    change: { ...base.change, baseRef: "main" },
    ...overrides,
  };
}

const modified = (path: string, patch?: string): ReviewResult["files"][number] => ({
  path,
  changeType: "modified",
  additions: 1,
  deletions: 1,
  ...(patch ? { patch } : { patchOmitted: "too_large" as const }),
});

const candidate = (overrides: Partial<BacklogCandidate> = {}): BacklogCandidate => ({
  fingerprint: "fp1",
  file: "src/app.ts",
  startLine: 21,
  endLine: 21,
  ...overrides,
});

async function finding(number: number, fingerprint: string, data: Partial<Prisma.FindingUncheckedCreateInput> = {}) {
  return prisma.finding.create({
    data: {
      repositoryId: repoId,
      number,
      fingerprint,
      title: `Finding ${fingerprint}`,
      file: "src/app.ts",
      startLine: 21,
      endLine: 21,
      severity: "major",
      category: "bug",
      kind: "issue",
      changeTitle: `Change ${number}`,
      author: "alice",
      ...data,
    },
  });
}

async function job(number: number, stored: ReviewResult, createdAt = new Date()) {
  return prisma.reviewJob.create({
    data: { repositoryId: repoId, number, headSha: "head", trigger: "manual", status: "completed", result: stored, createdAt },
  });
}

// Records a merge and applies it, as the webhook and then the worker would.
const record = (number: number, closedAt?: Date) =>
  recordChangeState({ repositoryId: repoId, number, state: "merged", baseBranch: "main", closedAt });
async function merge(number: number, closedAt?: Date) {
  await record(number, closedAt);
  return applyMerge(repoId, number);
}
const items = () => prisma.backlogItem.findMany({ orderBy: { fingerprint: "asc" } });

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const created = await createUser();
  cookie = created.cookie;
  workspaceId = created.workspace.id;
  repoId = await createRepo(workspaceId);
  base ??= await sampleResult();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("patchTouches", () => {
  it("counts removed and rewritten lines, not context passing by", () => {
    expect(patchTouches(REWRITE_21, 21, 21)).toBe(true);
    expect(patchTouches(REWRITE_21, 20, 20)).toBe(false);
    expect(patchTouches(REWRITE_21, 22, 30)).toBe(false);
  });

  it("counts an insertion inside the range but not at its edges", () => {
    const insert = ["@@ -10,2 +10,3 @@", " a();", "+b();", " c();"].join("\n");
    // Lands between old lines 10 and 11.
    expect(patchTouches(insert, 10, 11)).toBe(true);
    expect(patchTouches(insert, 10, 10)).toBe(false);
    expect(patchTouches(insert, 11, 11)).toBe(false);
  });
});

describe("backlogTransitions", () => {
  it("fixes an item whose lines a reviewed change rewrote without reporting it", () => {
    expect(backlogTransitions([candidate()], result({}, [modified("src/app.ts", REWRITE_21)]))).toEqual({
      fixed: ["fp1"],
      invalidated: [],
      seenAgain: [],
    });
  });

  it("leaves an item reported again open, and says so", () => {
    const stored = result({ findings: [{ ...base.findings[0]!, fingerprint: "fp1" }] }, [modified("src/app.ts", REWRITE_21)]);
    expect(backlogTransitions([candidate()], stored)).toEqual({ fixed: [], invalidated: [], seenAgain: ["fp1"] });
  });

  it("invalidates an item whose file was deleted or renamed away", () => {
    const deleted = result({}, [{ path: "src/app.ts", changeType: "deleted", additions: 0, deletions: 30 }]);
    const renamed = result({}, [{ path: "src/main.ts", previousPath: "src/app.ts", changeType: "renamed", additions: 0, deletions: 0 }]);
    expect(backlogTransitions([candidate()], deleted).invalidated).toEqual(["fp1"]);
    expect(backlogTransitions([candidate()], renamed).invalidated).toEqual(["fp1"]);
  });

  it("resolves nothing it cannot see: other lines, unread files, no patch, a failed run", () => {
    const none = { fixed: [], invalidated: [], seenAgain: [] };
    const touched = result({}, [modified("src/app.ts", REWRITE_21)]);
    expect(backlogTransitions([candidate({ startLine: 5, endLine: 8 })], touched)).toEqual(none);
    expect(backlogTransitions([candidate()], { ...touched, coverage: { ...touched.coverage, reviewedFiles: [] } })).toEqual(none);
    expect(backlogTransitions([candidate()], result({}, [modified("src/app.ts")]))).toEqual(none);
    expect(backlogTransitions([candidate()], { ...touched, status: "failed" })).toEqual(none);
  });

  it("fixes nothing when findings were cut, but still invalidates", () => {
    const capped = { ...base.validation, dropped: { over_limit: 3 } };
    const touched = result({ validation: capped }, [modified("src/app.ts", REWRITE_21)]);
    expect(backlogTransitions([candidate()], touched)).toEqual({ fixed: [], invalidated: [], seenAgain: [] });
    const deleted = result({ validation: capped }, [{ path: "src/app.ts", changeType: "deleted", additions: 0, deletions: 30 }]);
    expect(backlogTransitions([candidate()], deleted).invalidated).toEqual(["fp1"]);
  });

  it("does not fix an item reported at the same place under another fingerprint, or ignored on the change", () => {
    const twin = { ...base.findings[0]!, fingerprint: "fp-twin", file: "src/app.ts", startLine: 20, endLine: 22 };
    const none = { fixed: [], invalidated: [], seenAgain: [] };
    expect(backlogTransitions([candidate()], result({ findings: [twin] }, [modified("src/app.ts", REWRITE_21)]))).toEqual(none);
    const touched = result({}, [modified("src/app.ts", REWRITE_21)]);
    expect(backlogTransitions([candidate()], touched, { ignored: new Set(["fp1"]) })).toEqual(none);
  });
});

describe("recording and applying a merge", () => {
  it("promotes open and fix-later findings when a change merges, and nothing else", async () => {
    await finding(7, "fp-open");
    await finding(7, "fp-later", { state: "ignored", ignoreReason: "fix_later", ignoreNote: "after launch" });
    await finding(7, "fp-false", { state: "ignored", ignoreReason: "false_positive" });
    await finding(7, "fp-fixed", { state: "resolved", lifecycle: "fixed" });
    // What a linked issue still asks for stays with the change: no later
    // review could ever resolve it in the backlog.
    await finding(7, "fp-gap", { kind: "requirement_gap", file: "", startLine: 1, endLine: 1 });

    expect(await merge(7)).toEqual({ promoted: 2, fixed: 0, invalidated: 0 });
    const stored = await items();
    expect(stored.map((item) => [item.fingerprint, item.origin, item.ignoreNote, item.state])).toEqual([
      ["fp-later", "fix_later", "after launch", "open"],
      ["fp-open", "open", null, "open"],
    ]);
    expect(stored[0]).toMatchObject({ sourceNumber: 7, sourceChangeTitle: "Change 7", baseBranch: "main", author: "alice" });
    expect(await prisma.changeState.findFirst({ select: { state: true } })).toEqual({ state: "merged" });
  });

  it("is a no-op on a second merge record and on a close without a merge", async () => {
    await finding(7, "fp-open");
    await finding(8, "fp-closed");
    await merge(7);
    expect(await merge(7)).toBeNull();
    expect(await recordChangeState({ repositoryId: repoId, number: 8, state: "closed" })).toBe(false);
    expect(await applyMerge(repoId, 8)).toBeNull();
    expect((await items()).map((item) => item.fingerprint)).toEqual(["fp-open"]);
  });

  it("takes the forge's merge time and branch from a later record of the same merge", async () => {
    await finding(7, "fp-open");
    const mergedAt = new Date("2026-11-01T10:00:00Z");
    const state = () => prisma.changeState.findFirstOrThrow({ select: { closedAt: true, baseBranch: true } });
    // The close watch notices first: no merge time, and here no branch either.
    expect(await recordChangeState({ repositoryId: repoId, number: 7, state: "merged", baseBranch: null })).toBe(true);
    expect((await state()).closedAt).not.toEqual(mergedAt);

    // The webhook follows with the forge's time; the merge is still recorded once.
    expect(await record(7, mergedAt)).toBe(false);
    expect(await state()).toEqual({ closedAt: mergedAt, baseBranch: "main" });

    // A record without a time, or naming another branch, leaves both alone.
    expect(await recordChangeState({ repositoryId: repoId, number: 7, state: "merged", baseBranch: "other" })).toBe(false);
    expect(await state()).toEqual({ closedAt: mergedAt, baseBranch: "main" });

    await applyMerge(repoId, 7);
    expect((await items()).map((item) => item.mergedAt)).toEqual([mergedAt]);
  });

  it("resolves earlier items from the merged change's review, but never its own", async () => {
    await finding(7, "fp-old");
    await merge(7);
    // Change 8 rewrites line 21 and raises its own finding on the same line.
    await finding(8, "fp-new");
    const reviewed = await job(8, result({}, [modified("src/app.ts", REWRITE_21)]));

    expect(await merge(8)).toEqual({ promoted: 1, fixed: 1, invalidated: 0 });
    const [fresh, old] = await items();
    expect(old).toMatchObject({ fingerprint: "fp-old", state: "resolved", resolution: "fixed", resolvedNumber: 8, resolvedJobId: reviewed.id });
    expect(fresh).toMatchObject({ fingerprint: "fp-new", state: "open" });
  });

  it("takes the merged change's last real review, never a trial run after it", async () => {
    await finding(7, "fp-old");
    await merge(7);
    await finding(8, "fp-new");
    const reviewed = await job(8, result({}, [modified("src/app.ts", REWRITE_21)]));
    // A newer trial that read no files: taken for the merge, it would fix nothing.
    const trial = await job(8, result(), new Date(Date.now() + 60_000));
    await prisma.reviewJob.update({ where: { id: trial.id }, data: { trial: true } });

    expect(await merge(8)).toEqual({ promoted: 1, fixed: 1, invalidated: 0 });
    const [fresh, old] = await items();
    expect(old).toMatchObject({ fingerprint: "fp-old", state: "resolved", resolvedJobId: reviewed.id });
    const res = await request(app).get(`/api/backlog/${fresh!.id}`).set("Cookie", cookie);
    expect(res.body.sourceReviewId).toBe(reviewed.id);
  });

  it("reopens a resolved item that ships again, and leaves a dismissed one dismissed", async () => {
    await finding(7, "fp-back");
    await finding(7, "fp-dismissed");
    await merge(7);
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-back" }, data: { state: "resolved", resolution: "fixed" } });
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-dismissed" }, data: { state: "dismissed", dismissedAt: new Date() } });

    await finding(9, "fp-back");
    await finding(9, "fp-dismissed");
    expect((await merge(9))!.promoted).toBe(1);
    const [back, dismissed] = await items();
    expect(back).toMatchObject({ state: "open", resolution: null, sourceNumber: 9 });
    expect(dismissed).toMatchObject({ state: "dismissed", sourceNumber: 7 });
  });

  it("does not undo a dismissal that lands while the merge is processed", async () => {
    await finding(7, "fp-race");
    await merge(7);
    await finding(9, "fp-race");

    // The dismiss route takes no backlog lock: dismiss right after the merge reads the item.
    const real = prisma.$transaction.bind(prisma) as (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: unknown) =>
      real(async (tx) => {
        const read = tx.backlogItem.findMany.bind(tx.backlogItem);
        (tx.backlogItem as { findMany: unknown }).findMany = async (args: { where?: { fingerprint?: unknown } }) => {
          const item = await read(args as never);
          // Only promotion's read of existing items looks them up by fingerprint.
          if (!args.where?.fingerprint) return item;
          await prisma.backlogItem.updateMany({
            where: { fingerprint: "fp-race" },
            data: { state: "dismissed", dismissedAt: new Date(), dismissNote: "won't fix" },
          });
          return item;
        };
        return fn(tx);
      }, opts)) as never);
    await record(9);
    let outcome;
    try {
      outcome = await applyMerge(repoId, 9);
    } finally {
      spy.mockRestore();
    }

    expect(outcome!.promoted).toBe(0);
    const [item] = await items();
    expect(item).toMatchObject({ state: "dismissed", dismissNote: "won't fix", sourceNumber: 7 });
  });
});

describe("applyPendingMerges", () => {
  it("waits for a review still running when the change merged, then applies its result", async () => {
    await finding(7, "fp-old");
    await merge(7);
    // Change 8 merged while its review was running (abortOnClose off).
    await finding(8, "fp-before");
    const running = await prisma.reviewJob.create({
      data: { repositoryId: repoId, number: 8, headSha: "head", trigger: "manual", status: "running" },
    });
    expect(await record(8)).toBe(true);
    expect(await applyPendingMerges()).toEqual({ applied: 0, promoted: 0, resolved: 0, failed: 0 });
    expect((await items()).map((item) => item.fingerprint)).toEqual(["fp-old"]);

    // The run finishes: its sync resolved fp-before, raised fp-after, and its diff fixed fp-old.
    await prisma.finding.updateMany({ where: { number: 8, fingerprint: "fp-before" }, data: { state: "resolved", lifecycle: "fixed" } });
    await finding(8, "fp-after");
    await prisma.reviewJob.update({
      where: { id: running.id },
      data: { status: "completed", result: result({}, [modified("src/app.ts", REWRITE_21)]) },
    });
    expect(await applyPendingMerges()).toEqual({ applied: 1, promoted: 1, resolved: 1, failed: 0 });
    expect((await items()).map((item) => [item.fingerprint, item.state])).toEqual([
      ["fp-after", "open"],
      ["fp-old", "resolved"],
    ]);
    expect(await prisma.changeState.findFirst({ where: { number: 8 } })).toMatchObject({ appliedJobId: running.id });
    // Applied once.
    expect((await applyPendingMerges()).applied).toBe(0);
  });

  it("does not wait for a trial: it syncs no findings", async () => {
    await finding(7, "fp-old");
    await prisma.reviewJob.create({
      data: { repositoryId: repoId, number: 7, headSha: "head", trigger: "manual", status: "queued", trial: true },
    });
    expect(await record(7)).toBe(true);
    expect((await applyPendingMerges()).applied).toBe(1);
    expect((await items()).map((item) => item.fingerprint)).toEqual(["fp-old"]);
  });

  it("replays a later merge against the items of an earlier merge applied late", async () => {
    const early = new Date("2026-11-10T09:00:00Z");
    const later = new Date("2026-11-11T09:00:00Z");
    // B merged second but was applied first; it rewrote line 21.
    const reviewed = await job(8, result({}, [modified("src/app.ts", REWRITE_21)]));
    expect(await merge(8, later)).toEqual({ promoted: 0, fixed: 0, invalidated: 0 });
    // A, with a finding on line 21, is found by the sweep afterwards.
    await finding(7, "fp-a");
    expect(await merge(7, early)).toEqual({ promoted: 1, fixed: 1, invalidated: 0 });
    const [item] = await items();
    expect(item).toMatchObject({ fingerprint: "fp-a", state: "resolved", resolution: "fixed", resolvedNumber: 8, resolvedJobId: reviewed.id });
  });
});

describe("sweepClosedChanges", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const details = (state: ChangeDetails["state"]): ChangeDetails => ({
    state,
    isDraft: false,
    sourceBranch: "feature",
    targetBranch: "main",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    ...(state === "merged" ? { mergedAt: "2026-11-18T09:00:00Z" } : {}),
  });

  it("asks the forge about quiet changes only, and promotes the merged ones", async () => {
    const quiet = new Date(now.getTime() - 2 * HOUR_MS);
    await finding(7, "fp-merged", { lastSeenAt: quiet });
    await finding(8, "fp-open", { lastSeenAt: quiet });
    // Reviewed a moment ago: the webhook and close watch still speak for it.
    await finding(9, "fp-busy", { lastSeenAt: quiet });
    await job(9, result(), new Date(now.getTime() - 10 * 60_000));

    const asked: number[] = [];
    const forgeFor = () => ({
      getChangeDetails: async (_project: string, number: number) => {
        asked.push(number);
        return details(number === 7 ? "merged" : "open");
      },
    });
    expect(await sweepClosedChanges({ now, forgeFor })).toEqual({ checked: 2, merged: 1, failed: 0 });
    expect(asked.sort()).toEqual([7, 8]);
    // Recorded only; the worker applies it.
    expect(await items()).toEqual([]);
    expect((await applyPendingMerges()).applied).toBe(1);
    expect((await items()).map((item) => [item.fingerprint, item.mergedAt.toISOString()])).toEqual([
      ["fp-merged", "2026-11-18T09:00:00.000Z"],
    ]);

    // An hour on: 7 and 8 were just checked, and only 9 has gone quiet since.
    asked.length = 0;
    expect(await sweepClosedChanges({ now: new Date(now.getTime() + HOUR_MS), forgeFor })).toEqual({ checked: 1, merged: 0, failed: 0 });
    expect(asked).toEqual([9]);
  });

  it("does not count a recent or running trial as activity on the change", async () => {
    await finding(7, "fp", { lastSeenAt: new Date(now.getTime() - 2 * HOUR_MS) });
    await prisma.reviewJob.createMany({
      data: [
        { repositoryId: repoId, number: 7, headSha: "head", trigger: "manual", status: "running", trial: true, createdAt: new Date(now.getTime() - 60_000) },
      ],
    });
    const asked: number[] = [];
    const forgeFor = () => ({
      getChangeDetails: async (_project: string, number: number) => {
        asked.push(number);
        return details("open");
      },
    });
    expect(await sweepClosedChanges({ now, forgeFor })).toEqual({ checked: 1, merged: 0, failed: 0 });
    expect(asked).toEqual([7]);
  });

  it("counts a failed check and waits before asking again", async () => {
    await finding(7, "fp", { lastSeenAt: new Date(now.getTime() - 2 * HOUR_MS) });
    const forgeFor = () => ({
      getChangeDetails: async (): Promise<ChangeDetails> => {
        throw new Error("forge down");
      },
    });
    expect(await sweepClosedChanges({ now, forgeFor })).toEqual({ checked: 0, merged: 0, failed: 1 });
    expect(await sweepClosedChanges({ now: new Date(now.getTime() + HOUR_MS), forgeFor })).toEqual({ checked: 0, merged: 0, failed: 0 });
  });

  it("skips a repository deleted mid-sweep and checks the rest", async () => {
    const otherRepo = await createRepo(workspaceId, "team/api");
    const quiet = new Date(now.getTime() - 2 * HOUR_MS);
    await finding(7, "fp-gone", { lastSeenAt: quiet });
    await prisma.finding.create({
      data: {
        repositoryId: otherRepo, number: 3, fingerprint: "fp-kept", title: "t", file: "a.ts", startLine: 1, endLine: 1,
        severity: "minor", category: "bug", kind: "issue", changeTitle: "c", lastSeenAt: quiet,
      },
    });
    // The repository disappears between the candidate query and the lookup.
    const real = prisma.repository.findMany.bind(prisma.repository);
    const spy = vi.spyOn(prisma.repository, "findMany").mockImplementation((async (args: never) =>
      (await real(args)).filter((repo) => repo.id !== repoId)) as never);
    const forgeFor = () => ({ getChangeDetails: async () => details("open") });
    try {
      expect(await sweepClosedChanges({ now, forgeFor })).toEqual({ checked: 1, merged: 0, failed: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("pruneBacklog", () => {
  it("deletes resolved and long-unseen open items, and scrubs old dismissals", async () => {
    await finding(7, "fp-open");
    await finding(7, "fp-stale");
    await finding(7, "fp-resolved");
    await finding(7, "fp-recent");
    await finding(7, "fp-dismissed");
    await merge(7);
    const old = new Date(Date.now() - 40 * DAY_MS);
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-resolved" }, data: { state: "resolved", resolvedAt: old } });
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-recent" }, data: { state: "resolved", resolvedAt: new Date() } });
    await prisma.backlogItem.updateMany({
      where: { fingerprint: "fp-dismissed" },
      data: { state: "dismissed", dismissedAt: old, dismissNote: "module going away" },
    });
    // Merged long ago, but a later review saw it recently: kept.
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-open" }, data: { mergedAt: old, firstSeenAt: old } });
    await prisma.backlogItem.updateMany({ where: { fingerprint: "fp-stale" }, data: { mergedAt: old, firstSeenAt: old, lastSeenAt: old } });

    expect(await pruneBacklog(30)).toEqual({ deleted: 2, scrubbed: 1 });
    expect((await items()).map((item) => item.fingerprint)).toEqual(["fp-dismissed", "fp-open", "fp-recent"]);
    const [tombstone] = await items();
    expect(tombstone).toMatchObject({ state: "dismissed", title: "", file: "", author: null, dismissNote: null });
    expect(tombstone!.scrubbedAt).not.toBeNull();
    expect(await pruneBacklog(30)).toEqual({ deleted: 0, scrubbed: 0 });

    // The dismissal still holds when the problem ships again.
    await finding(9, "fp-dismissed");
    expect((await merge(9))!.promoted).toBe(0);
    expect((await items())[0]).toMatchObject({ fingerprint: "fp-dismissed", state: "dismissed", title: "" });
  });
});

describe("purgeStaleChanges", () => {
  it("keeps a quiet change's unaddressed findings until the sweep has checked it", async () => {
    const old = new Date(Date.now() - 40 * DAY_MS);
    await finding(7, "fp", { firstSeenAt: old, lastSeenAt: old });
    const count = () => prisma.finding.count({ where: { repositoryId: repoId, number: 7 } });

    expect((await purgeStaleChanges(30)).changes).toBe(0);
    expect(await count()).toBe(1);
    // An open answer from the sweep (or a failed check) is enough.
    await prisma.changeState.create({ data: { repositoryId: repoId, number: 7, state: "open", checkedAt: new Date() } });
    expect((await purgeStaleChanges(30)).changes).toBe(1);
    expect(await count()).toBe(0);
  });

  it("waits for a recorded merge to be applied, and keeps the merged state when it purges", async () => {
    const old = new Date(Date.now() - 40 * DAY_MS);
    await finding(7, "fp", { firstSeenAt: old, lastSeenAt: old });
    await record(7, old);
    expect((await purgeStaleChanges(30)).changes).toBe(0);

    expect((await applyMerge(repoId, 7))!.promoted).toBe(1);
    expect((await purgeStaleChanges(30)).changes).toBe(1);
    expect(await prisma.changeState.findFirst({ select: { state: true } })).toEqual({ state: "merged" });
    // A rerun, sweep or redelivered webhook afterwards does not apply it again.
    await prisma.backlogItem.updateMany({ data: { state: "resolved", resolution: "fixed" } });
    expect(await merge(7)).toBeNull();
    expect((await items())[0]).toMatchObject({ state: "resolved" });
  });

  it("does not wait for a sweep that will never check the change", async () => {
    const old = new Date(Date.now() - 40 * DAY_MS);
    await finding(7, "fp", { firstSeenAt: old, lastSeenAt: old });
    await prisma.repository.update({ where: { id: repoId }, data: { enabled: false } });

    expect((await purgeStaleChanges(30)).changes).toBe(1);
  });
});

describe("/api/backlog", () => {
  async function seed() {
    await finding(7, "fp-a", { severity: "critical", title: "SQL injection" });
    await finding(7, "fp-b", { severity: "minor", title: "Unused import", file: "src/util.ts" });
    await merge(7);
  }

  it("lists the workspace's items with filters and search", async () => {
    await seed();
    const all = await request(app).get("/api/backlog").set("Cookie", cookie);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items[0].repository.fullPath).toBe("team/web");

    const critical = await request(app).get("/api/backlog?severity=critical").set("Cookie", cookie);
    expect(critical.body.items.map((item: { title: string }) => item.title)).toEqual(["SQL injection"]);
    const byNumber = await request(app).get("/api/backlog?q=!7").set("Cookie", cookie);
    expect(byNumber.body.total).toBe(2);
    const byFile = await request(app).get("/api/backlog?q=util").set("Cookie", cookie);
    expect(byFile.body.total).toBe(1);
    expect((await request(app).get("/api/backlog?state=resolved").set("Cookie", cookie)).body.total).toBe(0);
  });

  it("counts open items by severity and age", async () => {
    await seed();
    const res = await request(app).get("/api/backlog/stats").set("Cookie", cookie);
    expect(res.body.open).toBe(2);
    expect(res.body.bySeverity).toEqual([
      { severity: "critical", count: 1 },
      { severity: "minor", count: 1 },
    ]);
    expect(res.body.byAge).toEqual([
      { key: "week", count: 2 },
      { key: "month", count: 0 },
      { key: "quarter", count: 0 },
      { key: "older", count: 0 },
    ]);
  });

  it("dismisses with a note and reopens", async () => {
    await seed();
    const [item] = await items();
    const dismissed = await request(app)
      .patch(`/api/backlog/${item!.id}`)
      .set("Cookie", cookie)
      .send({ state: "dismissed", note: "won't fix" });
    expect(dismissed.body.item).toMatchObject({ state: "dismissed", dismissNote: "won't fix" });

    const reopened = await request(app).patch(`/api/backlog/${item!.id}`).set("Cookie", cookie).send({ state: "open" });
    expect(reopened.body.item).toMatchObject({ state: "open", dismissNote: null, dismissedAt: null });
    expect((await request(app).patch(`/api/backlog/${item!.id}`).set("Cookie", cookie).send({ state: "resolved" })).status).toBe(400);
  });

  it("returns the item with its source review, and hides other workspaces' items", async () => {
    await finding(7, "fp-a");
    const review = await job(7, result());
    await merge(7);
    const [item] = await items();

    const res = await request(app).get(`/api/backlog/${item!.id}`).set("Cookie", cookie);
    expect(res.body).toMatchObject({ item: { id: item!.id }, sourceReviewId: review.id });

    const other = await createUser("other@example.com");
    expect((await request(app).get(`/api/backlog/${item!.id}`).set("Cookie", other.cookie)).status).toBe(404);
    expect((await request(app).patch(`/api/backlog/${item!.id}`).set("Cookie", other.cookie).send({ state: "open" })).status).toBe(404);
    expect((await request(app).get("/api/backlog").set("Cookie", other.cookie)).body.total).toBe(0);
  });
  it("hides retention tombstones from the list, stats, detail and updates", async () => {
    await seed();
    const [item] = await items();
    await prisma.backlogItem.update({
      where: { id: item!.id },
      data: { state: "dismissed", dismissedAt: new Date(), scrubbedAt: new Date(), title: "", file: "" },
    });
    expect((await request(app).get("/api/backlog").set("Cookie", cookie)).body.total).toBe(1);
    expect((await request(app).get("/api/backlog?state=dismissed").set("Cookie", cookie)).body.total).toBe(0);
    expect((await request(app).get("/api/backlog/stats").set("Cookie", cookie)).body.open).toBe(1);
    expect((await request(app).get(`/api/backlog/${item!.id}`).set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).patch(`/api/backlog/${item!.id}`).set("Cookie", cookie).send({ state: "open" })).status).toBe(404);
  });
});
