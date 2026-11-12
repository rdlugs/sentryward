import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import type { NotificationEvent, ReviewStatus, ReviewVerdict } from "../src/generated/prisma/client.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { mailer } from "../src/lib/mailer.ts";
import { prisma } from "../src/lib/prisma.ts";
import { isValidTimeZone, nextDigestAt } from "../src/services/digestSchedule.ts";
import {
  deliver,
  DIGEST_BLOCKED_LIMIT,
  type DigestPayload,
  digestPayloadFor,
  DIGEST_REVIEW_LIMIT,
  notifyJob,
  type NotificationPayload,
  payloadFor,
} from "../src/services/notifications.ts";
import { claimDueDeliveries, runDelivery } from "../src/worker/deliveryQueue.ts";
import { DIGEST_RETRY_MS, runDueDigests } from "../src/worker/digests.ts";
import { pruneDeliveries } from "../src/worker/retention.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { createUser, inWorkspace } from "./helpers/users.ts";

let cookie: string;
let workspaceId: string;
let repositoryId: string;
let otherRepositoryId: string;

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
  const repo = (fullPath: string, externalId: string) =>
    prisma.repository.create({
      data: {
        connectionId: connection.id,
        provider: "github",
        host: "github.com",
        fullPath,
        externalId,
        defaultBranch: "main",
        enabled: true,
      },
    });
  repositoryId = (await repo("acme/web", "100")).id;
  otherRepositoryId = (await repo("acme/api", "101")).id;
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
function finishedJob(
  status: ReviewStatus,
  verdict: ReviewVerdict | null,
  { repo = repositoryId, number = ++jobNumber, finishedAt = new Date() } = {},
) {
  return prisma.reviewJob.create({
    data: {
      repositoryId: repo,
      number,
      headSha: "aaa",
      trigger: "manual",
      status,
      verdict,
      error: status === "failed" ? "boom" : null,
      summary:
        status === "failed"
          ? undefined
          : { title: `Change ${number}`, webUrl: `https://github.com/acme/pr/${number}`, total: 1, bySeverity: { major: 1 } },
      finishedAt,
    },
  });
}

async function finish(status: ReviewStatus, verdict: ReviewVerdict | null, options = {}) {
  const job = await finishedJob(status, verdict, options);
  await notifyJob(job.id);
  return job;
}

const PAST = new Date(Date.now() - 60_000);
// Scheduled but not due yet, so held reviews stay held.
const FUTURE = new Date(Date.now() + 60 * 60_000);

function digestTarget({
  kind = "webhook" as "webhook" | "slack",
  events = ["failed", "blocked", "resolved", "completed"] as NotificationEvent[],
  dueAt = PAST as Date | null,
} = {}) {
  return prisma.notificationTarget.create({
    data: {
      workspaceId,
      kind,
      name: "Digest",
      events,
      encryptedUrl: encrypt(kind === "slack" ? "https://hooks.slack.com/services/T/B/x" : "https://hooks.example.com/sw"),
      encryptedSecret: kind === "webhook" ? encrypt("shh") : null,
      deliveryMode: "daily",
      digestHour: 9,
      digestTimeZone: "Europe/Berlin",
      digestSince: new Date(Date.now() - 24 * 60 * 60_000),
      digestDueAt: dueAt,
    },
  });
}

function rows(status?: "held" | "pending") {
  return prisma.notificationDelivery.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "asc" } });
}

describe("digest schedule", () => {
  it("is the next hour:00 in the target's timezone", () => {
    const schedule = { deliveryMode: "daily", digestHour: 9, digestWeekday: null, digestTimeZone: "Europe/Berlin" } as const;
    // 08:30 Berlin (CET, +1) is before 9:00 the same day.
    expect(nextDigestAt(schedule, new Date("2026-11-10T07:30:00Z"))).toEqual(new Date("2026-11-10T08:00:00Z"));
    // Exactly at 9:00 the next one is tomorrow.
    expect(nextDigestAt(schedule, new Date("2026-11-10T08:00:00Z"))).toEqual(new Date("2026-11-11T08:00:00Z"));
    // Summer time (+2).
    expect(nextDigestAt(schedule, new Date("2026-07-01T00:00:00Z"))).toEqual(new Date("2026-07-01T07:00:00Z"));
    // A zone ahead of UTC whose local date is already tomorrow.
    expect(
      nextDigestAt({ ...schedule, digestTimeZone: "Asia/Manila" }, new Date("2026-11-10T20:00:00Z")),
    ).toEqual(new Date("2026-11-11T01:00:00Z"));
  });

  it("is weekly on the chosen weekday", () => {
    // 2026-11-10 is a Tuesday; Monday 9:00 New York (EST, -5) is the 16th.
    const schedule = { deliveryMode: "weekly", digestHour: 9, digestWeekday: 1, digestTimeZone: "America/New_York" } as const;
    expect(nextDigestAt(schedule, new Date("2026-11-10T12:00:00Z"))).toEqual(new Date("2026-11-16T14:00:00Z"));
    expect(nextDigestAt(schedule, new Date("2026-11-16T14:00:00Z"))).toEqual(new Date("2026-11-23T14:00:00Z"));
  });

  it("moves an hour skipped by DST to the instant the clocks jump to", () => {
    // Berlin skips 02:00-03:00 on 2026-03-29 (01:00Z).
    const schedule = { deliveryMode: "daily", digestHour: 2, digestWeekday: null, digestTimeZone: "Europe/Berlin" } as const;
    expect(nextDigestAt(schedule, new Date("2026-03-28T23:00:00Z"))).toEqual(new Date("2026-03-29T01:00:00Z"));
  });

  it("is null for a target sending each review", () => {
    expect(
      nextDigestAt({ deliveryMode: "each", digestHour: 9, digestWeekday: null, digestTimeZone: "UTC" }, new Date()),
    ).toBeNull();
  });

  it("knows real timezones", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("falls back to UTC for a stored zone this runtime does not know", () => {
    const schedule = { deliveryMode: "daily", digestHour: 9, digestWeekday: null, digestTimeZone: "Mars/Olympus" } as const;
    expect(nextDigestAt(schedule, new Date("2026-11-10T07:30:00Z"))).toEqual(new Date("2026-11-10T09:00:00Z"));
  });
});

describe("holding reviews", () => {
  it("holds a digest target's deliveries instead of queueing them", async () => {
    await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    expect(await rows()).toMatchObject([{ status: "held", event: "blocked", nextAttemptAt: null }]);
    expect(await claimDueDeliveries(10)).toEqual([]);
  });

  it("sends each review on its own when a digest target has no due time", async () => {
    // A schedule left incomplete outside the API: nothing would ever build
    // its digest, so holding would pile up rows nothing sends.
    await digestTarget({ dueAt: null });
    await finish("completed", "blocked");
    expect(await rows()).toMatchObject([{ status: "pending", event: "blocked" }]);
  });

  it("applies the target's events and filters before holding", async () => {
    const target = await digestTarget({ events: ["blocked"], dueAt: FUTURE });
    await prisma.notificationTarget.update({
      where: { id: target.id },
      data: { repositoryIds: [repositoryId], minSeverity: "critical" },
    });
    await finish("completed", "pass");
    await finish("completed", "blocked", { repo: otherRepositoryId });
    await finish("completed", "blocked"); // only a major finding
    expect(await rows()).toEqual([]);
  });
});

describe("building digests", () => {
  it("rolls held reviews into one pending digest and deletes them", async () => {
    const target = await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked", { number: 1 });
    await finish("completed", "blocked", { number: 2, repo: otherRepositoryId });
    await finish("completed", "pass", { number: 1 });
    await finish("failed", null);
    await prisma.notificationTarget.update({ where: { id: target.id }, data: { digestDueAt: PAST } });

    const now = new Date();
    expect(await runDueDigests(now)).toBe(1);

    const [digest] = await rows();
    expect(await rows("held")).toEqual([]);
    expect(digest).toMatchObject({ event: "digest", status: "pending", jobId: null });
    const payload = digest!.payload as unknown as DigestPayload;
    expect(payload).toMatchObject({
      event: "digest",
      schedule: "daily",
      period: { to: now.toISOString(), timeZone: "Europe/Berlin" },
      counts: { reviews: 4, failed: 1, resolved: 1, byVerdict: { pass: 1, blocked: 2, error: 0 } },
      truncated: 0,
    });
    // acme/web#1 was blocked, then passed: only acme/api#2 is still blocked.
    expect(payload.blocked.map((review) => `${review.repository.fullPath}#${review.change.number}`)).toEqual([
      "acme/api#2",
    ]);
    expect(payload.topBlockedRepositories).toEqual([
      { provider: "github", fullPath: "acme/api", blocked: 1 },
      { provider: "github", fullPath: "acme/web", blocked: 1 },
    ]);
    expect(payload.reviews.map((review) => review.event)).toEqual(["blocked", "blocked", "failed", "resolved"]);

    const updated = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.digestSince).toEqual(now);
    expect(updated.digestDueAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("sends nothing for an empty period but moves the schedule on", async () => {
    const target = await digestTarget();
    expect(await runDueDigests()).toBe(0);
    expect(await rows()).toEqual([]);
    const updated = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.digestDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("never builds the same digest twice", async () => {
    await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    await prisma.notificationTarget.updateMany({ data: { digestDueAt: PAST } });

    const results = await Promise.all([runDueDigests(), runDueDigests()]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await runDueDigests()).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it("catches up after the worker was down at the due time", async () => {
    await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    await prisma.notificationTarget.updateMany({ data: { digestDueAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) } });
    expect(await runDueDigests()).toBe(1);
  });

  it("caps the lists but counts every review", () => {
    const sample = payloadFor(
      { id: "j", number: 1, status: "completed", verdict: "pass", error: null, summary: null, headSha: "abc", trigger: "manual" },
      { provider: "github", fullPath: "acme/web" },
      "completed",
    );
    const held: NotificationPayload[] = Array.from({ length: DIGEST_REVIEW_LIMIT + 5 }, () => sample);
    const payload = digestPayloadFor(held, { from: new Date(), to: new Date(), timeZone: "UTC", schedule: "weekly" });
    expect(payload.counts.reviews).toBe(DIGEST_REVIEW_LIMIT + 5);
    expect(payload.reviews).toHaveLength(DIGEST_REVIEW_LIMIT);
    expect(payload.truncated).toBe(5);
  });

  it("caps the blocked list on its own and counts what it leaves out", async () => {
    const target = await digestTarget({ dueAt: PAST });
    const createdAt = new Date(Date.now() - 60_000);
    // No job behind them (as after retention), so each stays as held.
    await prisma.notificationDelivery.createMany({
      data: Array.from({ length: DIGEST_BLOCKED_LIMIT + 3 }, (_, index) => ({
        targetId: target.id,
        event: "blocked" as const,
        status: "held" as const,
        attempts: 0,
        payload: payloadFor(
          { id: `j${index}`, number: index + 1, status: "completed", verdict: "blocked", error: null, summary: null, headSha: "abc", trigger: "manual" },
          { provider: "github", fullPath: "acme/web" },
          "blocked",
        ) as unknown as object,
        createdAt,
      })),
    });
    expect(await runDueDigests()).toBe(1);
    const payload = (await rows())[0]!.payload as unknown as DigestPayload;
    expect(payload.blocked).toHaveLength(DIGEST_BLOCKED_LIMIT);
    expect(payload.blockedTruncated).toBe(3);
  });

  it("keeps room for failed reviews however many were blocked", () => {
    const blocked = payloadFor(
      { id: "b", number: 1, status: "completed", verdict: "blocked", error: null, summary: null, headSha: "abc", trigger: "manual" },
      { provider: "github", fullPath: "acme/web" },
      "blocked",
    );
    const failed = payloadFor(
      { id: "f", number: 2, status: "failed", verdict: null, error: "boom", summary: null, headSha: "abc", trigger: "manual" },
      { provider: "github", fullPath: "acme/web" },
      "failed",
    );
    const held = [...Array.from({ length: DIGEST_REVIEW_LIMIT }, () => blocked), failed, failed, failed];
    const payload = digestPayloadFor(held, { from: new Date(), to: new Date(), timeZone: "UTC", schedule: "daily" });
    expect(payload.reviews).toHaveLength(DIGEST_REVIEW_LIMIT);
    expect(payload.reviews.filter((review) => review.review.status === "failed")).toHaveLength(3);
    expect(payload.reviews.at(-1)!.event).toBe("failed");
    expect(payload.truncated).toBe(3);
  });

  it("leaves failed runs out of the most-blocked list, like the headline", () => {
    const failed = payloadFor(
      { id: "j", number: 1, status: "failed", verdict: "blocked", error: "boom", summary: null, headSha: "abc", trigger: "manual" },
      { provider: "github", fullPath: "acme/web" },
      "failed",
    );
    const payload = digestPayloadFor([failed], { from: new Date(), to: new Date(), timeZone: "UTC", schedule: "daily" });
    expect(payload.counts.byVerdict.blocked).toBe(0);
    expect(payload.topBlockedRepositories).toEqual([]);
  });

  it("does not list a change as still blocked once a review it did not hold passed", async () => {
    // Only blocked reviews are held, so the pass afterwards never is.
    await digestTarget({ events: ["blocked"], dueAt: FUTURE });
    await finish("completed", "blocked", { number: 7, finishedAt: new Date(Date.now() - 2_000) });
    await finish("completed", "pass", { number: 7, finishedAt: new Date(Date.now() - 1_000) });
    await prisma.notificationTarget.updateMany({ data: { digestDueAt: PAST } });
    expect(await runDueDigests()).toBe(1);

    const payload = (await rows())[0]!.payload as unknown as DigestPayload;
    expect(payload.counts.byVerdict.blocked).toBe(1);
    expect(payload.blocked).toEqual([]);
  });

  it("builds one digest from a backlog larger than a page", async () => {
    const target = await digestTarget({ dueAt: PAST });
    const sample = payloadFor(
      { id: "j", number: 1, status: "completed", verdict: "pass", error: null, summary: null, headSha: "abc", trigger: "manual" },
      { provider: "github", fullPath: "acme/web" },
      "completed",
    );
    const createdAt = new Date(Date.now() - 60_000);
    await prisma.notificationDelivery.createMany({
      data: Array.from({ length: 1_200 }, () => ({
        targetId: target.id,
        event: "completed" as const,
        status: "held" as const,
        attempts: 0,
        payload: sample as unknown as object,
        createdAt,
      })),
    });
    expect(await runDueDigests()).toBe(1);
    expect(await rows("held")).toEqual([]);
    const payload = (await rows())[0]!.payload as unknown as DigestPayload;
    expect(payload.counts.reviews).toBe(1_200);
    expect(payload.truncated).toBe(1_200 - DIGEST_REVIEW_LIMIT);
  });

  it("moves a failing target aside so the others still get their digest", async () => {
    const broken = await digestTarget({ dueAt: FUTURE });
    const healthy = await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    // A held row the builder cannot read, on the target picked first.
    await prisma.notificationDelivery.create({
      data: { targetId: broken.id, event: "blocked", status: "held", attempts: 0, payload: { event: "blocked" } },
    });
    await prisma.notificationTarget.update({ where: { id: broken.id }, data: { digestDueAt: new Date(PAST.getTime() - 1_000) } });
    await prisma.notificationTarget.update({ where: { id: healthy.id }, data: { digestDueAt: PAST } });

    const now = new Date();
    expect(await runDueDigests(now)).toBe(1);
    const moved = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: broken.id } });
    expect(moved.digestDueAt).toEqual(new Date(now.getTime() + DIGEST_RETRY_MS));
    expect(await prisma.notificationDelivery.count({ where: { targetId: broken.id, status: "held" } })).toBe(2);
    expect(await prisma.notificationDelivery.findMany({ where: { targetId: healthy.id } })).toMatchObject([
      { event: "digest", status: "pending" },
    ]);
  });

  it("does not move a failed target's schedule changed after the rollback", async () => {
    const broken = await digestTarget({ dueAt: PAST });
    await prisma.notificationDelivery.create({
      data: { targetId: broken.id, event: "blocked", status: "held", attempts: 0, payload: { event: "blocked" } },
    });
    // An admin reschedules between the rollback and the backoff.
    const rescheduled = new Date(Date.now() + 5 * 60_000);
    const original = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
      try {
        return await (original as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (err) {
        await prisma.notificationTarget.update({ where: { id: broken.id }, data: { digestDueAt: rescheduled } });
        throw err;
      }
    }) as typeof prisma.$transaction);
    try {
      expect(await runDueDigests()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const target = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: broken.id } });
    expect(target.digestDueAt).toEqual(rescheduled);
  });

  it("sends the digest through the outbox to a webhook", async () => {
    await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    await prisma.notificationTarget.updateMany({ data: { digestDueAt: PAST } });
    await runDueDigests();

    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    for (const id of await claimDueDeliveries(10)) await runDelivery(id);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.headers["x-sentryward-event"]).toBe("digest");
    expect(JSON.parse(stub.calls[0]!.body!)).toMatchObject({ event: "digest", counts: { reviews: 1 } });
    expect(await rows()).toMatchObject([{ status: "sent", event: "digest" }]);
  });
});

describe("rendering digests", () => {
  const failedOf = (payload: DigestPayload) => payload.reviews.find((review) => review.review.status === "failed")!;

  async function builtDigest() {
    await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    await finish("failed", null);
    await prisma.notificationTarget.updateMany({ data: { digestDueAt: PAST } });
    await runDueDigests();
    const [row] = await rows();
    return row!.payload as unknown as DigestPayload;
  }

  it("keeps forge text out of Slack mrkdwn", async () => {
    const payload = await builtDigest();
    const target = await prisma.notificationTarget.update({
      where: { id: (await prisma.notificationTarget.findFirstOrThrow()).id },
      data: { kind: "slack", encryptedUrl: encrypt("https://hooks.slack.com/services/T/B/x"), encryptedSecret: null },
    });
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await deliver(target, workspaceId, payload);

    const body = JSON.parse(stub.calls[0]!.body!);
    expect(body.text).toBe("Daily digest: 2 reviews, 1 blocked, 1 failed");
    const mrkdwn = JSON.stringify(body.blocks).match(/"type":"mrkdwn","text":"[^"]*"/g) ?? [];
    expect(mrkdwn.length).toBeGreaterThan(0);
    for (const element of mrkdwn) expect(element).not.toContain("acme/");
    expect(JSON.stringify(body.blocks)).toContain("acme/web#");
  });

  async function chatDigest(payload: DigestPayload) {
    const target = await prisma.notificationTarget.update({
      where: { id: (await prisma.notificationTarget.findFirstOrThrow()).id },
      data: {
        kind: "google_chat",
        encryptedUrl: encrypt("https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t"),
        encryptedSecret: null,
      },
    });
    const stub = fetchStub([{ method: "POST", url: /chat\.googleapis\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await deliver(target, workspaceId, payload);
    expect(stub.calls).toHaveLength(1);
    return stub.calls[0]!.body!;
  }

  it("posts one Google Chat card summarising the period", async () => {
    const payload = await builtDigest();
    const body = JSON.parse(await chatDigest(payload));

    expect(body.text).toBe("Daily digest: 2 reviews, 1 blocked, 1 failed");
    expect(body.cardsV2).toHaveLength(1);
    const { header, sections } = body.cardsV2[0].card;
    expect(header.title).toBe("Daily digest");
    expect(header.subtitle).toContain("Europe/Berlin");
    expect(sections[0].widgets).toEqual([
      { textParagraph: { text: "2 reviews, 1 blocked, 1 failed" } },
      { textParagraph: { text: "Most blocked: acme/web (1)" } },
    ]);
    expect(sections.map((section: { header?: string }) => section.header)).toEqual([
      undefined,
      "Still blocked",
      "Failed",
      undefined,
    ]);
    const review = (url: string) => ({ text: "View review", onClick: { openLink: { url } } });
    expect(sections[1].widgets).toEqual([
      {
        decoratedText: {
          text: expect.stringContaining("acme/web#"),
          wrapText: true,
          button: review(payload.blocked[0]!.review.url),
        },
      },
    ]);
    expect(sections[2].widgets).toHaveLength(1);
    expect(sections[2].widgets[0].decoratedText.button).toEqual(review(failedOf(payload).review.url));
    expect(sections[3].widgets).toEqual([
      { buttonList: { buttons: [{ text: "All reviews", onClick: { openLink: { url: `${env.CLIENT_ORIGIN}/reviews` } } }] } },
    ]);
  });

  it("escapes forge text in a Google Chat digest and stays inside the message size limit", async () => {
    const payload = await builtDigest();
    // Every character grows sixfold when escaped: the worst a title can do.
    const hostile = '"'.repeat(3000);
    const entry = (base: DigestPayload["reviews"][number], i: number) => ({
      ...base,
      repository: { ...base.repository, fullPath: `<b>acme</b>/${hostile}` },
      change: { ...base.change, number: i, title: `<a href="https://evil.example">x</a> ${hostile}` },
      review: { ...base.review, error: base.review.error === null ? null : `<i>boom</i> ${hostile}` },
    });
    const failed = failedOf(payload);
    const worst: DigestPayload = {
      ...payload,
      counts: { ...payload.counts, failed: 60 },
      topBlockedRepositories: Array.from({ length: 5 }, (_, i) => ({
        provider: "github",
        fullPath: `<b>${i}</b>${hostile}`,
        blocked: 9,
      })),
      blocked: Array.from({ length: 50 }, (_, i) => entry(payload.blocked[0]!, i)),
      blockedTruncated: 7,
      reviews: Array.from({ length: 60 }, (_, i) => entry(failed, i)),
    };

    const raw = await chatDigest(worst);

    expect(Buffer.byteLength(raw)).toBeLessThan(32_000);
    const { sections } = JSON.parse(raw).cardsV2[0].card;
    // 10 of 57 blocked changes and 5 of 60 failed reviews, then the rest counted.
    expect(sections[1].widgets).toHaveLength(11);
    expect(sections[1].widgets.at(-1)).toEqual({ textParagraph: { text: "and 47 more" } });
    expect(sections[2].widgets).toHaveLength(6);
    expect(sections[2].widgets.at(-1)).toEqual({ textParagraph: { text: "and 55 more" } });
    const texts = [sections[0].widgets[1].textParagraph.text, ...sections.slice(1, 3).flatMap(
      (section: { widgets: { decoratedText?: { text: string } }[] }) =>
        section.widgets.flatMap((widget) => (widget.decoratedText ? [widget.decoratedText.text] : [])),
    )];
    expect(texts).toHaveLength(16);
    for (const text of texts) expect(text).not.toMatch(/[<>"]/);
    expect(texts[1]).toContain("&lt;b&gt;acme&lt;/b&gt;/");
  });

  it("emails a plain-text summary", async () => {
    const payload = await builtDigest();
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    const owner = await prisma.membership.findFirstOrThrow({ where: { workspaceId, role: "owner" } });
    const target = await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["blocked"], recipientIds: [owner.userId] },
    });
    await deliver(target, workspaceId, payload);

    const mail = send.mock.calls[0]![0];
    expect(mail.subject).toBe("Daily digest: 2 reviews, 1 blocked, 1 failed");
    expect(mail.text).toContain("Still blocked:");
    expect(mail.text).toContain("Most blocked: acme/web (1)");
    expect(mail.text).toContain("Failed:");
  });

  it("links the review instead of a change URL that is not http(s), as rows queued before the check carry", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    const owner = await prisma.membership.findFirstOrThrow({ where: { workspaceId, role: "owner" } });
    const target = await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["blocked"], recipientIds: [owner.userId] },
    });
    const review = payloadFor(
      { id: "j", number: 1, status: "completed", verdict: "blocked", error: null, summary: null, headSha: "abc", trigger: "manual" },
      { provider: "github", fullPath: "acme/web" },
      "blocked",
    );
    const stored = { ...review, change: { ...review.change, url: "javascript:alert(1)" } };
    const built = digestPayloadFor([stored], { from: new Date(), to: new Date(), timeZone: "UTC", schedule: "daily" });
    // The still-blocked list is filled from the database when a digest is built.
    const payload: DigestPayload = { ...built, blocked: [stored] };

    await deliver(target, workspaceId, payload);

    const { text } = send.mock.calls[0]![0];
    expect(text).not.toContain("javascript:");
    expect(text).toContain(`  ${review.review.url}\n  Review: ${review.review.url}`);
  });
});

describe("pausing, switching and retention", () => {
  it("drops held reviews when a target is paused", async () => {
    const target = await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    await request(app).patch(`/api/notifications/${target.id}`).set("Cookie", cookie).set(...inWorkspace(workspaceId))
      .send({ active: false })
      .expect(200);
    expect(await rows()).toEqual([]);
  });

  it("sends what was held as a final digest after switching back to each review", async () => {
    const target = await digestTarget({ dueAt: new Date(Date.now() + 60 * 60_000) });
    await finish("completed", "blocked");
    const res = await request(app).patch(`/api/notifications/${target.id}`).set("Cookie", cookie).set(...inWorkspace(workspaceId))
      .send({ delivery: { mode: "each" } })
      .expect(200);
    expect(res.body.target.delivery).toMatchObject({ mode: "each", nextDigestAt: null, held: 1 });

    expect(await runDueDigests()).toBe(1);
    const [digest] = await rows();
    expect(digest!.payload).toMatchObject({ event: "digest", schedule: null });
    const updated = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.digestDueAt).toBeNull();

    // From now on, each review is queued on its own.
    await finish("completed", "blocked");
    expect(await rows("pending")).toHaveLength(2);
  });

  it("keeps the owed final digest's period when switching back to digests before it is built", async () => {
    const target = await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    const patch = (delivery: object) =>
      request(app).patch(`/api/notifications/${target.id}`).set("Cookie", cookie).set(...inWorkspace(workspaceId))
        .send({ delivery })
        .expect(200);
    await patch({ mode: "each" });
    await patch({ mode: "daily", hour: 9, timeZone: "Europe/Berlin" });

    const updated = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.digestSince).toEqual(target.digestSince);
    expect(updated.digestDueAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await rows("held")).toHaveLength(1);
  });

  it("keeps held reviews out of retention and the delivery history", async () => {
    const target = await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    await prisma.notificationDelivery.updateMany({ data: { createdAt: new Date("2020-01-01T00:00:00Z") } });
    expect(await pruneDeliveries(30)).toBe(0);

    const res = await request(app).get(`/api/notifications/${target.id}/deliveries`).set("Cookie", cookie).set(...inWorkspace(workspaceId))
      .expect(200);
    expect(res.body).toMatchObject({ deliveries: [], total: 0 });
  });

  it("deletes old held reviews under a workspace's shorter privacy retention", async () => {
    await digestTarget({ dueAt: FUTURE });
    await finish("completed", "blocked");
    await prisma.notificationDelivery.updateMany({ data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000) } });
    expect(await pruneDeliveries(1, { workspaceIds: [workspaceId] })).toBe(1);
    expect(await rows()).toEqual([]);
  });
});

describe("API", () => {
  it("creates a weekly digest target and schedules it", async () => {
    const res = await request(app).post("/api/notifications").set("Cookie", cookie).set(...inWorkspace(workspaceId))
      .send({
        kind: "slack",
        name: "Weekly",
        events: ["blocked"],
        url: "https://hooks.slack.com/services/T/B/x",
        delivery: { mode: "weekly", hour: 9, weekday: 1, timeZone: "Europe/Berlin" },
      })
      .expect(201);
    expect(res.body.target.delivery).toMatchObject({ mode: "weekly", hour: 9, weekday: 1, timeZone: "Europe/Berlin", held: 0 });
    const due = new Date(res.body.target.delivery.nextDigestAt);
    expect(due.getTime()).toBeGreaterThan(Date.now());
    expect(due.getUTCDay()).toBe(1);
  });

  it("defaults to each review", async () => {
    const res = await request(app).post("/api/notifications").set("Cookie", cookie).set(...inWorkspace(workspaceId))
      .send({ kind: "slack", name: "Each", events: ["blocked"], url: "https://hooks.slack.com/services/T/B/x" })
      .expect(201);
    expect(res.body.target.delivery).toMatchObject({ mode: "each", nextDigestAt: null });
  });

  it("rejects an unknown timezone or a weekly digest without a day", async () => {
    const send = (delivery: object) =>
      request(app).post("/api/notifications").set("Cookie", cookie).set(...inWorkspace(workspaceId)).send({
        kind: "slack",
        name: "Bad",
        events: ["blocked"],
        url: "https://hooks.slack.com/services/T/B/x",
        delivery,
      });
    await send({ mode: "daily", hour: 9, timeZone: "Mars/Olympus" }).expect(400);
    await send({ mode: "weekly", hour: 9, timeZone: "UTC" }).expect(400);
    await send({ mode: "daily", hour: 24, timeZone: "UTC" }).expect(400);
  });
});
