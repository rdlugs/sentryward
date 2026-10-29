import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { lockChange } from "../src/lib/changeLock.ts";
import { prisma } from "../src/lib/prisma.ts";
import {
  ACCESS_LOST_REASON,
  cancelForDisabledRepositories,
  cancelJob,
  cancelQueuedForClosedChange,
  claimNext,
  claimState,
  complete,
  enqueue,
  enqueueFromWebhook,
  fail,
  DISABLED_REASON,
  heartbeat,
  recordProgress,
  recordTitle,
  recoverStale,
} from "../src/worker/queue.ts";

let repositoryId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const workspace = await prisma.workspace.create({ data: { name: "Queue Test" } });
  const connection = await prisma.forgeConnection.create({
    data: {
      workspaceId: workspace.id,
      provider: "github",
      host: "github.com",
      kind: "github_app",
      installationId: "1",
      accountLogin: "acme",
    },
  });
  const repository = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "github",
      host: "github.com",
      fullPath: "acme/web",
      externalId: "100",
      defaultBranch: "main",
      enabled: true,
    },
  });
  repositoryId = repository.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const job = (headSha: string, number = 7) =>
  enqueue({ repositoryId, number, headSha, trigger: "webhook" });

describe("enqueue", () => {
  it("returns the existing job for the same head instead of duplicating it", async () => {
    const first = await job("aaa");
    const second = await job("aaa");

    expect(second.id).toBe(first.id);
    expect(await prisma.reviewJob.count()).toBe(1);
  });

  it("supersedes a queued job when a newer head arrives", async () => {
    const old = await job("aaa");
    const latest = await job("bbb");

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: old.id } })).status).toBe(
      "superseded",
    );
    expect(latest.status).toBe("queued");
  });

  it("leaves other pull requests alone", async () => {
    const other = await job("aaa", 8);
    await job("bbb", 7);

    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      "queued",
    );
  });

  it("leaves one queued job when newer heads arrive concurrently", async () => {
    await Promise.all(["a", "b", "c", "d", "e"].map((sha) => job(sha)));

    const jobs = await prisma.reviewJob.findMany();
    expect(jobs).toHaveLength(5);
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(1);
    expect(jobs.filter((j) => j.status === "superseded")).toHaveLength(4);
  });

  it("creates one job when the same head is enqueued concurrently", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => job("aaa")));

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.reviewJob.count()).toBe(1);
  });
});

describe("claimNext", () => {
  it("claims the oldest queued job and marks it running", async () => {
    const first = await job("aaa", 1);
    await job("bbb", 2);

    const claimed = await claimNext();

    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.lockedAt).toBeInstanceOf(Date);
  });

  it("never hands the same job to two concurrent claims", async () => {
    await Promise.all([1, 2, 3].map((n) => job(`sha${n}`, n)));

    const claims = await Promise.all(Array.from({ length: 6 }, () => claimNext()));
    const ids = claims.filter((c) => c !== null).map((c) => c.id);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("returns null when nothing is queued", async () => {
    expect(await claimNext()).toBeNull();
  });

  it("clears the progress an earlier attempt recorded", async () => {
    const queued = await job("aaa", 1);
    await prisma.reviewJob.update({ where: { id: queued.id }, data: { progress: { stage: "reviewing" } } });

    const claimed = await claimNext();

    expect(claimed?.progress).toBeNull();
  });
});

describe("recordProgress", () => {
  it("writes for the attempt that holds the job, and for no other", async () => {
    await job("aaa", 1);
    const claimed = (await claimNext())!;

    await recordProgress(claimed.id, claimed.attempts, { stage: "fetching" });
    // An earlier attempt that lost its claim.
    await recordProgress(claimed.id, claimed.attempts - 1, { stage: "publishing" });

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(stored.progress).toEqual({ stage: "fetching" });
  });

  it("leaves a finished job alone", async () => {
    await job("aaa", 1);
    const claimed = (await claimNext())!;
    await complete(claimed.id, { status: "completed", verdict: "pass" });

    await recordProgress(claimed.id, claimed.attempts, { stage: "publishing" });

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(stored.progress).toBeNull();
  });
});

describe("complete and fail", () => {
  it("stores the result and verdict and releases the lock", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;

    await complete(claimed.id, {
      status: "completed",
      verdict: "blocked",
      result: { findings: [{ title: "x" }] },
    });

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(stored).toMatchObject({ status: "completed", verdict: "blocked", lockedAt: null });
    expect(stored.result).toEqual({ findings: [{ title: "x" }] });
    expect(stored.finishedAt).toBeInstanceOf(Date);
  });

  it("records a failure as an error verdict", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;

    await fail(claimed.id, "boom");

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(stored).toMatchObject({ status: "failed", verdict: "error", error: "boom" });
  });

  it("records the change's title whatever the run's status, a cancel included", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;
    const { workspaceId } = await prisma.forgeConnection.findFirstOrThrow();
    await cancelJob(claimed.id, workspaceId, "Review cancelled");

    await recordTitle(claimed.id, "Fix login redirect");

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(stored).toMatchObject({ status: "cancelled", title: "Fix login redirect" });
  });
});

describe("cancelForDisabledRepositories", () => {
  it("cancels the repository's queued and running jobs and leaves finished ones", async () => {
    const running = await job("aaa", 1);
    await claimNext();
    const queued = await job("bbb", 2);
    const done = await job("ccc", 3);
    await prisma.reviewJob.update({ where: { id: done.id }, data: { status: "completed", finishedAt: new Date() } });

    expect(await cancelForDisabledRepositories([repositoryId], DISABLED_REASON)).toBe(2);

    for (const id of [running.id, queued.id]) {
      const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id } });
      expect(stored).toMatchObject({ status: "cancelled", error: "Reviews were turned off for this repository", lockedAt: null });
      expect(stored.finishedAt).toBeInstanceOf(Date);
    }
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({ status: "completed", error: null });
    // The worker cannot overwrite the reason when it finishes.
    expect(await complete(running.id, { status: "completed", verdict: "pass" })).toBe(false);
  });

  it("records the reason it was given and does nothing for no repositories", async () => {
    const queued = await job("aaa");

    expect(await cancelForDisabledRepositories([], ACCESS_LOST_REASON)).toBe(0);
    expect(await cancelForDisabledRepositories([repositoryId], ACCESS_LOST_REASON)).toBe(1);

    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({
      status: "cancelled",
      error: "Sentryward lost access to this repository",
    });
  });
});

describe("cancelQueuedForClosedChange", () => {
  it("cancels a push being queued at the same moment", async () => {
    const repo = await prisma.repository.findUniqueOrThrow({ where: { id: repositoryId } });
    let cancelling!: Promise<number>;
    await prisma.$transaction(async (tx) => {
      await lockChange(tx, "enqueue", repositoryId, 7);
      await tx.reviewJob.create({ data: { repositoryId, number: 7, headSha: "aaa", trigger: "webhook" } });
      cancelling = cancelQueuedForClosedChange(repo, 7);
      // Long enough for the cancel to reach the lock before this job commits.
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(await cancelling).toBe(1);
    expect(await prisma.reviewJob.findFirstOrThrow()).toMatchObject({ status: "cancelled" });
  });
});

describe("recoverStale", () => {
  it("supersedes a stale job when a newer head of its change is queued", async () => {
    const stale = await job("aaa");
    await claimNext();
    await prisma.reviewJob.update({
      where: { id: stale.id },
      data: { lockedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const newer = await job("bbb");

    expect((await recoverStale(15 * 60 * 1000, 3)).count).toBe(1);
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
      status: "superseded",
      lockedAt: null,
    });
    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: newer.id } })).status).toBe("queued");
  });

  it("requeues a stale job with attempts left and fails one without", async () => {
    const retry = await job("aaa", 1);
    const exhausted = await job("bbb", 2);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.reviewJob.update({
      where: { id: retry.id },
      data: { status: "running", lockedAt: longAgo, attempts: 1 },
    });
    await prisma.reviewJob.update({
      where: { id: exhausted.id },
      data: { status: "running", lockedAt: longAgo, attempts: 3 },
    });

    expect(await recoverStale(15 * 60 * 1000, 3)).toEqual({ count: 2, failedIds: [exhausted.id] });
    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: retry.id } })).status).toBe(
      "queued",
    );
    expect(
      await prisma.reviewJob.findUniqueOrThrow({ where: { id: exhausted.id } }),
    ).toMatchObject({ status: "failed", verdict: "error" });
  });

  it("leaves a fresh running job alone", async () => {
    await job("aaa");
    await claimNext();

    expect((await recoverStale(15 * 60 * 1000, 3)).count).toBe(0);
  });
});

describe("heartbeat", () => {
  it("refreshes the lock so a slow-but-healthy job is not reclaimed", async () => {
    const slow = await job("aaa");
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.reviewJob.update({
      where: { id: slow.id },
      data: { status: "running", lockedAt: longAgo, attempts: 1 },
    });

    await heartbeat(slow.id);

    // The bumped lock is now fresh, so recovery leaves the job running.
    expect((await recoverStale(15 * 60 * 1000, 3)).count).toBe(0);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: slow.id } });
    expect(stored.status).toBe("running");
    expect(stored.lockedAt!.getTime()).toBeGreaterThan(longAgo.getTime());
  });

  it("does not touch a job that is no longer running", async () => {
    const done = await job("aaa");
    const claimed = (await claimNext())!;
    await complete(claimed.id, { status: "completed", verdict: "pass" });

    await heartbeat(done.id);

    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: done.id } });
    expect(stored.status).toBe("completed");
    expect(stored.lockedAt).toBeNull();
  });
});

describe("claimState", () => {
  it("is owned while the job runs under the same attempt", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;

    expect(await claimState(claimed.id, claimed.attempts)).toBe("owned");
  });

  it("reports a cancel from the dashboard", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;
    const { workspaceId } = await prisma.forgeConnection.findFirstOrThrow();
    await cancelJob(claimed.id, workspaceId, "Cancelled by Dev");

    expect(await claimState(claimed.id, claimed.attempts)).toBe("cancelled");
  });

  it("tells a cancel for a repository turned off apart from a dashboard cancel", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;
    await cancelForDisabledRepositories([repositoryId], DISABLED_REASON);

    expect(await claimState(claimed.id, claimed.attempts)).toBe("disabled");
  });

  it("is lost once the job was failed", async () => {
    await job("aaa");
    const claimed = (await claimNext())!;
    await fail(claimed.id, "Review exceeded the maximum run time");

    expect(await claimState(claimed.id, claimed.attempts)).toBe("lost");
  });

  it("is lost once recovery requeued the job and another run claimed it", async () => {
    await job("aaa");
    const first = (await claimNext())!;
    await prisma.reviewJob.update({
      where: { id: first.id },
      data: { lockedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await recoverStale(15 * 60 * 1000, 3);
    const second = (await claimNext())!;

    expect(second.id).toBe(first.id);
    expect(await claimState(first.id, first.attempts)).toBe("lost");
    expect(await claimState(second.id, second.attempts)).toBe("owned");
  });
});

describe("per-workspace concurrency", () => {
  it("skips a workspace at its running limit and serves the next workspace", async () => {
    const other = await prisma.workspace.create({ data: { name: "O" } });
    const conn = await prisma.forgeConnection.create({
      data: { workspaceId: other.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "o" },
    });
    const otherRepo = await prisma.repository.create({
      data: { connectionId: conn.id, provider: "gitlab", host: "gitlab.com", fullPath: "o/r", externalId: "2", defaultBranch: "main" },
    });
    await job("a", 1);
    await job("b", 2);
    const theirs = await enqueue({ repositoryId: otherRepo.id, number: 1, headSha: "c", trigger: "manual" });

    expect((await claimNext(1))?.number).toBe(1);
    // The first workspace is at its limit of one, so its second job waits.
    expect((await claimNext(1))?.id).toBe(theirs.id);
    expect(await claimNext(1)).toBeNull();
  });
  it("counts every connection in a workspace against the same limit", async () => {
    const { workspaceId } = await prisma.forgeConnection.findFirstOrThrow();
    const second = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "teammate" },
    });
    const secondRepo = await prisma.repository.create({
      data: { connectionId: second.id, provider: "gitlab", host: "gitlab.com", fullPath: "t/r", externalId: "3", defaultBranch: "main" },
    });
    await job("a", 1);
    await enqueue({ repositoryId: secondRepo.id, number: 1, headSha: "b", trigger: "manual" });

    expect(await claimNext(1)).not.toBeNull();
    expect(await claimNext(1)).toBeNull();
  });
});

describe("enqueueFromWebhook", () => {
  it("refuses a head it has seen in any state but superseded", async () => {
    const done = await job("aaa");
    await prisma.reviewJob.update({ where: { id: done.id }, data: { status: "failed" } });
    expect(await enqueueFromWebhook({ repositoryId, number: 7, headSha: "aaa", trigger: "webhook" })).toEqual({
      queued: false,
      reason: "duplicate",
    });
  });

  it("queues a head again once its job was cancelled only because the repository was off", async () => {
    await job("aaa");
    await cancelForDisabledRepositories([repositoryId], DISABLED_REASON);

    const result = await enqueueFromWebhook({ repositoryId, number: 7, headSha: "aaa", trigger: "webhook" });
    expect(result).toMatchObject({ queued: true, job: { status: "queued", headSha: "aaa" } });
  });

  it("still refuses a head whose job was cancelled from the dashboard", async () => {
    const queued = await job("aaa");
    const { workspaceId } = await prisma.forgeConnection.findFirstOrThrow();
    await cancelJob(queued.id, workspaceId, "Cancelled by Dev");

    expect(await enqueueFromWebhook({ repositoryId, number: 7, headSha: "aaa", trigger: "webhook" })).toEqual({
      queued: false,
      reason: "duplicate",
    });
  });

  it("queues a head once when its delivery is repeated concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => enqueueFromWebhook({ repositoryId, number: 7, headSha: "aaa", trigger: "webhook" })),
    );

    expect(results.filter((r) => r.queued)).toHaveLength(1);
    expect(results.filter((r) => !r.queued && r.reason === "duplicate")).toHaveLength(4);
    expect(await prisma.reviewJob.count()).toBe(1);
  });

  it("leaves one queued job when deliveries of newer heads arrive concurrently", async () => {
    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((headSha) => enqueueFromWebhook({ repositoryId, number: 7, headSha, trigger: "webhook" })),
    );

    expect(results.filter((r) => r.queued)).toHaveLength(5);
    const jobs = await prisma.reviewJob.findMany();
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(1);
    expect(jobs.filter((j) => j.status === "superseded")).toHaveLength(4);
  });

  it("stops queueing once a repository's queue is full", async () => {
    for (let n = 1; n <= 10; n++) await job(`s${n}`, n);
    expect(await enqueueFromWebhook({ repositoryId, number: 99, headSha: "z", trigger: "webhook" })).toEqual({
      queued: false,
      reason: "queue_full",
    });
  });
});
