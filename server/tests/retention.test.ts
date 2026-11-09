import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client.ts";
import type { ReviewStatus } from "../src/generated/prisma/client.ts";
import { prisma } from "../src/lib/prisma.ts";
import {
  DELIVERIES_PER_TARGET,
  pruneReviews,
  purgeStaleChanges,
  runRetention,
} from "../src/worker/retention.ts";
import { createUser } from "./helpers/users.ts";

const NOW = new Date("2026-06-01T00:00:00Z");
const OLD = new Date("2026-04-01T00:00:00Z"); // 61 days before NOW
const RECENT = new Date("2026-05-20T00:00:00Z"); // 12 days before NOW

let repoId: string;
let workspaceId: string;

beforeEach(async () => {
  await prisma.llmRequestLog.deleteMany();
  await prisma.instanceSettings.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const { workspace } = await createUser();
  workspaceId = workspace.id;
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "dev" },
  });
  const repo = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "gitlab",
      host: "gitlab.com",
      fullPath: "team/web",
      externalId: "1",
      defaultBranch: "main",
      enabled: true,
    },
  });
  repoId = repo.id;
});

afterAll(async () => {
  await prisma.instanceSettings.deleteMany();
  await prisma.$disconnect();
});

async function job(status: ReviewStatus, finishedAt: Date | null, overrides: Partial<Prisma.ReviewJobUncheckedCreateInput> = {}) {
  return prisma.reviewJob.create({
    data: {
      repositoryId: repoId,
      number: 7,
      headSha: "head",
      trigger: "manual",
      status,
      finishedAt,
      result: { big: true },
      resolvedConfig: { config: {} },
      publication: { inlinePosted: [] },
      summary: { title: "T" },
      ...overrides,
    },
  });
}

// A newer run of the same change, so older ones are not its latest.
const newerRun = () => job("completed", RECENT);

const load = (id: string) => prisma.reviewJob.findUnique({ where: { id } });

describe("pruneReviews", () => {
  it("deletes old runs that reviewed nothing", async () => {
    const old = await Promise.all((["superseded", "skipped", "cancelled"] as const).map((s) => job(s, OLD)));
    const recent = await job("superseded", RECENT);

    const pruned = await pruneReviews(30, { now: NOW });

    expect(pruned.deleted).toBe(3);
    for (const { id } of old) expect(await load(id)).toBeNull();
    expect(await load(recent.id)).not.toBeNull();
  });

  it("clears the large columns of old finished runs but keeps the row, summary and finding links", async () => {
    const old = await Promise.all((["completed", "partial", "failed"] as const).map((s) => job(s, OLD)));
    await newerRun();
    const finding = await prisma.finding.create({
      data: {
        repositoryId: repoId,
        number: 7,
        fingerprint: "fp",
        title: "Bug",
        file: "a.ts",
        startLine: 1,
        severity: "major",
        category: "bug",
        kind: "inline",
        changeTitle: "T",
        lastJobId: old[0]!.id,
      },
    });

    const pruned = await pruneReviews(30, { now: NOW });

    expect(pruned).toEqual({ deleted: 0, trimmed: 3 });
    for (const { id } of old) {
      const row = await load(id);
      expect(row).toMatchObject({
        result: null,
        resolvedConfig: null,
        publication: null,
        summary: { title: "T" },
        resultExpiredAt: NOW,
      });
    }
    expect((await prisma.finding.findUnique({ where: { id: finding.id } }))!.lastJobId).toBe(old[0]!.id);
  });

  it("keeps recent runs and runs still in flight untouched", async () => {
    const kept = [
      await job("completed", RECENT),
      await job("skipped", RECENT),
      await job("queued", null),
      await job("running", null),
    ];

    expect(await pruneReviews(30, { now: NOW })).toEqual({ deleted: 0, trimmed: 0 });
    for (const { id } of kept) {
      expect(await load(id)).toMatchObject({ result: { big: true }, resultExpiredAt: null });
    }
  });

  it("works through more rows than one batch, and a second pass finds nothing left", async () => {
    for (let i = 0; i < 5; i++) await job("superseded", OLD);
    for (let i = 0; i < 5; i++) await job("completed", OLD);
    await newerRun();

    expect(await pruneReviews(30, { now: NOW, batchSize: 2 })).toEqual({ deleted: 5, trimmed: 5 });
    expect(await pruneReviews(30, { now: NOW, batchSize: 2 })).toEqual({ deleted: 0, trimmed: 0 });
    expect(await prisma.reviewJob.count({ where: { repositoryId: repoId } })).toBe(6);
  });

  it("keeps the newest run that reviewed each change, even when it is old", async () => {
    const older = await job("completed", new Date("2026-03-01T00:00:00Z"));
    const newest = await job("partial", OLD);
    // A later failure is not a review the change's findings were synced from.
    const failed = await job("failed", new Date("2026-04-15T00:00:00Z"));
    const otherChange = await job("completed", OLD, { number: 8 });

    expect(await pruneReviews(30, { now: NOW })).toEqual({ deleted: 0, trimmed: 2 });
    expect(await load(older.id)).toMatchObject({ result: null, resultExpiredAt: NOW });
    expect(await load(failed.id)).toMatchObject({ result: null, resultExpiredAt: NOW });
    for (const { id } of [newest, otherChange]) {
      expect(await load(id)).toMatchObject({ result: { big: true }, resultExpiredAt: null });
    }
  });

  it("leaves old runs that stored nothing unmarked", async () => {
    const failed = await job("failed", OLD, {
      result: Prisma.DbNull,
      resolvedConfig: Prisma.DbNull,
      publication: Prisma.DbNull,
      error: "Could not fetch the change",
    });

    expect(await pruneReviews(30, { now: NOW })).toEqual({ deleted: 0, trimmed: 0 });
    expect(await load(failed.id)).toMatchObject({ resultExpiredAt: null, error: "Could not fetch the change" });
  });
});

// Another workspace with its own repository, for scoping.
async function otherRepo() {
  const { workspace } = await createUser("other@example.com");
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "other" },
  });
  const repo = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "gitlab",
      host: "gitlab.com",
      fullPath: "other/web",
      externalId: "2",
      defaultBranch: "main",
      enabled: true,
    },
  });
  return { workspaceId: workspace.id, repoId: repo.id };
}

async function finding(seenAt: Date, overrides: Partial<Prisma.FindingUncheckedCreateInput> = {}) {
  return prisma.finding.create({
    data: {
      repositoryId: repoId,
      number: 7,
      fingerprint: "fp",
      title: "Bug",
      file: "a.ts",
      startLine: 1,
      severity: "major",
      category: "bug",
      kind: "inline",
      changeTitle: "T",
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      ...overrides,
    },
  });
}

async function threadReply(createdAt: Date, status: "done" | "queued" = "done", repositoryId = repoId) {
  return prisma.threadReply.create({
    data: {
      repositoryId,
      number: 7,
      fingerprint: "fp",
      threadId: "t",
      commentId: `c-${Math.random()}`,
      actor: "alice",
      kind: "question",
      body: "Why?",
      status,
      createdAt,
    },
  });
}

describe("pruneReviews scoped to workspaces", () => {
  it("only prunes the workspaces named", async () => {
    const mine = await job("superseded", OLD);
    const other = await otherRepo();
    const theirs = await job("superseded", OLD, { repositoryId: other.repoId });

    expect(await pruneReviews(30, { now: NOW, workspaceIds: [other.workspaceId] })).toEqual({ deleted: 1, trimmed: 0 });
    expect(await load(mine.id)).not.toBeNull();
    expect(await load(theirs.id)).toBeNull();
  });
});

describe("purgeStaleChanges", () => {
  it("purges a change gone quiet: findings, posted comments, replies and the kept result", async () => {
    const newest = await job("completed", OLD);
    await finding(OLD);
    await prisma.postedFinding.create({
      data: { repositoryId: repoId, number: 7, fingerprint: "fp", forgeCommentId: "1", createdAt: OLD },
    });
    await threadReply(OLD);

    const purged = await purgeStaleChanges(30, { now: NOW, workspaceIds: [workspaceId] });

    expect(purged).toEqual({ changes: 1, findings: 1, postedFindings: 1, replies: 1 });
    expect(await prisma.finding.count()).toBe(0);
    expect(await prisma.postedFinding.count()).toBe(0);
    expect(await prisma.threadReply.count()).toBe(0);
    expect(await load(newest.id)).toMatchObject({ result: null, summary: { title: "T" }, resultExpiredAt: NOW });
    // A second pass has nothing left to do.
    expect((await purgeStaleChanges(30, { now: NOW, workspaceIds: [workspaceId] })).changes).toBe(0);
  });

  it("leaves a change with recent activity of any kind alone", async () => {
    await job("completed", OLD);
    await finding(OLD, { ignoredAt: RECENT });
    await finding(OLD, { fingerprint: "other", number: 8 });
    await threadReply(RECENT, "done");

    const purged = await purgeStaleChanges(30, { now: NOW, workspaceIds: [workspaceId] });

    // Change 7 was ignored and replied to recently; change 8 has only an old finding.
    expect(purged).toEqual({ changes: 1, findings: 1, postedFindings: 0, replies: 0 });
    expect(await prisma.finding.count({ where: { number: 7 } })).toBe(1);
  });

  it("waits while a review or reply of the change is in flight", async () => {
    await finding(OLD);
    const queued = await threadReply(OLD, "queued");
    expect((await purgeStaleChanges(30, { now: NOW })).changes).toBe(0);

    await prisma.threadReply.delete({ where: { id: queued.id } });
    await job("queued", null, { createdAt: OLD });
    expect((await purgeStaleChanges(30, { now: NOW })).changes).toBe(0);
  });
});

describe("runRetention", () => {
  it("does nothing when no retention is set anywhere", async () => {
    const old = await job("superseded", OLD);
    await finding(OLD);

    const result = await runRetention({ now: NOW });

    expect(result).toMatchObject({ deleted: 0, changes: 0, auditRows: 0 });
    expect(await load(old.id)).not.toBeNull();
  });

  it("applies the shorter of the instance and workspace periods per workspace", async () => {
    await prisma.instanceSettings.create({ data: { id: 1, retentionDays: 365 } });
    const other = await otherRepo();
    await prisma.workspacePrivacy.create({ data: { workspaceId: other.workspaceId, retentionDays: 30 } });
    const mine = await job("superseded", OLD);
    const theirs = await job("superseded", OLD, { repositoryId: other.repoId });
    await threadReply(OLD, "done", other.repoId);

    const result = await runRetention({ now: NOW });

    // 61 days old: past the other workspace's 30, inside the instance's 365.
    expect(await load(mine.id)).not.toBeNull();
    expect(await load(theirs.id)).toBeNull();
    expect(result).toMatchObject({ deleted: 1, replies: 1 });
  });

  it("clears expired OAuth round trips even when no new one starts", async () => {
    await prisma.signInState.deleteMany();
    const { user } = await createUser("oauth@example.com");
    const base = { provider: "github" as const, intent: "login" as const, codeVerifier: "v", browserNonceHash: "h" };
    await prisma.signInState.create({ data: { ...base, id: "expired", inviteToken: "x", expiresAt: OLD } });
    await prisma.signInState.create({ data: { ...base, id: "live", expiresAt: new Date(NOW.getTime() + 60_000) } });
    await prisma.oAuthState.create({
      data: { id: "forge", userId: user.id, workspaceId, host: "gitlab.com", codeVerifier: "v", expiresAt: OLD },
    });

    const result = await runRetention({ now: NOW });

    expect(result.oauthStates).toBe(2);
    expect((await prisma.signInState.findMany()).map((row) => row.id)).toEqual(["live"]);
    expect(await prisma.oAuthState.count()).toBe(0);
  });

  it("keeps notification deliveries for 30 days and at most 100 per target", async () => {
    const make = (name: string) =>
      prisma.notificationTarget.create({ data: { workspaceId, kind: "slack", name, events: ["failed"] } });
    const busy = await make("busy");
    const quiet = await make("quiet");
    const row = (targetId: string, createdAt: Date) => ({
      targetId,
      event: "failed",
      status: "sent" as const,
      createdAt,
      finishedAt: createdAt,
    });
    await prisma.notificationDelivery.createMany({
      data: Array.from({ length: DELIVERIES_PER_TARGET + 5 }, (_, i) =>
        row(busy.id, new Date(RECENT.getTime() + i * 1000)),
      ),
    });
    await prisma.notificationDelivery.createMany({ data: [row(quiet.id, OLD), row(quiet.id, RECENT)] });

    const result = await runRetention({ now: NOW });

    expect(result.deliveries).toBe(6);
    const kept = await prisma.notificationDelivery.findMany({ where: { targetId: busy.id }, orderBy: { createdAt: "asc" } });
    expect(kept).toHaveLength(DELIVERIES_PER_TARGET);
    // The oldest five went.
    expect(kept[0]!.createdAt).toEqual(new Date(RECENT.getTime() + 5000));
    expect(await prisma.notificationDelivery.findMany({ where: { targetId: quiet.id } })).toMatchObject([
      { createdAt: RECENT },
    ]);
  });

  it("purges audit rows past the instance's audit period", async () => {
    await prisma.instanceSettings.create({ data: { id: 1, auditRetentionDays: 30 } });
    const base = { workspaceName: "W", purpose: "review", provider: "anthropic", host: "h", model: "anthropic/m", outcome: "ok" };
    await prisma.llmRequestLog.create({ data: { ...base, createdAt: OLD } });
    const recent = await prisma.llmRequestLog.create({ data: { ...base, createdAt: RECENT } });

    const result = await runRetention({ now: NOW });

    expect(result.auditRows).toBe(1);
    expect((await prisma.llmRequestLog.findMany()).map((row) => row.id)).toEqual([recent.id]);
  });
});
