import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.ts";
import { execute } from "../src/worker/execute.ts";
import { claimNext, enqueue, recoverStale } from "../src/worker/queue.ts";

let repositoryId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const workspace = await prisma.workspace.create({ data: { name: "Execute Test" } });
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

async function claimedJob() {
  await enqueue({ repositoryId, number: 7, headSha: "aaa", trigger: "manual" });
  return (await claimNext())!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("execute", () => {
  it("fails a run that never settles once it passes the maximum run time", async () => {
    const job = await claimedJob();
    const notify = vi.fn(async () => {});

    await execute(job, { runJob: () => new Promise(() => {}), heartbeatMs: 1000, maxRunMs: 30, notify });

    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "failed",
      verdict: "error",
      error: "Review exceeded the maximum run time",
    });
    expect(notify).toHaveBeenCalledWith(job.id);
  });

  it("keeps a long run's lock fresh so recovery leaves it alone", async () => {
    const job = await claimedJob();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.reviewJob.update({ where: { id: job.id }, data: { lockedAt: longAgo } });
    let recovered = -1;

    await execute(job, {
      runJob: async () => {
        await sleep(60);
        recovered = (await recoverStale(15 * 60 * 1000, 3)).count;
      },
      heartbeatMs: 10,
      maxRunMs: 60_000,
      notify: async () => {},
    });

    expect(recovered).toBe(0);
    const stored = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("running");
    expect(stored.lockedAt!.getTime()).toBeGreaterThan(longAgo.getTime());
  });

  it("releases the change's lease once the run returns, or throws", async () => {
    for (const runJob of [async () => {}, async () => Promise.reject(new Error("boom"))]) {
      await prisma.reviewJob.deleteMany();
      const job = await claimedJob();
      expect(job.leaseExpiresAt).toBeInstanceOf(Date);

      await execute(job, { runJob, heartbeatMs: 1000, maxRunMs: 60_000, notify: async () => {} });

      expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).leaseExpiresAt).toBeNull();
    }
  });

  it("keeps a timed-out run's lease, unrenewed, until that run returns", async () => {
    const job = await claimedJob();
    let finish!: () => void;
    const late = new Promise<void>((resolve) => {
      finish = resolve;
    });

    await execute(job, { runJob: () => late, heartbeatMs: 5, maxRunMs: 30, leaseMs: 60_000, notify: async () => {} });

    // A beat already in flight when the timer stopped may still land.
    await sleep(20);
    const held = (await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).leaseExpiresAt!;
    await sleep(30);
    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).leaseExpiresAt).toEqual(held);

    finish();
    // The release is a DB write after the run settles; poll rather than guess
    // how long a slow CI runner takes.
    await vi.waitFor(async () => {
      expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).leaseExpiresAt).toBeNull();
    });
  });

  it("records a thrown error as the failure", async () => {
    const job = await claimedJob();
    const notify = vi.fn(async () => {});

    await execute(job, {
      runJob: async () => {
        throw new Error("The repository is no longer connected");
      },
      heartbeatMs: 1000,
      maxRunMs: 60_000,
      notify,
    });

    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "failed",
      error: "The repository is no longer connected",
    });
    expect(notify).toHaveBeenCalledWith(job.id);
  });
});
