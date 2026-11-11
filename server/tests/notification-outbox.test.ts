import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import type { NotificationEvent, NotificationTarget, ReviewStatus, ReviewVerdict } from "../src/generated/prisma/client.ts";
import { DecryptError, encrypt } from "../src/lib/crypto.ts";
import { mailer } from "../src/lib/mailer.ts";
import { prisma } from "../src/lib/prisma.ts";
import {
  classifyFailure,
  deliver,
  DeliveryError,
  MAX_DELIVERY_ATTEMPTS,
  MISSED_NOTIFY_GRACE_MS,
  MISSED_NOTIFY_LOOKBACK_MS,
  notifyJob,
  parseRetryAfter,
  pauseCause,
  PermanentDeliveryError,
  queueMissedNotifications,
  retryDelayMs,
} from "../src/services/notifications.ts";
import {
  claimDueDeliveries,
  recoverStaleDeliveries,
  runDelivery,
  type RunDeliveryDeps,
} from "../src/worker/deliveryQueue.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { addMember, createUser, inWorkspace } from "./helpers/users.ts";

let cookie: string;
let workspaceId: string;
let repositoryId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  ({ cookie, workspace: { id: workspaceId } } = await createUser());
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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

let jobNumber = 0;
function finishedJob(status: ReviewStatus = "failed", verdict: ReviewVerdict | null = "error") {
  return prisma.reviewJob.create({
    data: {
      repositoryId,
      number: ++jobNumber,
      headSha: "aaa",
      trigger: "manual",
      status,
      verdict,
      error: status === "failed" ? "boom" : null,
      finishedAt: new Date(),
    },
  });
}

function target(
  kind: "webhook" | "slack" = "webhook",
  url = "https://hooks.example.com/sw",
  events: NotificationEvent[] = ["failed", "completed"],
) {
  return prisma.notificationTarget.create({
    data: {
      workspaceId,
      kind,
      name: `${kind} target`,
      events,
      encryptedUrl: encrypt(url),
      encryptedSecret: kind === "webhook" ? encrypt("shh") : null,
    },
  });
}

function failWith(err: unknown): RunDeliveryDeps {
  return {
    deliver: vi.fn(async () => {
      throw err;
    }),
    now: () => new Date(),
  };
}

const succeed = (): RunDeliveryDeps => ({ deliver: vi.fn(async () => {}), now: () => new Date() });

// Sends whatever is due now, as one worker poll would.
async function sendDue(deps?: RunDeliveryDeps) {
  const ids = await claimDueDeliveries(100);
  for (const id of ids) await runDelivery(id, deps);
  return ids;
}

// Pending rows waiting on a backoff become due at once.
function makeDue() {
  return prisma.notificationDelivery.updateMany({
    where: { status: "pending" },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },
  });
}

// One finished job delivered to its targets, failing or not.
async function deliverJob(deps: RunDeliveryDeps) {
  const job = await finishedJob();
  await notifyJob(job.id);
  await sendDue(deps);
  return job;
}

function reload(t: NotificationTarget) {
  return prisma.notificationTarget.findUniqueOrThrow({ where: { id: t.id } });
}

function onlyDelivery() {
  return prisma.notificationDelivery.findFirstOrThrow();
}

describe("retry policy", () => {
  it.each([
    [new DeliveryError(500), "webhook", "retryable"],
    [new DeliveryError(503), "slack", "retryable"],
    [new DeliveryError(408), "webhook", "retryable"],
    [new DeliveryError(429), "webhook", "retryable"],
    [new DeliveryError(400), "webhook", "permanent"],
    [new DeliveryError(401), "slack", "permanent"],
    [new DeliveryError(404), "webhook", "permanent"],
    [new DeliveryError(404), "slack", "gone"],
    [new DeliveryError(410), "webhook", "gone"],
    [new PermanentDeliveryError("Mail is not configured"), "email", "permanent"],
    [new DecryptError(), "slack", "permanent"],
    [new Error("getaddrinfo ENOTFOUND"), "webhook", "retryable"],
    [new DOMException("The operation was aborted due to timeout", "TimeoutError"), "webhook", "retryable"],
  ] as const)("classifies %s for a %s target as %s", (err, kind, expected) => {
    expect(classifyFailure(err, kind)).toBe(expected);
  });

  it("backs off 1m, 5m, 30m then 2h, or as long as a 429 asks", () => {
    const err = new Error("timeout");
    expect([1, 2, 3, 4].map((attempts) => retryDelayMs(attempts, err))).toEqual([60_000, 300_000, 1_800_000, 7_200_000]);
    expect(retryDelayMs(1, new DeliveryError(429, 90_000))).toBe(90_000);
    expect(retryDelayMs(2, new DeliveryError(429, null))).toBe(300_000);
  });

  it("reads Retry-After as seconds or a date, within bounds", () => {
    const now = new Date("2026-11-10T00:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Tue, 10 Nov 2026 00:05:00 GMT", now)).toBe(300_000);
    expect(parseRetryAfter("Mon, 09 Nov 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("999999", now)).toBe(6 * 60 * 60_000);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("delivery outbox", () => {
  it("schedules a retry after a transient failure, keeping why", async () => {
    await target();
    // Real clock, not a pinned date: claimDueDeliveries compares against the
    // database's now(), so a fixed date turns the retry due once it passes.
    const now = new Date();
    const job = await finishedJob();
    await notifyJob(job.id);

    await sendDue({ ...failWith(new DeliveryError(503)), now: () => now });

    expect(await onlyDelivery()).toMatchObject({
      status: "pending",
      attempts: 1,
      httpStatus: 503,
      lockedAt: null,
      finishedAt: null,
      nextAttemptAt: new Date(now.getTime() + 60_000),
    });
    // Not due yet, so nothing is claimed.
    expect(await claimDueDeliveries(10)).toEqual([]);
  });

  it("honours Retry-After on a 429", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStub([{ method: "POST", url: /hooks\.example\.com/, status: 429, headers: { "Retry-After": "120" } }]).fetch,
    );
    await target();
    const job = await finishedJob();
    await notifyJob(job.id);
    const before = Date.now();

    await sendDue();

    const row = await onlyDelivery();
    expect(row).toMatchObject({ status: "pending", httpStatus: 429 });
    expect(row.nextAttemptAt!.getTime() - before).toBeGreaterThanOrEqual(120_000);
    expect(row.nextAttemptAt!.getTime() - before).toBeLessThan(130_000);
  });

  it("gives up after the last attempt and counts it against the target", async () => {
    const hook = await target();
    const job = await finishedJob();
    await notifyJob(job.id);
    const deps = failWith(new DeliveryError(502));

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      await makeDue();
      expect(await sendDue(deps)).toHaveLength(1);
    }

    expect(deps.deliver).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
    expect(await onlyDelivery()).toMatchObject({
      status: "failed",
      attempts: MAX_DELIVERY_ATTEMPTS,
      httpStatus: 502,
      nextAttemptAt: null,
      lockedAt: null,
      payload: null,
      finishedAt: expect.any(Date),
    });
    await makeDue();
    expect(await claimDueDeliveries(10)).toEqual([]);
    expect((await reload(hook)).consecutiveFailures).toBe(1);
  });

  it("does not retry a refusal", async () => {
    const hook = await target();
    const deps = failWith(new DeliveryError(400));

    await deliverJob(deps);

    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(await onlyDelivery()).toMatchObject({ status: "failed", attempts: 1, httpStatus: 400 });
    expect((await reload(hook)).consecutiveFailures).toBe(1);
  });

  it("sends the payload it queued, even once the job is gone", async () => {
    await target();
    const job = await finishedJob();
    await notifyJob(job.id);
    await prisma.reviewJob.delete({ where: { id: job.id } });
    const deps = succeed();

    await sendDue(deps);

    expect(deps.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "webhook" }),
      workspaceId,
      expect.objectContaining({ event: "failed", review: expect.objectContaining({ id: job.id }) }),
    );
    expect(await onlyDelivery()).toMatchObject({ status: "sent", payload: null, finishedAt: expect.any(Date) });
  });

  it("never claims one row twice when workers poll at once", async () => {
    for (let i = 0; i < 6; i++) await target("webhook", `https://hooks.example.com/${i}`);
    const job = await finishedJob();
    await notifyJob(job.id);

    const [a, b] = await Promise.all([claimDueDeliveries(6), claimDueDeliveries(6)]);

    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect(new Set([...a, ...b]).size).toBe(6);
    expect(await prisma.notificationDelivery.findMany({ select: { attempts: true } })).toEqual(
      Array(6).fill({ attempts: 1 }),
    );
  });

  it("sends a delivery whose worker died mid-send", async () => {
    await target();
    const job = await finishedJob();
    await notifyJob(job.id);
    // A worker claims it and dies before finishing.
    const [id] = await claimDueDeliveries(10);
    expect(await recoverStaleDeliveries()).toBe(0);
    await prisma.notificationDelivery.update({ where: { id }, data: { lockedAt: new Date(Date.now() - 10 * 60_000) } });

    expect(await recoverStaleDeliveries()).toBe(1);
    const deps = succeed();
    expect(await sendDue(deps)).toEqual([id]);

    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(await onlyDelivery()).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("fails a delivery whose last attempt's worker died, without counting it against the target", async () => {
    const hook = await target();
    const job = await finishedJob();
    await notifyJob(job.id);
    await prisma.notificationDelivery.updateMany({
      data: { attempts: MAX_DELIVERY_ATTEMPTS, lockedAt: new Date(Date.now() - 10 * 60_000) },
    });

    expect(await recoverStaleDeliveries()).toBe(1);

    expect(await onlyDelivery()).toMatchObject({
      status: "failed",
      error: "Worker stopped responding",
      payload: null,
      finishedAt: expect.any(Date),
    });
    expect((await reload(hook)).consecutiveFailures).toBe(0);
  });

  it("keeps queued deliveries of a stamped job through a restart", async () => {
    await target();
    const job = await finishedJob();
    // The worker that finished the job stops here; a new one starts polling.
    await notifyJob(job.id);
    await notifyJob(job.id);

    const deps = succeed();
    expect(await sendDue(deps)).toHaveLength(1);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("never sends a row again once it is sent", async () => {
    await target();
    await deliverJob(succeed());
    const row = await onlyDelivery();
    const deps = succeed();

    await runDelivery(row.id, deps);
    await makeDue();
    expect(await sendDue(deps)).toEqual([]);

    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("leaves a row alone when its claim was taken over mid-send", async () => {
    await target();
    const job = await finishedJob();
    await notifyJob(job.id);
    const [id] = await claimDueDeliveries(10);
    const deps: RunDeliveryDeps = {
      // Stale recovery and another worker's claim land while this send runs.
      deliver: vi.fn(async () => {
        await prisma.notificationDelivery.update({ where: { id }, data: { lockedAt: new Date(Date.now() + 5000) } });
      }),
      now: () => new Date(),
    };

    await runDelivery(id!, deps);

    expect(await onlyDelivery()).toMatchObject({ status: "pending", finishedAt: null });
  });

  it("drops a delivery queued for a target paused before it was sent, without counting it", async () => {
    const hook = await target();
    const job = await finishedJob();
    await notifyJob(job.id);
    await prisma.notificationTarget.update({ where: { id: hook.id }, data: { active: false } });
    const deps = succeed();

    await sendDue(deps);

    expect(deps.deliver).not.toHaveBeenCalled();
    expect(await onlyDelivery()).toMatchObject({ status: "failed", error: "Target was paused before this could be sent" });
    expect((await reload(hook)).consecutiveFailures).toBe(0);
  });

  it("drops queued deliveries when an admin pauses, so a resume does not send them", async () => {
    const hook = await target();
    await deliverJob(failWith(new DeliveryError(503)));
    expect(await onlyDelivery()).toMatchObject({ status: "pending", attempts: 1 });

    await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: false }).expect(200);
    await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: true }).expect(200);
    await makeDue();
    const deps = succeed();
    await sendDue(deps);

    expect(deps.deliver).not.toHaveBeenCalled();
    expect(await onlyDelivery()).toMatchObject({
      status: "failed",
      error: "Target was paused before this could be sent",
      httpStatus: null,
      nextAttemptAt: null,
      payload: null,
      finishedAt: expect.any(Date),
    });
  });

  it("leaves queued deliveries alone when an admin edits an active target", async () => {
    const hook = await target();
    await notifyJob((await finishedJob()).id);

    await request(app)
      .patch(`/api/notifications/${hook.id}`)
      .set("Cookie", cookie)
      .send({ name: "Renamed" })
      .expect(200);

    expect(await onlyDelivery()).toMatchObject({ status: "pending" });
  });

  it("does not reschedule a retry when the target was paused while it was sending", async () => {
    const hook = await target();
    await notifyJob((await finishedJob()).id);
    const deps: RunDeliveryDeps = {
      deliver: vi.fn(async () => {
        await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: false });
        await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: true });
        // Only the pause matters; the resume above shows it is not undone.
        await prisma.notificationTarget.update({ where: { id: hook.id }, data: { active: false } });
        throw new DeliveryError(503);
      }),
      now: () => new Date(),
    };

    await sendDue(deps);

    expect(await onlyDelivery()).toMatchObject({
      status: "failed",
      httpStatus: 503,
      nextAttemptAt: null,
      lockedAt: null,
    });
    expect((await reload(hook)).consecutiveFailures).toBe(0);
  });

  it("retries an email nobody received, but not one some recipients got", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const { user: other } = await createUser("other@example.com");
    await addMember(workspaceId, other.id, "member");
    const owner = await prisma.membership.findFirstOrThrow({ where: { workspaceId, role: "owner" } });
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["failed"], recipientIds: [owner.userId, other.id] },
    });
    const send = vi.spyOn(mailer, "send");

    send.mockRejectedValue(new Error("SMTP down"));
    await deliverJob({ deliver, now: () => new Date() });
    expect(await onlyDelivery()).toMatchObject({ status: "pending", error: "2 of 2 emails could not be sent" });

    send.mockReset();
    send.mockResolvedValueOnce().mockRejectedValueOnce(new Error("mailbox full"));
    await makeDue();
    await sendDue();
    expect(await onlyDelivery()).toMatchObject({ status: "failed", error: "1 of 2 emails could not be sent" });
  });
});

describe("auto-pause", () => {
  async function setLimit(limit: number) {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { notifyAutoPauseAfter: limit } });
  }

  it("pauses a target after the workspace's number of failures in a row", async () => {
    await setLimit(2);
    const hook = await target();
    const deps = failWith(new DeliveryError(400));

    await deliverJob(deps);
    expect(await reload(hook)).toMatchObject({ active: true, consecutiveFailures: 1, pausedReason: null });

    await deliverJob(deps);
    expect(await reload(hook)).toMatchObject({
      active: false,
      consecutiveFailures: 2,
      pausedReason: "Auto-paused after 2 failed deliveries in a row (last: HTTP 400)",
    });

    // Paused, so the next job is not even queued for it.
    await deliverJob(deps);
    expect(deps.deliver).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["slack", 404, "Auto-paused: HTTP 404 Not Found"],
    ["webhook", 410, "Auto-paused: HTTP 410 Gone"],
    ["slack", 410, "Auto-paused: HTTP 410 Gone"],
  ] as const)("pauses a %s target at once when it answers %i", async (kind, status, reason) => {
    const hook = await target(kind);

    await deliverJob(failWith(new DeliveryError(status)));

    expect(await reload(hook)).toMatchObject({ active: false, consecutiveFailures: 1, pausedReason: reason });
  });

  it("drops a paused target's other queued deliveries", async () => {
    const hook = await target("slack");
    await notifyJob((await finishedJob()).id);
    await notifyJob((await finishedJob()).id);

    const [first] = await claimDueDeliveries(1);
    await runDelivery(first!, failWith(new DeliveryError(410)));
    expect((await reload(hook)).active).toBe(false);

    const rows = await prisma.notificationDelivery.findMany({ orderBy: { attempts: "desc" } });
    expect(rows.map((row) => [row.status, row.attempts, row.httpStatus, row.error])).toEqual([
      ["failed", 1, 410, null],
      ["failed", 0, null, "Target was paused before this could be sent"],
    ]);
  });

  it("counts a webhook's 404 like any refusal", async () => {
    const hook = await target("webhook");

    await deliverJob(failWith(new DeliveryError(404)));

    expect(await reload(hook)).toMatchObject({ active: true, consecutiveFailures: 1 });
  });

  it("starts the count again after a success", async () => {
    const hook = await target();
    await prisma.notificationTarget.update({ where: { id: hook.id }, data: { consecutiveFailures: 4 } });

    await deliverJob(succeed());

    expect((await reload(hook)).consecutiveFailures).toBe(0);
  });

  it("never pauses when the limit is 0", async () => {
    await setLimit(0);
    const hook = await target("slack");

    for (let i = 0; i < 6; i++) await deliverJob(failWith(new DeliveryError(i === 0 ? 410 : 400)));

    expect(await reload(hook)).toMatchObject({ active: true, consecutiveFailures: 6, pausedReason: null });
  });

  it("does not count failed tests, but a passing test resets the count", async () => {
    const hook = await target("slack");
    await prisma.notificationTarget.update({ where: { id: hook.id }, data: { consecutiveFailures: 4 } });

    vi.stubGlobal("fetch", fetchStub([{ method: "POST", url: /hooks\.example\.com/, status: 410 }]).fetch);
    await request(app).post(`/api/notifications/${hook.id}/test`).set("Cookie", cookie).expect(200);
    expect(await reload(hook)).toMatchObject({ active: true, consecutiveFailures: 4 });

    vi.stubGlobal("fetch", fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]).fetch);
    await request(app).post(`/api/notifications/${hook.id}/test`).set("Cookie", cookie).expect(200);
    expect((await reload(hook)).consecutiveFailures).toBe(0);
  });

  it("clears the reason and the count when an admin switches the target", async () => {
    const hook = await target("slack");
    await deliverJob(failWith(new DeliveryError(410)));

    const list = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(list.body.targets[0]).toMatchObject({
      active: false,
      pausedReason: "Auto-paused: HTTP 410 Gone",
      pauseCause: "gone",
    });

    const res = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: true });

    expect(res.body.target).toMatchObject({ active: true, pausedReason: null, pauseCause: null });
    expect((await reload(hook)).consecutiveFailures).toBe(0);
  });

  it("keeps the reason when only the name changes", async () => {
    const hook = await target("slack");
    await deliverJob(failWith(new DeliveryError(410)));

    const res = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ name: "Old hook" });

    expect(res.body.target).toMatchObject({ active: false, pausedReason: "Auto-paused: HTTP 410 Gone" });
  });

  it("emails the workspace's owners and admins once when it pauses a target", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    const { user: admin } = await createUser("admin@example.com");
    const { user: member } = await createUser("member@example.com");
    await addMember(workspaceId, admin.id, "admin");
    await addMember(workspaceId, member.id, "member");
    for (let i = 0; i < 2; i++) await target("slack", `https://hooks.example.com/${i}`);

    // Both targets are gone; each is paused, and each pause is told once.
    await deliverJob(failWith(new DeliveryError(410)));

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.map(([mail]) => mail.to).sort()).toEqual([
      "admin@example.com",
      "admin@example.com",
      "dev@example.com",
      "dev@example.com",
    ]);
    expect(send).toHaveBeenCalledWith({
      to: "dev@example.com",
      subject: 'Notification target "slack target" was paused in Dev',
      text: expect.stringContaining(`Auto-paused: HTTP 410 Gone.\n\n`),
    });
    expect(send.mock.calls[0]![0].text).toContain(`${env.CLIENT_ORIGIN}/notifications?tab=failing`);
  });

  it("pauses and emails only once when two failures land together", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await setLimit(1);
    const hook = await target();
    for (let i = 0; i < 2; i++) await notifyJob((await finishedJob()).id);
    const deps = failWith(new DeliveryError(400));

    await Promise.all((await claimDueDeliveries(10)).map((id) => runDelivery(id, deps)));

    expect(await reload(hook)).toMatchObject({ active: false, consecutiveFailures: 2 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("pauseCause", () => {
  it.each([
    [null, null],
    ["Auto-paused: HTTP 410 Gone", "gone"],
    ["Auto-paused: HTTP 404 Not Found", "gone"],
    ["Auto-paused after 5 failed deliveries in a row (last: HTTP 503)", "failures"],
    ["Paused by an older version", "failures"],
  ] as const)("reads %j as %j", (reason, cause) => {
    expect(pauseCause(reason)).toBe(cause);
  });
});

describe("/api/notifications/settings", () => {
  it("returns the workspace's limit with the targets", async () => {
    const res = await request(app).get("/api/notifications").set("Cookie", cookie);

    expect(res.body.settings).toEqual({ autoPauseAfter: 5 });
  });

  it("lets an admin change it", async () => {
    const res = await request(app).patch("/api/notifications/settings").set("Cookie", cookie).send({ autoPauseAfter: 0 });

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ autoPauseAfter: 0 });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).notifyAutoPauseAfter).toBe(0);
  });

  it.each([-1, 51, 2.5, "3"])("rejects %j", async (autoPauseAfter) => {
    const res = await request(app).patch("/api/notifications/settings").set("Cookie", cookie).send({ autoPauseAfter });

    expect(res.status).toBe(400);
    expect(res.body.errors.autoPauseAfter).toBeDefined();
  });

  it("is for admins only", async () => {
    const { user: member, cookie: memberCookie } = await createUser("member@example.com");
    await addMember(workspaceId, member.id, "member");

    const res = await request(app)
      .patch("/api/notifications/settings")
      .set("Cookie", memberCookie)
      .set(...inWorkspace(workspaceId))
      .send({ autoPauseAfter: 1 });

    expect(res.status).toBe(403);
  });
});

describe("queueMissedNotifications", () => {
  async function finishedAgo(ms: number, status: ReviewStatus = "failed") {
    const job = await finishedJob(status, status === "failed" ? "error" : null);
    return prisma.reviewJob.update({ where: { id: job.id }, data: { finishedAt: new Date(Date.now() - ms) } });
  }

  it("queues deliveries for a finished job nothing queued them for", async () => {
    await target();
    const job = await finishedAgo(MISSED_NOTIFY_GRACE_MS + 60_000);

    expect(await queueMissedNotifications()).toBe(1);

    expect(await onlyDelivery()).toMatchObject({ jobId: job.id, status: "pending" });
    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).notifiedAt).not.toBeNull();
    // Stamped, so the next sweep leaves it alone.
    expect(await queueMissedNotifications()).toBe(0);
  });

  it("leaves jobs still in the grace period, too old, already notified or never notified", async () => {
    await target();
    await finishedAgo(1000);
    await finishedAgo(MISSED_NOTIFY_LOOKBACK_MS + 60_000);
    await finishedAgo(MISSED_NOTIFY_GRACE_MS + 60_000, "cancelled");
    const notified = await finishedAgo(MISSED_NOTIFY_GRACE_MS + 60_000);
    await prisma.reviewJob.update({ where: { id: notified.id }, data: { notifiedAt: new Date() } });

    expect(await queueMissedNotifications()).toBe(0);
    expect(await prisma.notificationDelivery.count()).toBe(0);
  });
});

describe("pending deliveries on the target list", () => {
  it("reports a retry still queued behind a newer delivery that went through", async () => {
    const hook = await target();
    await deliverJob(failWith(new DeliveryError(503)));
    await prisma.notificationDelivery.create({
      data: {
        targetId: hook.id,
        event: "test",
        status: "sent",
        attempts: 1,
        createdAt: new Date(Date.now() + 1000),
        finishedAt: new Date(),
      },
    });
    const queued = await onlyPending();

    const res = await request(app).get("/api/notifications").set("Cookie", cookie).expect(200);

    expect(res.body.targets[0].lastDelivery).toMatchObject({ status: "sent", event: "test" });
    expect(res.body.targets[0].pending).toEqual({
      count: 1,
      retry: { attempts: 1, httpStatus: 503, error: null, nextAttemptAt: queued.nextAttemptAt!.toISOString() },
    });
  });

  it("counts untried rows without a retry, and is empty when nothing is queued", async () => {
    const hook = await target();
    const quiet = await target("slack");
    await notifyJob((await finishedJob()).id);
    await prisma.notificationDelivery.deleteMany({ where: { targetId: quiet.id } });

    const res = await request(app).get("/api/notifications").set("Cookie", cookie).expect(200);
    const byId = Object.fromEntries(res.body.targets.map((t: { id: string }) => [t.id, t]));

    expect(byId[hook.id].pending).toEqual({ count: 1, retry: null });
    expect(byId[quiet.id].pending).toEqual({ count: 0, retry: null });
  });

  function onlyPending() {
    return prisma.notificationDelivery.findFirstOrThrow({ where: { status: "pending" } });
  }
});
