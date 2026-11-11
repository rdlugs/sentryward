import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import type { ReviewStatus, ReviewVerdict } from "../src/generated/prisma/client.ts";
import { mailer } from "../src/lib/mailer.ts";
import { prisma } from "../src/lib/prisma.ts";
import { notifyJob } from "../src/services/notifications.ts";
import { claimDueDeliveries, runDelivery } from "../src/worker/deliveryQueue.ts";
import { addMember, createUser, inWorkspace } from "./helpers/users.ts";

let adminCookie: string;
let workspaceId: string;
let repositoryId: string;
let member: { id: string; cookie: string };
let header: [string, string];

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const admin = await createUser();
  adminCookie = admin.cookie;
  workspaceId = admin.workspace.id;
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", installationId: "1", accountLogin: "acme" },
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
  const created = await createUser("member@example.com");
  await addMember(workspaceId, created.user.id, "member");
  member = { id: created.user.id, cookie: created.cookie };
  header = inWorkspace(workspaceId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function linkIdentity(userId: string, providerUserId = "4242", host = "github.com") {
  return prisma.userIdentity.create({
    data: { userId, provider: "github", host, providerUserId, email: "member@example.com" },
  });
}

function finishedJob(status: ReviewStatus, verdict: ReviewVerdict | null, authorId: string | null = "4242") {
  return prisma.reviewJob.create({
    data: {
      repositoryId,
      number: 7,
      headSha: "aaa",
      trigger: "webhook",
      status,
      verdict,
      authorId,
      summary: {
        title: "Add login",
        webUrl: "https://github.com/acme/web/pull/7",
        total: 1,
        bySeverity: { major: 1 },
        byBucket: {},
        hasBlocking: verdict === "blocked",
        usageTotals: { calls: 1, inputTokens: 1, outputTokens: 1 },
      },
      finishedAt: new Date(),
    },
  });
}

function savePersonal(body: object, cookie = member.cookie) {
  return request(app).put("/api/notifications/personal").set("Cookie", cookie).set(...header).send(body);
}

async function notifyAndSend(jobId: string) {
  await notifyJob(jobId);
  for (const id of await claimDueDeliveries(100)) await runDelivery(id);
}

describe("/api/notifications/personal", () => {
  it("shows a member the defaults and which forge accounts they have linked", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const before = await request(app).get("/api/notifications/personal").set("Cookie", member.cookie).set(...header);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      enabled: false,
      events: ["failed", "blocked", "resolved"],
      pausedReason: null,
      forges: [{ provider: "github", host: "github.com", linked: false }],
      mailConfigured: true,
    });

    await linkIdentity(member.id);
    const after = await request(app).get("/api/notifications/personal").set("Cookie", member.cookie).set(...header);
    expect(after.body.forges).toEqual([{ provider: "github", host: "github.com", linked: true }]);
  });

  it("lets a member opt in and out without admin rights", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const on = await savePersonal({ enabled: true, events: ["blocked", "failed"] });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, events: ["failed", "blocked"] });
    const stored = await prisma.notificationTarget.findFirstOrThrow({ where: { membershipId: { not: null } } });
    expect(stored).toMatchObject({ kind: "email", recipientIds: [member.id], active: true, workspaceId });

    const off = await savePersonal({ enabled: false, events: ["blocked"] });
    expect(off.body).toMatchObject({ enabled: false, events: ["blocked"] });
    expect(await prisma.notificationTarget.count()).toBe(1);
  });

  it("needs mail configured to switch on, and at least one event", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(false);
    const noMail = await savePersonal({ enabled: true, events: ["blocked"] });
    expect(noMail.status).toBe(400);
    const noEvents = await savePersonal({ enabled: false, events: [] });
    expect(noEvents.status).toBe(400);
    expect(noEvents.body.errors.events).toBeDefined();
    expect(await prisma.notificationTarget.count()).toBe(0);
  });

  it("keeps personal targets out of the workspace's targets, even for admins", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    await savePersonal({ enabled: true, events: ["blocked"] });
    const personal = await prisma.notificationTarget.findFirstOrThrow();

    const list = await request(app).get("/api/notifications").set("Cookie", adminCookie);
    expect(list.body.targets).toEqual([]);
    for (const call of [
      request(app).get(`/api/notifications/${personal.id}/deliveries`),
      request(app).patch(`/api/notifications/${personal.id}`).send({ name: "x" }),
      request(app).post(`/api/notifications/${personal.id}/test`),
      request(app).delete(`/api/notifications/${personal.id}`),
    ]) {
      expect((await call.set("Cookie", adminCookie)).status).toBe(404);
    }
    expect(await prisma.notificationTarget.count()).toBe(1);
  });

  it("is deleted when the member leaves the workspace", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    await savePersonal({ enabled: true, events: ["blocked"] });
    await prisma.membership.deleteMany({ where: { userId: member.id, workspaceId } });
    expect(await prisma.notificationTarget.count()).toBe(0);
  });
});

describe("personal notification delivery", () => {
  beforeEach(() => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
  });

  it("emails a member about a review of a change they opened", async () => {
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await linkIdentity(member.id);
    await savePersonal({ enabled: true, events: ["blocked"] });
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: "member@example.com",
      subject: expect.stringContaining("Review blocked"),
    });
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { jobId: job.id } });
    expect(delivery).toMatchObject({ status: "sent", event: "blocked" });
  });

  it("sends nothing for someone else's change, an unlinked author, another host or a switched-off target", async () => {
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await savePersonal({ enabled: true, events: ["blocked", "completed"] });

    await notifyAndSend((await finishedJob("completed", "blocked")).id);
    await linkIdentity(member.id, "4242", "github.example.com");
    await notifyAndSend((await finishedJob("completed", "blocked")).id);
    await linkIdentity(member.id);
    await notifyAndSend((await finishedJob("completed", "blocked", "9999")).id);
    await notifyAndSend((await finishedJob("completed", "blocked", null)).id);
    await savePersonal({ enabled: false, events: ["blocked"] });
    await notifyAndSend((await finishedJob("completed", "blocked")).id);

    expect(send).not.toHaveBeenCalled();
    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it("only sends the events the member chose", async () => {
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await linkIdentity(member.id);
    await savePersonal({ enabled: true, events: ["failed"] });

    await notifyAndSend((await finishedJob("completed", "blocked")).id);
    expect(send).not.toHaveBeenCalled();
    await notifyAndSend((await finishedJob("failed", null)).id);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not email a member twice when a workspace email target already mails them the review", async () => {
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await linkIdentity(member.id);
    await savePersonal({ enabled: true, events: ["blocked"] });
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["blocked"], recipientIds: [member.id] },
    });
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    expect(send).toHaveBeenCalledTimes(1);
    const deliveries = await prisma.notificationDelivery.findMany({ include: { target: true } });
    expect(deliveries.map((delivery) => delivery.target.name)).toEqual(["Leads"]);
  });

  it("still emails the member when the workspace email target does not take that review", async () => {
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await linkIdentity(member.id);
    await savePersonal({ enabled: true, events: ["blocked"] });
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Failures", events: ["failed"], recipientIds: [member.id] },
    });

    await notifyAndSend((await finishedJob("completed", "blocked")).id);

    expect(send).toHaveBeenCalledTimes(1);
  });
});
