import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import type {
  NotificationEvent,
  NotificationMinSeverity,
  ReviewStatus,
  ReviewTrigger,
  ReviewVerdict,
} from "../src/generated/prisma/client.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { mailer } from "../src/lib/mailer.ts";
import { prisma } from "../src/lib/prisma.ts";
import { eventForTarget, eventsFor, notifyJob, SCOPE_REASON } from "../src/services/notifications.ts";
import { claimDueDeliveries, runDelivery } from "../src/worker/deliveryQueue.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { createUser } from "./helpers/users.ts";

let cookie: string;
let userId: string;
let workspaceId: string;
let connectionId: string;
let web: string;
let api: string;

async function addRepository(fullPath: string, externalId: string) {
  const repo = await prisma.repository.create({
    data: {
      connectionId,
      provider: "github",
      host: "github.com",
      fullPath,
      externalId,
      defaultBranch: "main",
      enabled: true,
    },
  });
  return repo.id;
}

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  ({ cookie, user: { id: userId }, workspace: { id: workspaceId } } = await createUser());
  const connection = await prisma.forgeConnection.create({
    data: {
      workspaceId,
      provider: "github",
      host: "github.com",
      kind: "github_app",
      installationId: "1",
      accountLogin: "acme",
    },
  });
  connectionId = connection.id;
  web = await addRepository("acme/web", "100");
  api = await addRepository("acme/api", "101");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

let clock = Date.parse("2026-11-01T00:00:00Z");

interface JobOptions {
  repositoryId?: string;
  number?: number;
  trigger?: ReviewTrigger;
  bySeverity?: Record<string, number>;
}

// Each job finishes a minute after the one before, so "previous" is the order
// they are created in.
function finishedJob(status: ReviewStatus, verdict: ReviewVerdict | null, options: JobOptions = {}) {
  clock += 60_000;
  const bySeverity = options.bySeverity ?? { minor: 1 };
  const total = Object.values(bySeverity).reduce((sum, n) => sum + n, 0);
  return prisma.reviewJob.create({
    data: {
      repositoryId: options.repositoryId ?? web,
      number: options.number ?? 7,
      headSha: "aaa",
      trigger: options.trigger ?? "manual",
      status,
      verdict,
      summary: status === "failed" ? undefined : { title: "Add login", total, bySeverity, byBucket: {} },
      finishedAt: new Date(clock),
    },
  });
}

interface TargetOptions {
  events?: NotificationEvent[];
  repositoryIds?: string[];
  minSeverity?: NotificationMinSeverity | null;
  onlyVerdictChanges?: boolean;
  url?: string;
}

function target(options: TargetOptions = {}) {
  return prisma.notificationTarget.create({
    data: {
      workspaceId,
      kind: "webhook",
      name: "hook",
      events: options.events ?? ["completed"],
      repositoryIds: options.repositoryIds ?? [],
      minSeverity: options.minSeverity ?? null,
      onlyVerdictChanges: options.onlyVerdictChanges ?? false,
      encryptedUrl: encrypt(options.url ?? "https://hooks.example.com/sw"),
      encryptedSecret: encrypt("shh"),
    },
  });
}

// The event queued for a target by a job, or null when none was.
async function queued(targetId: string, jobId: string) {
  await notifyJob(jobId);
  const row = await prisma.notificationDelivery.findFirst({ where: { targetId, jobId } });
  return row?.event ?? null;
}

describe("eventsFor with the previous verdict", () => {
  it.each([
    ["pass", "blocked", ["resolved", "completed"]],
    ["error", "blocked", ["resolved", "completed"]],
    ["pass", "pass", ["completed"]],
    ["pass", undefined, ["completed"]],
    ["blocked", "blocked", ["blocked", "completed"]],
  ] as const)("%s after %s counts as %j", (verdict, previous, events) => {
    expect(eventsFor({ status: "completed", verdict }, previous)).toEqual(events);
  });

  it("never calls a failed run resolved", () => {
    expect(eventsFor({ status: "failed", verdict: "error" }, "blocked")).toEqual(["failed"]);
  });
});

describe("eventForTarget", () => {
  const base = { events: ["failed", "blocked", "resolved", "completed"] as NotificationEvent[], minSeverity: null, onlyVerdictChanges: false };

  it("lets failed and resolved through whatever the filters say", () => {
    const strict = { ...base, minSeverity: "critical" as const, onlyVerdictChanges: true };
    const facts = { bySeverity: {}, verdict: "pass" as const, previous: "pass" as const };
    expect(eventForTarget(["failed"], strict, facts)).toBe("failed");
    expect(eventForTarget(["resolved", "completed"], strict, facts)).toBe("resolved");
    expect(eventForTarget(["completed"], strict, facts)).toBeNull();
  });

  it("counts a finding at or above the floor", () => {
    const facts = { bySeverity: { minor: 2, major: 1 }, verdict: "pass" as const, previous: undefined };
    expect(eventForTarget(["completed"], { ...base, minSeverity: "major" }, facts)).toBe("completed");
    expect(eventForTarget(["completed"], { ...base, minSeverity: "critical" }, facts)).toBeNull();
  });
});

describe("notifyJob filters", () => {
  it("leaves targets without filters as they were", async () => {
    const hook = await target();
    const job = await finishedJob("completed", "pass", { bySeverity: {} });
    expect(await queued(hook.id, job.id)).toBe("completed");
  });

  it("tells a repository-scoped target only about its repositories", async () => {
    const scoped = await target({ repositoryIds: [api] });
    const onWeb = await finishedJob("completed", "pass");
    const onApi = await finishedJob("completed", "pass", { repositoryId: api });
    expect(await queued(scoped.id, onWeb.id)).toBeNull();
    expect(await queued(scoped.id, onApi.id)).toBe("completed");
  });

  it("needs a qualifying finding for a severity-scoped target, but not for failures", async () => {
    const serious = await target({ events: ["failed", "completed"], minSeverity: "major" });
    const minorOnly = await finishedJob("completed", "pass", { bySeverity: { minor: 3, info: 1 } });
    const withMajor = await finishedJob("completed", "pass", { bySeverity: { minor: 1, major: 1 } });
    const failed = await finishedJob("failed", "error");
    expect(await queued(serious.id, minorOnly.id)).toBeNull();
    expect(await queued(serious.id, withMajor.id)).toBe("completed");
    expect(await queued(serious.id, failed.id)).toBe("failed");
  });

  it("delivers to a verdict-change target only when the verdict changes", async () => {
    const changes = await target({ events: ["completed", "failed"], onlyVerdictChanges: true });
    const first = await finishedJob("completed", "pass");
    const same = await finishedJob("completed", "pass", { trigger: "webhook" });
    const failed = await finishedJob("failed", "error");
    // A failed run in between is not a verdict to compare against.
    const stillSame = await finishedJob("completed", "pass", { trigger: "comment" });
    const blocked = await finishedJob("completed", "blocked", { trigger: "webhook" });
    const otherChange = await finishedJob("completed", "pass", { number: 8 });

    expect(await queued(changes.id, first.id)).toBe("completed");
    expect(await queued(changes.id, same.id)).toBeNull();
    expect(await queued(changes.id, failed.id)).toBe("failed");
    expect(await queued(changes.id, stillSame.id)).toBeNull();
    expect(await queued(changes.id, blocked.id)).toBe("completed");
    // The first review of another change always counts.
    expect(await queued(changes.id, otherChange.id)).toBe("completed");
  });

  it("fires resolved when a blocked change is no longer blocked, whatever triggered either", async () => {
    const hook = await target({ events: ["blocked", "resolved", "completed"], minSeverity: "critical", onlyVerdictChanges: true });
    const blocked = await finishedJob("completed", "blocked", { trigger: "webhook", bySeverity: { critical: 1 } });
    await finishedJob("failed", "error");
    const fixed = await finishedJob("partial", "pass", { trigger: "comment", bySeverity: { minor: 1 } });
    const again = await finishedJob("completed", "pass", { trigger: "webhook" });

    expect(await queued(hook.id, blocked.id)).toBe("blocked");
    expect(await queued(hook.id, fixed.id)).toBe("resolved");
    expect(await queued(hook.id, again.id)).toBeNull();
  });

  it("names resolved in the webhook, Slack and email", async () => {
    const stub = fetchStub([
      { method: "POST", url: /hooks\.example\.com/ },
      { method: "POST", url: /hooks\.slack\.com/ },
    ]);
    vi.stubGlobal("fetch", stub.fetch);
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await target({ events: ["resolved"] });
    await prisma.notificationTarget.create({
      data: {
        workspaceId,
        kind: "slack",
        name: "slack",
        events: ["resolved"],
        encryptedUrl: encrypt("https://hooks.slack.com/services/T/B/X"),
      },
    });
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["resolved"], recipientIds: [userId] },
    });
    await finishedJob("completed", "blocked");
    const fixed = await finishedJob("completed", "pass");

    await notifyJob(fixed.id);
    for (const id of await claimDueDeliveries(100)) await runDelivery(id);

    const webhook = stub.calls.find((call) => call.url.includes("hooks.example.com"))!;
    expect(webhook.headers["x-sentryward-event"]).toBe("resolved");
    expect(JSON.parse(webhook.body!).event).toBe("resolved");
    const slack = stub.calls.find((call) => call.url.includes("hooks.slack.com"))!;
    expect(JSON.parse(slack.body!).text).toBe("Blocking issues resolved: acme/web#7");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Blocking issues resolved: acme/web#7 "Add login" - 1 finding' }),
    );
  });
});

describe("/api/notifications filters", () => {
  it("accepts filters on create and PATCH and returns them", async () => {
    const created = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({
        kind: "webhook",
        name: "CI",
        events: ["resolved", "blocked"],
        url: "https://hooks.example.com/sw",
        repositoryIds: [api, api],
        minSeverity: "major",
        onlyVerdictChanges: true,
      });
    expect(created.status).toBe(201);
    expect(created.body.target).toMatchObject({
      events: ["blocked", "resolved"],
      repositoryIds: [api],
      minSeverity: "major",
      onlyVerdictChanges: true,
    });

    const patched = await request(app)
      .patch(`/api/notifications/${created.body.target.id}`)
      .set("Cookie", cookie)
      .send({ repositoryIds: [], minSeverity: null, onlyVerdictChanges: false });
    expect(patched.status).toBe(200);
    expect(patched.body.target).toMatchObject({ repositoryIds: [], minSeverity: null, onlyVerdictChanges: false });
  });

  it("defaults to no filters", async () => {
    const created = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "webhook", name: "CI", events: ["completed"], url: "https://hooks.example.com/sw" });
    expect(created.body.target).toMatchObject({ repositoryIds: [], minSeverity: null, onlyVerdictChanges: false });
  });

  it("rejects another workspace's repositories and unknown severities", async () => {
    const { workspace: other } = await createUser("other@example.com");
    const otherConnection = await prisma.forgeConnection.create({
      data: { workspaceId: other.id, provider: "github", host: "github.com", kind: "github_app", installationId: "2", accountLogin: "other" },
    });
    const foreign = await prisma.repository.create({
      data: { connectionId: otherConnection.id, provider: "github", host: "github.com", fullPath: "other/x", externalId: "9", defaultBranch: "main" },
    });

    const res = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "webhook", name: "CI", events: ["completed"], url: "https://hooks.example.com/sw", repositoryIds: [web, foreign.id] });
    expect(res.status).toBe(400);
    expect(res.body.errors.repositoryIds).toBeDefined();

    const hook = await target();
    const patched = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ repositoryIds: [foreign.id] });
    expect(patched.status).toBe(400);
    expect(patched.body.errors.repositoryIds).toBeDefined();

    const badSeverity = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ minSeverity: "info" });
    expect(badSeverity.status).toBe(400);
  });
});

describe("deleting repositories", () => {
  it("drops a deleted repository from filters and pauses a target left with none", async () => {
    vi.stubGlobal("fetch", fetchStub([]).fetch);
    const both = await target({ repositoryIds: [web, api] });
    const webOnly = await target({ repositoryIds: [web], url: "https://hooks.example.com/web" });
    const all = await target({ url: "https://hooks.example.com/all" });
    const job = await finishedJob("completed", "pass", { repositoryId: api });
    await prisma.notificationDelivery.create({
      data: { targetId: webOnly.id, jobId: job.id, event: "completed", status: "pending", nextAttemptAt: new Date() },
    });

    const res = await request(app).delete(`/api/repos/${web}`).set("Cookie", cookie);
    expect(res.status).toBe(204);

    expect(await prisma.notificationTarget.findUniqueOrThrow({ where: { id: both.id } })).toMatchObject({
      repositoryIds: [api],
      active: true,
    });
    expect(await prisma.notificationTarget.findUniqueOrThrow({ where: { id: webOnly.id } })).toMatchObject({
      repositoryIds: [],
      active: false,
      pausedReason: SCOPE_REASON,
    });
    expect(await prisma.notificationTarget.findUniqueOrThrow({ where: { id: all.id } })).toMatchObject({ active: true });
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { targetId: webOnly.id } })).status).toBe("failed");

    const list = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(list.body.targets.find((t: { id: string }) => t.id === webOnly.id).pauseCause).toBe("scope");
  });

  it("drops a deleted connection's repositories too", async () => {
    vi.stubGlobal("fetch", fetchStub([]).fetch);
    const scoped = await target({ repositoryIds: [web, api] });

    const res = await request(app).delete(`/api/connections/${connectionId}`).set("Cookie", cookie);
    expect(res.status).toBe(204);
    expect(await prisma.notificationTarget.findUniqueOrThrow({ where: { id: scoped.id } })).toMatchObject({
      repositoryIds: [],
      active: false,
      pausedReason: SCOPE_REASON,
    });
  });

  it("keeps a scope-paused target off until repositories are saved", async () => {
    const hook = await target({ repositoryIds: [] });
    await prisma.notificationTarget.update({ where: { id: hook.id }, data: { active: false, pausedReason: SCOPE_REASON } });

    const resume = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: true });
    expect(resume.status).toBe(400);
    expect(resume.body.errors.repositoryIds).toBeDefined();

    // Switching it off again does not clear the reason either.
    const off = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: false });
    expect(off.body.target.pausedReason).toBe(SCOPE_REASON);

    const saved = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ repositoryIds: [api] });
    expect(saved.body.target).toMatchObject({ active: false, pausedReason: null, repositoryIds: [api] });

    const resumed = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: true });
    expect(resumed.status).toBe(200);
    expect(resumed.body.target.active).toBe(true);
  });
});
