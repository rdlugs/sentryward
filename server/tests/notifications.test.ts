import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import type { NotificationEvent, ReviewStatus, ReviewVerdict } from "../src/generated/prisma/client.ts";
import { decrypt, encrypt } from "../src/lib/crypto.ts";
import { mailer } from "../src/lib/mailer.ts";
import { prisma } from "../src/lib/prisma.ts";
import {
  deliver,
  escapeHtml,
  escapeSlack,
  eventsFor,
  notifyJob,
  payloadFor,
  redactError,
  SECRET_GRACE_MS,
  signature,
  testTarget,
  timestampedSignature,
} from "../src/services/notifications.ts";
import { claimDueDeliveries, runDelivery } from "../src/worker/deliveryQueue.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { addMember, createUser, inWorkspace } from "./helpers/users.ts";

let cookie: string;
let userId: string;
let workspaceId: string;
let repositoryId: string;

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const summary = {
  title: "Add login",
  webUrl: "https://github.com/acme/web/pull/7",
  total: 3,
  bySeverity: { major: 1, minor: 2 },
  byBucket: {},
  hasBlocking: true,
  usageTotals: { calls: 1, inputTokens: 1, outputTokens: 1 },
};

function finishedJob(status: ReviewStatus, verdict: ReviewVerdict | null, error: string | null = null) {
  return prisma.reviewJob.create({
    data: {
      repositoryId,
      number: 7,
      headSha: "aaa",
      trigger: "manual",
      status,
      verdict,
      error,
      summary: status === "failed" ? undefined : summary,
      finishedAt: new Date(),
    },
  });
}

function target(
  kind: "webhook" | "slack" | "google_chat" | "discord" | "teams",
  events: NotificationEvent[],
  url = "https://hooks.example.com/sw",
) {
  return prisma.notificationTarget.create({
    data: {
      workspaceId,
      kind,
      name: kind,
      events,
      encryptedUrl: encrypt(url),
      encryptedSecret: kind === "webhook" ? encrypt("shh") : null,
    },
  });
}

// Queues the job's deliveries and sends whatever is due, as one worker poll
// would.
async function notifyAndSend(jobId: string) {
  await notifyJob(jobId);
  for (const id of await claimDueDeliveries(100)) await runDelivery(id);
}

describe("eventsFor", () => {
  it.each([
    ["completed", "pass", ["completed"]],
    ["completed", "blocked", ["blocked", "completed"]],
    ["partial", "blocked", ["blocked", "completed"]],
    ["failed", "error", ["failed"]],
    ["skipped", null, []],
    ["cancelled", null, []],
    ["superseded", null, []],
  ] as const)("%s with %s counts as %j", (status, verdict, events) => {
    expect(eventsFor({ status, verdict })).toEqual(events);
  });
});

describe("notifyJob", () => {
  it("sends a signed webhook only to targets listening for one of the job's events", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("webhook", ["completed"]);
    await target("webhook", ["failed"], "https://hooks.example.com/failures");
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call!.url).toBe("https://hooks.example.com/sw");
    expect(call!.headers["x-sentryward-event"]).toBe("completed");
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { jobId: job.id } });
    expect(call!.headers["x-sentryward-delivery"]).toBe(delivery.id);
    const timestamp = call!.headers["x-sentryward-timestamp"]!;
    expect(timestamp).toMatch(/^\d+$/);
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
    // The new signature covers the timestamp; the old one still verifies.
    expect(call!.headers["x-sentryward-signature-v2"]).toBe(timestampedSignature("shh", timestamp, call!.body!));
    expect(call!.headers["x-sentryward-signature-v2"]).toBe(signature("shh", `${timestamp}.${call!.body!}`));
    expect(call!.headers["x-sentryward-signature"]).toBe(signature("shh", call!.body!));
    const body = JSON.parse(call!.body!);
    expect(body).toEqual({
      deliveryId: delivery.id,
      timestamp: expect.any(String),
      event: "completed",
      review: {
        id: job.id,
        url: `${env.CLIENT_ORIGIN}/reviews/${job.id}`,
        status: "completed",
        verdict: "blocked",
        error: null,
        trigger: "manual",
      },
      repository: { provider: "github", fullPath: "acme/web" },
      change: { number: 7, title: "Add login", url: "https://github.com/acme/web/pull/7", headSha: "aaa" },
      findings: { total: 3, bySeverity: { major: 1, minor: 2 } },
    });
    // The body's ISO timestamp is exactly the header's second.
    expect(body.timestamp).toBe(new Date(Number(timestamp) * 1000).toISOString());
  });

  it("signs the timestamp it was given and never lets the payload replace the signed values", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    const hook = await target("webhook", ["completed"]);
    const job = await finishedJob("completed", "pass");
    const repository = { provider: "github", fullPath: "acme/web" };
    const payload = { ...payloadFor(job, repository, "completed"), deliveryId: "forged", timestamp: "1970-01-01T00:00:00.000Z" };

    await deliver(hook, workspaceId, payload, { deliveryId: "real-id", now: new Date("2026-11-11T09:30:00.750Z") });

    const [call] = stub.calls;
    expect(call!.headers["x-sentryward-timestamp"]).toBe("1794389400");
    const body = JSON.parse(call!.body!);
    expect(body.deliveryId).toBe("real-id");
    expect(body.timestamp).toBe("2026-11-11T09:30:00.000Z");
  });

  it("sends a change URL that is not http(s) as null", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("webhook", ["blocked"]);
    const job = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 7,
        headSha: "aaa",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, webUrl: "javascript:alert(1)" },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(job.id);

    expect(JSON.parse(stub.calls[0]!.body!).change.url).toBeNull();
  });

  it("signs a test delivery under the id its log row is stored with", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    const hook = await target("webhook", ["completed"]);

    expect(await testTarget(hook)).toEqual({ ok: true });

    const [call] = stub.calls;
    const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { targetId: hook.id } });
    expect(call!.headers["x-sentryward-delivery"]).toBe(row.id);
    expect(JSON.parse(call!.body!)).toMatchObject({ deliveryId: row.id, event: "test" });
    const timestamp = call!.headers["x-sentryward-timestamp"]!;
    expect(call!.headers["x-sentryward-signature-v2"]).toBe(timestampedSignature("shh", timestamp, call!.body!));
  });

  it("skips paused targets", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("webhook", ["completed"]);
    const paused = await target("webhook", ["completed"], "https://hooks.example.com/paused");
    await prisma.notificationTarget.update({ where: { id: paused.id }, data: { active: false } });
    const job = await finishedJob("completed", "pass");

    await notifyAndSend(job.id);

    expect(stub.calls.map((call) => call.url)).toEqual(["https://hooks.example.com/sw"]);
  });

  it("names the most specific event a target listens for", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("webhook", ["blocked", "completed"]);
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    expect(stub.calls).toHaveLength(1);
    expect(JSON.parse(stub.calls[0]!.body!).event).toBe("blocked");
  });

  const reviewLink = (id: string) => `<${env.CLIENT_ORIGIN}/reviews/${id}|View review>`;
  const prLink = "<https://github.com/acme/web/pull/7|Open PR>";
  const links = (...parts: string[]) => ({ type: "context", elements: [{ type: "mrkdwn", text: parts.join(" · ") }] });

  it("posts a failed review to Slack with its error and a review link", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("slack", ["failed"], "https://hooks.slack.com/services/T/B/X");
    const job = await finishedJob("failed", "error", "No API key for anthropic");

    await notifyAndSend(job.id);

    // A failed review has no summary, so no change URL and no PR link.
    expect(JSON.parse(stub.calls[0]!.body!)).toEqual({
      text: "Review failed: acme/web#7",
      blocks: [
        { type: "section", text: { type: "plain_text", text: "\u26A0\uFE0F Review failed · acme/web #7", emoji: false } },
        { type: "context", elements: [{ type: "plain_text", text: "No API key for anthropic", emoji: false }] },
        links(reviewLink(job.id)),
      ],
    });
  });

  it("posts a blocked review with its title in its own block, the severities and a PR link", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("slack", ["blocked"], "https://hooks.slack.com/services/T/B/X");
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    expect(JSON.parse(stub.calls[0]!.body!)).toEqual({
      text: "Review blocked: acme/web#7",
      blocks: [
        { type: "section", text: { type: "plain_text", text: "\u{1F534} Review blocked · acme/web #7", emoji: false } },
        { type: "context", elements: [{ type: "plain_text", text: "Add login", emoji: false }] },
        { type: "section", text: { type: "plain_text", text: "3 findings   1 major · 2 minor", emoji: false } },
        links(reviewLink(job.id), prLink),
      ],
    });
  });

  it("orders the severities most severe first in a completed review", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("slack", ["completed"], "https://hooks.slack.com/services/T/B/X");
    const job = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 7,
        headSha: "aaa",
        trigger: "webhook",
        status: "completed",
        verdict: "pass",
        summary: { ...summary, total: 4, bySeverity: { info: 1, minor: 2, critical: 1 }, hasBlocking: false },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(job.id);

    const { blocks } = JSON.parse(stub.calls[0]!.body!);
    expect(blocks[0].text.text).toBe("\u{1F7E2} Review completed · acme/web #7");
    expect(blocks[2].text.text).toBe("4 findings   1 critical · 2 minor · 1 info");
  });

  it.each([
    ["no change URL", undefined],
    ["a change URL that is not http(s)", "javascript:alert(1)"],
    ["a change URL too long for Slack", `https://github.com/acme/web/pull/7?${"x".repeat(4000)}`],
  ])("leaves the PR link out with %s", async (_label, webUrl) => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("slack", ["blocked"], "https://hooks.slack.com/services/T/B/X");
    const job = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 7,
        headSha: "aaa",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, webUrl },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(job.id);

    const { blocks } = JSON.parse(stub.calls[0]!.body!);
    expect(blocks.at(-1)).toEqual(links(reviewLink(job.id)));
  });

  it("encodes the characters that would end a mrkdwn link inside a change URL", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("slack", ["blocked"], "https://hooks.slack.com/services/T/B/X");
    const job = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 7,
        headSha: "aaa",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, webUrl: "https://github.com/acme/web/pull/7?q=a|<!channel>" },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(job.id);

    const { blocks } = JSON.parse(stub.calls[0]!.body!);
    expect(blocks.at(-1)).toEqual(
      links(reviewLink(job.id), "<https://github.com/acme/web/pull/7?q=a%7C%3C!channel%3E|Open PR>"),
    );
  });

  it("sends a test notification to Slack", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    const slack = await target("slack", ["failed"], "https://hooks.slack.com/services/T/B/X");

    expect(await testTarget(slack)).toEqual({ ok: true });

    expect(JSON.parse(stub.calls[0]!.body!)).toEqual({
      text: "Test notification: example/repository#1",
      blocks: [
        {
          type: "section",
          text: { type: "plain_text", text: "\u{1F514} Test notification · example/repository #1", emoji: false },
        },
        { type: "context", elements: [{ type: "plain_text", text: "Test notification from Sentryward", emoji: false }] },
        { type: "section", text: { type: "plain_text", text: "0 findings", emoji: false } },
        links(`<${env.CLIENT_ORIGIN}/reviews|View review>`),
      ],
    });
  });

  // Forge text that would mean something in mrkdwn: mentions, links (bracketed
  // and bare), emphasis, code, a quote that would close ours, and newlines.
  const HOSTILE = [
    "<!channel> <https://evil.example|x> & co",
    "Re-authenticate at https://evil.example/login",
    "*Review completed: approved* _x_ ~y~ `z`",
    "@channel @here",
    'fix" - 0 findings. Approved by security "',
    "boom\n\nReview completed: acme/web#7 - 0 findings",
  ];

  // Every string in a Slack body with the type of the object holding it.
  function slackStrings(body: { blocks: unknown[] }): { type: string; text: string }[] {
    const found: { type: string; text: string }[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if ((obj.type === "plain_text" || obj.type === "mrkdwn") && typeof obj.text === "string") {
        found.push({ type: obj.type, text: obj.text });
      }
      Object.values(obj).forEach(walk);
    };
    walk(body.blocks);
    return found;
  }

  it.each(HOSTILE)("keeps forge text out of mrkdwn in Slack messages: %j", async (hostile) => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }, { method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("slack", ["failed", "blocked"], "https://hooks.slack.com/services/T/B/X");
    const blocked = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 8,
        headSha: "bbb",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, title: hostile },
        finishedAt: new Date(),
      },
    });
    const failed = await finishedJob("failed", "error", hostile);

    await notifyAndSend(blocked.id);
    await notifyAndSend(failed.id);

    const flat = hostile.replace(/\s+/g, " ").trim();
    const jobs = [blocked, failed];
    stub.calls.forEach((call, i) => {
      const body = JSON.parse(call.body!);
      // The notification fallback names the change and nothing the author wrote.
      expect(body.text).toBe(i === 0 ? "Review blocked: acme/web#8" : "Review failed: acme/web#7");
      const strings = slackStrings(body);
      // The only mrkdwn is our own links.
      const expectedLinks = i === 0 ? [reviewLink(jobs[i]!.id), prLink] : [reviewLink(jobs[i]!.id)];
      expect(strings.filter((s) => s.type === "mrkdwn")).toEqual([{ type: "mrkdwn", text: expectedLinks.join(" · ") }]);
      expect(strings).toContainEqual({ type: "plain_text", text: flat });
      for (const s of strings) expect(s.text).not.toContain("\n");
    });
  });

  it("clips long forge text to fit Slack's plain-text limit", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("slack", ["failed"], "https://hooks.slack.com/services/T/B/X");
    await notifyAndSend((await finishedJob("failed", "error", "x".repeat(5000))).id);

    const strings = slackStrings(JSON.parse(stub.calls[0]!.body!));
    for (const s of strings) expect(s.text.length).toBeLessThanOrEqual(2000);
  });

  it("escapes Slack's control characters in one pass", () => {
    expect(escapeSlack("<!channel> & <a|b>")).toBe("&lt;!channel&gt; &amp; &lt;a|b&gt;");
    expect(escapeSlack("&amp;")).toBe("&amp;amp;");
  });

  const CHAT_URL = "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=chat-key-value&token=chat-token-value";
  const chatStub = () => fetchStub([{ method: "POST", url: /chat\.googleapis\.com/ }]);
  const paragraph = (text: string) => ({ textParagraph: { text } });
  const button = (text: string, url: string) => ({ text, onClick: { openLink: { url } } });
  const reviewButton = (id: string) => button("View review", `${env.CLIENT_ORIGIN}/reviews/${id}`);
  const prButton = button("Open PR", "https://github.com/acme/web/pull/7");
  const card = (title: string, widgets: unknown[]) => [{ cardId: "review", card: { header: { title }, sections: [{ widgets }] } }];

  it("posts a failed review to Google Chat as a card with its error and a review button", async () => {
    const stub = chatStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("google_chat", ["failed"], CHAT_URL);
    const job = await finishedJob("failed", "error", "No API key for anthropic");

    await notifyAndSend(job.id);

    expect(stub.calls[0]!.url).toBe(CHAT_URL);
    // No signature headers: the URL is the credential.
    expect(Object.keys(stub.calls[0]!.headers).filter((name) => name.startsWith("x-sentryward"))).toEqual([]);
    // A failed review has no summary, so no change URL and no PR button.
    expect(JSON.parse(stub.calls[0]!.body!)).toEqual({
      fallbackText: "Review failed #7",
      cardsV2: card("⚠️ Review failed", [
        paragraph("acme/web #7"),
        paragraph("No API key for anthropic"),
        { buttonList: { buttons: [reviewButton(job.id)] } },
      ]),
    });
  });

  it("posts a blocked review to Google Chat with its title, the severities and a PR button", async () => {
    const stub = chatStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("google_chat", ["blocked"], CHAT_URL);
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    expect(JSON.parse(stub.calls[0]!.body!)).toEqual({
      fallbackText: "Review blocked #7",
      cardsV2: card("\u{1F534} Review blocked", [
        paragraph("acme/web #7"),
        paragraph("<b>Add login</b>"),
        paragraph("3 findings (1 major · 2 minor)"),
        { buttonList: { buttons: [reviewButton(job.id), prButton] } },
      ]),
    });
  });

  it.each([
    ["no change URL", undefined],
    ["a change URL that is not http(s)", "javascript:alert(1)"],
    ["a change URL too long to send", `https://github.com/acme/web/pull/7?${"x".repeat(4000)}`],
  ])("leaves the Google Chat PR button out with %s", async (_label, webUrl) => {
    const stub = chatStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("google_chat", ["blocked"], CHAT_URL);
    const job = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 7,
        headSha: "aaa",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, webUrl },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(job.id);

    const widgets = JSON.parse(stub.calls[0]!.body!).cardsV2[0].card.sections[0].widgets;
    expect(widgets.at(-1)).toEqual({ buttonList: { buttons: [reviewButton(job.id)] } });
  });

  it("sends a test notification to Google Chat", async () => {
    const stub = chatStub();
    vi.stubGlobal("fetch", stub.fetch);
    const chat = await target("google_chat", ["failed"], CHAT_URL);

    expect(await testTarget(chat)).toEqual({ ok: true });

    expect(JSON.parse(stub.calls[0]!.body!)).toEqual({
      fallbackText: "Test notification #1",
      cardsV2: card("\u{1F514} Test notification", [
        paragraph("example/repository #1"),
        paragraph("<b>Test notification from Sentryward</b>"),
        paragraph("0 findings"),
        { buttonList: { buttons: [button("View review", `${env.CLIENT_ORIGIN}/reviews`)] } },
      ]),
    });
  });

  // Card text renders a subset of HTML, so markup is added to the Slack list.
  const CHAT_HOSTILE = [...HOSTILE, '<a href="https://evil.example">Approve</a> <b>ok</b> &amp; <font color="#ff0000">x</font>'];

  it.each(CHAT_HOSTILE)("escapes forge text in Google Chat cards and keeps it out of the text: %j", async (hostile) => {
    const stub = fetchStub([
      { method: "POST", url: /chat\.googleapis\.com/ },
      { method: "POST", url: /chat\.googleapis\.com/ },
    ]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("google_chat", ["failed", "blocked"], CHAT_URL);
    const blocked = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 8,
        headSha: "bbb",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, title: hostile },
        finishedAt: new Date(),
      },
    });
    const failed = await finishedJob("failed", "error", hostile);

    await notifyAndSend(blocked.id);
    await notifyAndSend(failed.id);

    const flat = hostile.replace(/\s+/g, " ").trim();
    // What the card shows once Chat decodes it, without the zero-width breaks.
    const shown = (text: string) =>
      text.replaceAll("\u200B", "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    const jobs = [blocked, failed];
    stub.calls.forEach((call, i) => {
      const body = JSON.parse(call.body!);
      // No `text`, which Chat would show above the card. It formats the
      // fallback and has no escape for it: our words and the number only.
      expect(body.text).toBeUndefined();
      expect(body.fallbackText).toBe(i === 0 ? "Review blocked #8" : "Review failed #7");
      const { header, sections } = body.cardsV2[0].card;
      expect(header).toEqual({ title: i === 0 ? "\u{1F534} Review blocked" : "⚠️ Review failed" });
      const widgets = sections[0].widgets as { textParagraph?: { text: string }; buttonList?: unknown }[];
      const texts = widgets.flatMap((widget) => (widget.textParagraph ? [widget.textParagraph.text] : []));
      const inner = texts.map((text) => text.replace(/^<b>(.*)<\/b>$/, "$1"));
      expect(texts.some((text) => text.startsWith("<b>"))).toBe(i === 0);
      expect(inner.map(shown)).toContain(flat);
      for (const text of inner) {
        // The only markup in the card is our own bold around the title.
        expect(text).not.toMatch(/[<>\n]/);
        // Nothing left that Chat would link: no scheme and no dotted name.
        expect(text).not.toMatch(/:\/\/(?!\u200B)|\w\.\w/);
      }
      // Links are buttons to our review and the checked change URL, nothing else.
      expect(widgets.at(-1)).toEqual({
        buttonList: { buttons: i === 0 ? [reviewButton(jobs[i]!.id), prButton] : [reviewButton(jobs[i]!.id)] },
      });
    });
  });

  it("clips long forge text in a Google Chat card", async () => {
    const stub = chatStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("google_chat", ["failed"], CHAT_URL);
    await notifyAndSend((await finishedJob("failed", "error", "&".repeat(5000))).id);

    const body = stub.calls[0]!.body!;
    // 1000 characters kept, each five once escaped.
    expect(JSON.parse(body).cardsV2[0].card.sections[0].widgets[1].textParagraph.text).toHaveLength(5000 - 5 + 1);
    expect(Buffer.byteLength(body)).toBeLessThan(32_000);
  });

  it("keeps a URL in forge text from becoming a link in a Google Chat card, and leaves quotes as written", async () => {
    const stub = chatStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("google_chat", ["failed"], CHAT_URL);
    await notifyAndSend((await finishedJob("failed", "error", `Don't retry "flaky" https://evil.example/reset or www.evil.example`)).id);

    const { text } = JSON.parse(stub.calls[0]!.body!).cardsV2[0].card.sections[0].widgets[1].textParagraph;
    expect(text).toBe(`Don't retry "flaky" https://\u200Bevil.\u200Bexample/reset or www.\u200Bevil.\u200Bexample`);
  });

  it("does not cut an emoji in half when clipping Google Chat card text", async () => {
    const stub = chatStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("google_chat", ["failed"], CHAT_URL);
    // The emoji's two code units sit either side of the 1000-character cut.
    await notifyAndSend((await finishedJob("failed", "error", `${"x".repeat(998)}\u{1F600}${"y".repeat(50)}`)).id);

    const raw = stub.calls[0]!.body!;
    expect(raw).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    expect(JSON.parse(raw).cardsV2[0].card.sections[0].widgets[1].textParagraph.text).toBe(`${"x".repeat(998)}…`);
  });

  it("never stores a Google Chat URL's key or token in an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`request to ${CHAT_URL} failed; key=chat-key-value token=chat-token-value`);
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target("google_chat", ["completed"], CHAT_URL);

    await notifyAndSend((await finishedJob("completed", "pass")).id);

    const row = await prisma.notificationDelivery.findFirstOrThrow();
    expect(row.error).not.toMatch(/chat-key-value|chat-token-value|AAAA/);
  });

  const DISCORD_URL = "https://discord.com/api/webhooks/123456789012345678/discord-token-value";
  const discordStub = (times = 1) =>
    fetchStub(Array.from({ length: times }, () => ({ method: "POST", url: /discord\.com\/api\/webhooks/ })));
  const discordReviewLink = (id: string) => `[View review](${env.CLIENT_ORIGIN}/reviews/${id})`;
  const embed = (title: string, color: number, lines: string[]) => ({
    embeds: [{ title, description: lines.join("\n"), color }],
    allowed_mentions: { parse: [] },
  });

  it("posts a failed review to Discord as an embed with its error and a review link", async () => {
    const stub = discordStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("discord", ["failed"], DISCORD_URL);
    const job = await finishedJob("failed", "error", "No API key for anthropic");

    await notifyAndSend(job.id);

    expect(stub.calls[0]!.url).toBe(DISCORD_URL);
    // No signature headers: the URL is the credential.
    expect(Object.keys(stub.calls[0]!.headers).filter((name) => name.startsWith("x-sentryward"))).toEqual([]);
    // No `content`, which Discord would show above the embed; and a failed
    // review has no summary, so no change URL and no PR link.
    expect(JSON.parse(stub.calls[0]!.body!)).toEqual(
      embed("⚠️ Review failed", 0xf59e0b, ["acme/web \\#7", "No API key for anthropic", discordReviewLink(job.id)]),
    );
  });

  it("posts a blocked review to Discord with its title, the severities and a PR link", async () => {
    const stub = discordStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("discord", ["blocked"], DISCORD_URL);
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    expect(JSON.parse(stub.calls[0]!.body!)).toEqual(
      embed("\u{1F534} Review blocked", 0xdc2626, [
        "acme/web \\#7",
        "**Add login**",
        "3 findings (1 major · 2 minor)",
        `${discordReviewLink(job.id)} · [Open PR](https://github.com/acme/web/pull/7)`,
      ]),
    );
  });

  it.each([
    ["no change URL", undefined],
    ["a change URL that is not http(s)", "javascript:alert(1)"],
    ["a change URL too long to send", `https://github.com/acme/web/pull/7?${"x".repeat(1000)}`],
  ])("leaves the Discord PR link out with %s", async (_label, webUrl) => {
    const stub = discordStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("discord", ["blocked"], DISCORD_URL);
    const job = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 7,
        headSha: "aaa",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, webUrl },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(job.id);

    const { description } = JSON.parse(stub.calls[0]!.body!).embeds[0];
    expect(description.split("\n").at(-1)).toBe(discordReviewLink(job.id));
  });

  it("encodes a change URL so it cannot end a Discord link early", async () => {
    const stub = discordStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("discord", ["blocked"], DISCORD_URL);
    const job = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 7,
        headSha: "aaa",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, webUrl: "https://github.com/acme/web/pull/7?a=(x)&b=) [Approve](https://evil.example" },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(job.id);

    const { description } = JSON.parse(stub.calls[0]!.body!).embeds[0];
    const link = description.split("\n").at(-1).split(" · ")[1];
    expect(link).toMatch(/^\[Open PR\]\(https:\/\/github\.com\/acme\/web\/pull\/7\?[^()\s<>]*\)$/);
    expect(link).toContain("%28x%29");
  });

  it("sends a test notification to Discord", async () => {
    const stub = discordStub();
    vi.stubGlobal("fetch", stub.fetch);
    const discord = await target("discord", ["failed"], DISCORD_URL);

    expect(await testTarget(discord)).toEqual({ ok: true });

    expect(JSON.parse(stub.calls[0]!.body!)).toEqual(
      embed("\u{1F514} Test notification", 0x3b82f6, [
        "example/repository \\#1",
        "**Test notification from Sentryward**",
        "0 findings",
        `[View review](${env.CLIENT_ORIGIN}/reviews)`,
      ]),
    );
  });

  // Discord's own markup is added to the Slack list.
  const DISCORD_HOSTILE = [
    ...HOSTILE,
    "[Approve](https://evil.example) ||spoiler|| <@123> <#456> <@&789> @everyone",
    "# heading\n> quote\n- item\n1. step",
    "back\\slash \\*not bold\\* https://evil.example/reset",
  ];

  it.each(DISCORD_HOSTILE)("escapes forge text in Discord embeds: %j", async (hostile) => {
    const stub = discordStub(2);
    vi.stubGlobal("fetch", stub.fetch);
    await target("discord", ["failed", "blocked"], DISCORD_URL);
    const blocked = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 8,
        headSha: "bbb",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, title: hostile },
        finishedAt: new Date(),
      },
    });
    const failed = await finishedJob("failed", "error", hostile);

    await notifyAndSend(blocked.id);
    await notifyAndSend(failed.id);

    const flat = hostile.replace(/\s+/g, " ").trim();
    // What Discord shows: each backslash gives the character after it.
    const shown = (text: string) => text.replaceAll("​", "").replace(/\\(.)/g, "$1");
    const jobs = [blocked, failed];
    stub.calls.forEach((call, i) => {
      const body = JSON.parse(call.body!);
      expect(body.content).toBeUndefined();
      expect(body.allowed_mentions).toEqual({ parse: [] });
      expect(body.embeds).toHaveLength(1);
      // The title is our own words only.
      expect(body.embeds[0].title).toBe(i === 0 ? "\u{1F534} Review blocked" : "⚠️ Review failed");
      const lines = body.embeds[0].description.split("\n") as string[];
      // One line each: a second line of forge text could pass for one of ours.
      expect(lines).toHaveLength(i === 0 ? 4 : 3);
      const forge = i === 0 ? lines[1]!.replace(/^\*\*(.*)\*\*$/, "$1") : lines[1]!;
      expect(lines[1]!.startsWith("**")).toBe(i === 0);
      expect(shown(forge)).toBe(flat);
      // With every escaped character taken out, nothing Discord reads as
      // markup, a mention or a link is left.
      const unescaped = forge.replace(/\\[^0-9A-Za-z\s]/g, "");
      expect(unescaped).not.toMatch(/[\\*_~`|<>#\-[\]():]/);
      expect(unescaped).not.toMatch(/@(?!​)/);
      // Links are to our review and the checked change URL, nothing else.
      expect(lines.at(-1)).toBe(
        i === 0 ? `${discordReviewLink(jobs[i]!.id)} · [Open PR](https://github.com/acme/web/pull/7)` : discordReviewLink(jobs[i]!.id),
      );
    });
  });

  it("clips long forge text in a Discord embed without cutting an escape or an emoji", async () => {
    const stub = discordStub(2);
    vi.stubGlobal("fetch", stub.fetch);
    await target("discord", ["failed"], DISCORD_URL);
    await notifyAndSend((await finishedJob("failed", "error", "*".repeat(5000))).id);
    // The emoji's two code units sit either side of the 700-character cut.
    await notifyAndSend((await finishedJob("failed", "error", `${"x".repeat(698)}\u{1F600}${"y".repeat(50)}`)).id);

    // 700 characters kept, each two once escaped.
    expect(JSON.parse(stub.calls[0]!.body!).embeds[0].description.split("\n")[1]).toBe(`${"\\*".repeat(699)}…`);
    expect(stub.calls[1]!.body!).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    expect(JSON.parse(stub.calls[1]!.body!).embeds[0].description.split("\n")[1]).toBe(`${"x".repeat(698)}…`);
  });

  it("keeps the worst review inside Discord's embed limits", async () => {
    const stub = discordStub();
    vi.stubGlobal("fetch", stub.fetch);
    const discord = await target("discord", ["failed"], DISCORD_URL);
    const hostile = "*".repeat(5000);

    await deliver(discord, workspaceId, {
      event: "failed",
      review: { id: "r1", url: `${env.CLIENT_ORIGIN}/reviews/r1`, status: "failed", verdict: "error", error: hostile, trigger: "manual" },
      repository: { provider: "github", fullPath: hostile },
      change: { number: 7, title: hostile, url: `https://github.com/acme/web/pull/7?${"x".repeat(950)}`, headSha: "aaa" },
      findings: null,
    });

    const [{ title, description }] = JSON.parse(stub.calls[0]!.body!).embeds;
    expect(description).toContain("[Open PR](");
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(title.length + description.length).toBeLessThan(6000);
  });

  it("never stores a Discord URL's token in an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`request to ${DISCORD_URL} failed; token discord-token-value`);
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target("discord", ["completed"], DISCORD_URL);

    await notifyAndSend((await finishedJob("completed", "pass")).id);

    const row = await prisma.notificationDelivery.findFirstOrThrow();
    expect(row.error).not.toMatch(/discord-token-value|123456789012345678/);
  });

  const TEAMS_URL =
    "https://prod-12.westeurope.logic.azure.com:443/workflows/0123456789abcdef/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=teams-sig-value";
  const teamsStub = (times = 1) =>
    fetchStub(Array.from({ length: times }, () => ({ method: "POST", url: /logic\.azure\.com/ })));
  const heading = (text: string) => ({ type: "TextBlock", text, weight: "Bolder", wrap: true, size: "Medium" });
  const line = (text: string) => ({ type: "TextBlock", text, wrap: true });
  const rich = (text: string, extra: object = {}) => ({
    type: "RichTextBlock",
    inlines: [{ type: "TextRun", text, ...extra }],
  });
  const openUrl = (title: string, url: string) => ({ type: "Action.OpenUrl", title, url });
  const reviewAction = (id: string) => openUrl("View review", `${env.CLIENT_ORIGIN}/reviews/${id}`);
  const prAction = openUrl("Open PR", "https://github.com/acme/web/pull/7");
  const teamsCard = (body: unknown[], actions: unknown[]) => ({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
          actions,
        },
      },
    ],
  });
  const cardOf = (raw: string) =>
    JSON.parse(raw).attachments[0].content as {
      body: { type: string; text?: string; inlines?: { type: string; text: string }[] }[];
      actions: unknown[];
    };

  it("posts a failed review to Teams as an Adaptive Card with its error and a review action", async () => {
    const stub = teamsStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("teams", ["failed"], TEAMS_URL);
    const job = await finishedJob("failed", "error", "No API key for anthropic");

    await notifyAndSend(job.id);

    expect(stub.calls[0]!.url).toBe(TEAMS_URL);
    // No signature headers: the URL is the credential.
    expect(Object.keys(stub.calls[0]!.headers).filter((name) => name.startsWith("x-sentryward"))).toEqual([]);
    // A failed review has no summary, so no change URL and no PR action.
    expect(JSON.parse(stub.calls[0]!.body!)).toEqual(
      teamsCard([heading("⚠️ Review failed"), rich("acme/web #7"), rich("No API key for anthropic")], [reviewAction(job.id)]),
    );
  });

  it("posts a blocked review to Teams with its title, the severities and a PR action", async () => {
    const stub = teamsStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("teams", ["blocked"], TEAMS_URL);
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    expect(JSON.parse(stub.calls[0]!.body!)).toEqual(
      teamsCard(
        [
          heading("\u{1F534} Review blocked"),
          rich("acme/web #7"),
          rich("Add login", { weight: "Bolder" }),
          line("3 findings (1 major · 2 minor)"),
        ],
        [reviewAction(job.id), prAction],
      ),
    );
  });

  it.each([
    ["no change URL", undefined],
    ["a change URL that is not http(s)", "javascript:alert(1)"],
    ["a change URL too long to send", `https://github.com/acme/web/pull/7?${"x".repeat(4000)}`],
  ])("leaves the Teams PR action out with %s", async (_label, webUrl) => {
    const stub = teamsStub();
    vi.stubGlobal("fetch", stub.fetch);
    await target("teams", ["blocked"], TEAMS_URL);
    const job = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 7,
        headSha: "aaa",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, webUrl },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(job.id);

    expect(cardOf(stub.calls[0]!.body!).actions).toEqual([reviewAction(job.id)]);
  });

  it("sends a test notification to Teams", async () => {
    const stub = teamsStub();
    vi.stubGlobal("fetch", stub.fetch);
    const teams = await target("teams", ["failed"], TEAMS_URL);

    expect(await testTarget(teams)).toEqual({ ok: true });

    expect(JSON.parse(stub.calls[0]!.body!)).toEqual(
      teamsCard(
        [
          heading("\u{1F514} Test notification"),
          rich("example/repository #1"),
          rich("Test notification from Sentryward", { weight: "Bolder" }),
          line("0 findings"),
        ],
        [openUrl("View review", `${env.CLIENT_ORIGIN}/reviews`)],
      ),
    );
  });

  // A TextBlock renders markdown, so its syntax is added to the Slack list.
  const TEAMS_HOSTILE = [...HOSTILE, "[Approve](https://evil.example) **bold** _italic_\n- item\n1. step <at>Everyone</at>"];

  it.each(TEAMS_HOSTILE)("keeps forge text out of markdown in Teams cards: %j", async (hostile) => {
    const stub = teamsStub(2);
    vi.stubGlobal("fetch", stub.fetch);
    await target("teams", ["failed", "blocked"], TEAMS_URL);
    const blocked = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 8,
        headSha: "bbb",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, title: hostile },
        finishedAt: new Date(),
      },
    });
    const failed = await finishedJob("failed", "error", hostile);

    await notifyAndSend(blocked.id);
    await notifyAndSend(failed.id);

    const flat = hostile.replace(/\s+/g, " ").trim();
    const jobs = [blocked, failed];
    stub.calls.forEach((call, i) => {
      const { body, actions } = cardOf(call.body!);
      // Only these two element types, and every TextBlock (which renders
      // markdown) is one of our own lines.
      expect(new Set(body.map((element) => element.type))).toEqual(new Set(["TextBlock", "RichTextBlock"]));
      const blocks = body.flatMap((element) => (element.type === "TextBlock" ? [element.text] : []));
      expect(blocks).toEqual(
        i === 0 ? ["\u{1F534} Review blocked", "3 findings (1 major · 2 minor)"] : ["⚠️ Review failed"],
      );
      // The forge text is there, in a run that shows it as written.
      const runs = body.flatMap((element) => element.inlines ?? []);
      for (const run of runs) expect(run.type).toBe("TextRun");
      expect(runs.map((run) => run.text.replaceAll("​", ""))).toContain(flat);
      for (const run of runs) {
        expect(run.text).not.toContain("\n");
        // Nothing left that a client would link: no scheme and no dotted name.
        expect(run.text).not.toMatch(/:\/\/(?!​)|\w\.\w/);
      }
      // Actions open our review and the checked change URL, nothing else.
      expect(actions).toEqual(i === 0 ? [reviewAction(jobs[i]!.id), prAction] : [reviewAction(jobs[i]!.id)]);
    });
  });

  it("clips long forge text in a Teams card, inside the message size limit and without cutting an emoji", async () => {
    const stub = teamsStub(2);
    vi.stubGlobal("fetch", stub.fetch);
    await target("teams", ["failed"], TEAMS_URL);
    // A control character is six bytes once JSON escapes it: the worst case.
    await notifyAndSend((await finishedJob("failed", "error", "\u0001".repeat(5000))).id);
    // The emoji's two code units sit either side of the 1000-character cut.
    await notifyAndSend((await finishedJob("failed", "error", `${"x".repeat(998)}\u{1F600}${"y".repeat(50)}`)).id);

    expect(cardOf(stub.calls[0]!.body!).body[2]!.inlines![0]!.text).toHaveLength(1000);
    expect(Buffer.byteLength(stub.calls[0]!.body!)).toBeLessThan(28_000);
    expect(stub.calls[1]!.body!).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    expect(cardOf(stub.calls[1]!.body!).body[2]!.inlines![0]!.text).toBe(`${"x".repeat(998)}…`);
  });

  it("never stores a Teams URL's signature in an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`request to ${TEAMS_URL} failed; sig=teams-sig-value`);
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target("teams", ["completed"], TEAMS_URL);

    await notifyAndSend((await finishedJob("completed", "pass")).id);

    const row = await prisma.notificationDelivery.findFirstOrThrow();
    expect(row.error).not.toMatch(/teams-sig-value|0123456789abcdef/);
  });

  it("does not notify skipped or cancelled jobs", async () => {
    const stub = fetchStub([]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("webhook", ["blocked", "failed", "completed"]);

    await notifyAndSend((await finishedJob("skipped", null)).id);
    await notifyAndSend((await finishedJob("cancelled", null)).id);

    expect(stub.calls).toHaveLength(0);
  });

  it("queues a row per target without sending anything itself", async () => {
    const stub = fetchStub([]);
    vi.stubGlobal("fetch", stub.fetch);
    const hook = await target("webhook", ["completed"]);
    const job = await finishedJob("completed", "pass");

    await notifyJob(job.id);
    await notifyJob(job.id);

    expect(stub.calls).toHaveLength(0);
    expect(await prisma.notificationDelivery.findMany()).toMatchObject([
      { targetId: hook.id, jobId: job.id, event: "completed", status: "pending", attempts: 0, finishedAt: null },
    ]);
  });

  it("notifies a job once", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("webhook", ["failed"]);
    const job = await finishedJob("failed", "error", "Worker stopped responding");

    await notifyAndSend(job.id);
    await notifyAndSend(job.id);

    expect(stub.calls).toHaveLength(1);
  });

  it("logs a failed delivery, still delivers to the other targets and leaves the job alone", async () => {
    const stub = fetchStub([
      { method: "POST", url: /broken\.example\.com/, status: 500 },
      { method: "POST", url: /hooks\.example\.com/ },
    ]);
    vi.stubGlobal("fetch", stub.fetch);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await target("webhook", ["failed"], "https://broken.example.com/sw");
    await target("slack", ["failed"]);
    const job = await finishedJob("failed", "error", "Forge unreachable");

    await expect(notifyAndSend(job.id)).resolves.toBeUndefined();

    expect(stub.calls.map((call) => call.url)).toEqual(
      expect.arrayContaining(["https://broken.example.com/sw", "https://hooks.example.com/sw"]),
    );
    expect(errors).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^\\[notify\\] target ${broken.id} delivery \\S+ attempt 1 failed \\(HTTP 500\\); retrying at `)),
    );
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "failed",
      error: "Forge unreachable",
    });
  });

  it("logs a delivery that throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const hook = await target("webhook", ["completed"]);
    const job = await finishedJob("completed", "pass");

    await notifyAndSend(job.id);

    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`[notify] target ${hook.id} delivery `));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("attempt 1 failed (getaddrinfo ENOTFOUND)"));
  });

  it("emails only recipients who are still members", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    const { user: gone } = await createUser("gone@example.com");
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["blocked"], recipientIds: [userId, gone.id] },
    });
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    expect(send).toHaveBeenCalledTimes(1);
    const reviewUrl = `${env.CLIENT_ORIGIN}/reviews/${job.id}`;
    expect(send).toHaveBeenCalledWith({
      to: "dev@example.com",
      subject: 'Review blocked: acme/web#7 "Add login" - 3 findings',
      text: [
        "Review blocked",
        "acme/web #7",
        "Add login",
        "3 findings (1 major · 2 minor)",
        "",
        `Review: ${reviewUrl}`,
        "Pull request: https://github.com/acme/web/pull/7",
        "",
        'You get this as a recipient of "Leads".',
        "",
      ].join("\n"),
      html: expect.any(String),
    });
    const { html } = send.mock.calls[0]![0];
    expect(html).toContain(`href="${escapeHtml(reviewUrl)}"`);
    expect(html).toContain('href="https://github.com/acme/web/pull/7"');
    expect(html).toContain(">Open pull request</a>");
    expect(html).toContain("1 major · 2 minor");
    expect(html).toContain("You get this as a recipient of &quot;Leads&quot;.");
  });

  it("escapes forge text in the HTML part and leaves out a link it cannot trust", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "<b>Leads</b>", events: ["blocked"], recipientIds: [userId] },
    });
    const job = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 7,
        headSha: "aaa",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, title: '<script>alert("x")</script> & <a href="https://evil.example">', webUrl: "javascript:alert(1)" },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(job.id);

    const { html, text } = send.mock.calls[0]![0];
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(html).toContain("&lt;b&gt;Leads&lt;/b&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Open pull request");
    // Only our two kinds of link, and here only the review's.
    expect(html!.match(/href="/g)).toHaveLength(1);
    expect(text).not.toContain("Pull request:");
  });

  it("sends a failed review's error in both parts", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["failed"], recipientIds: [userId] },
    });
    const job = await finishedJob("failed", "error", "No <API> key");

    await notifyAndSend(job.id);

    const { html, text } = send.mock.calls[0]![0];
    expect(text).toContain("\nNo <API> key\n");
    expect(html).toContain("No &lt;API&gt; key");
  });

  it("keeps an email subject on one line whatever the error holds", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["failed"], recipientIds: [userId] },
    });
    const job = await finishedJob("failed", "error", "boom\r\n\nBcc: x@evil.example");

    await notifyAndSend(job.id);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Review failed: acme/web#7 - boom Bcc: x@evil.example" }),
    );
  });

  it("clips a huge title and error in the subject and both parts", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["failed", "blocked"], recipientIds: [userId] },
    });
    const failed = await finishedJob("failed", "error", "e".repeat(10_000));
    const blocked = await prisma.reviewJob.create({
      data: {
        repositoryId,
        number: 8,
        headSha: "bbb",
        trigger: "manual",
        status: "completed",
        verdict: "blocked",
        summary: { ...summary, title: "t".repeat(10_000) },
        finishedAt: new Date(),
      },
    });

    await notifyAndSend(failed.id);
    await notifyAndSend(blocked.id);

    for (const [mail] of send.mock.calls) {
      expect(mail.subject.length).toBeLessThanOrEqual(200);
      expect(mail.text.length).toBeLessThan(3000);
      expect(mail.html!.length).toBeLessThan(4000);
      expect(mail.text).toContain("…");
    }
  });
});

describe("delivery log", () => {
  function deliveries() {
    return prisma.notificationDelivery.findMany({ orderBy: { createdAt: "asc" } });
  }

  it("records each delivery of a job with its outcome", async () => {
    const stub = fetchStub([
      { method: "POST", url: /broken\.example\.com/, status: 503 },
      { method: "POST", url: /hooks\.example\.com/ },
    ]);
    vi.stubGlobal("fetch", stub.fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const good = await target("slack", ["blocked"]);
    const broken = await target("webhook", ["completed"], "https://broken.example.com/sw");
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.targetId === good.id)).toMatchObject({
      jobId: job.id,
      event: "blocked",
      status: "sent",
      httpStatus: null,
      error: null,
      attempts: 1,
    });
    // A 503 is worth another try: the row waits for it, showing why.
    expect(rows.find((row) => row.targetId === broken.id)).toMatchObject({
      jobId: job.id,
      event: "completed",
      status: "pending",
      httpStatus: 503,
      // The status says it all; only failures without one store a message.
      error: null,
      attempts: 1,
      finishedAt: null,
    });
  });

  it("records an email delivery that fails without an HTTP status", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    vi.spyOn(mailer, "send").mockRejectedValue(new Error("SMTP down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["failed"], recipientIds: [userId] },
    });
    const job = await finishedJob("failed", "error", "boom");

    await notifyAndSend(job.id);

    // No one got it, so sending again cannot mail anyone twice.
    expect(await deliveries()).toMatchObject([
      { status: "pending", httpStatus: null, error: "1 of 1 emails could not be sent" },
    ]);
  });

  it("never stores the target URL in an error", async () => {
    const url = "https://hooks.example.com/services/T000/B000/secret-token?key=hush";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`request to ${url} failed; path /services/T000/B000/secret-token key=hush`);
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target("slack", ["completed"], url);
    const job = await finishedJob("completed", "pass");

    await notifyAndSend(job.id);

    const [row] = await deliveries();
    expect(row!.error).not.toMatch(/secret-token|hush/);
    expect(row!.error).toBe("request to [redacted] failed; path [redacted] [redacted]");
  });

  it("records an email target with no remaining members as failed", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { user: gone } = await createUser("gone@example.com");
    await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["failed"], recipientIds: [gone.id] },
    });
    const job = await finishedJob("failed", "error", "boom");

    await notifyAndSend(job.id);

    expect(send).not.toHaveBeenCalled();
    expect(await deliveries()).toMatchObject([
      {
        status: "failed",
        httpStatus: null,
        error: "None of this target's recipients are members of the workspace any more",
      },
    ]);
  });

  it("redacts pieces of the URL that appear on their own", () => {
    const url = "https://bot:hunter22pass@hooks.example.com/api/webhooks/123/tok3nSecretValue?token=abc12345xyz&mode=x";
    const error = [
      "token=abc12345xyz",
      "abc12345xyz",
      "hunter22pass",
      "bot:hunter22pass",
      "tok3nSecretValue",
      "mode=x",
    ].join(" | ");
    expect(redactError(error, url)).toBe("[redacted] | [redacted] | [redacted] | [redacted] | [redacted] | mode=x");

    const encoded = "https://hooks.example.com/in?sig=a%2Fb%2Bc%3Dd123";
    expect(redactError("bad signature a/b+c=d123", encoded)).toBe("bad signature [redacted]");
  });

  it("flattens and clips stored errors", () => {
    expect(redactError("a\n\nb", null)).toBe("a b");
    expect(redactError("x".repeat(600), null)).toHaveLength(500);
    expect(redactError("   ", null)).toBe("Unknown error");
  });

  it("still answers a test when the delivery cannot be recorded", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.notificationDelivery, "create").mockRejectedValue(new Error("db down"));
    const hook = await target("webhook", ["completed"]);

    const res = await request(app).post(`/api/notifications/${hook.id}/test`).set("Cookie", cookie);

    expect(res.body.result).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(`[notify] could not record a delivery to target ${hook.id}`, expect.any(Error));
  });

  it("records test deliveries without a job", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/, status: 410 }]);
    vi.stubGlobal("fetch", stub.fetch);
    const hook = await target("slack", ["failed"]);

    const res = await request(app).post(`/api/notifications/${hook.id}/test`).set("Cookie", cookie);

    expect(res.body.result).toEqual({ ok: false, error: "Responded with 410" });
    expect(await deliveries()).toMatchObject([
      { targetId: hook.id, jobId: null, event: "test", status: "failed", httpStatus: 410 },
    ]);
  });

  it("lists each target's last delivery", async () => {
    const hook = await target("webhook", ["failed"]);
    const quiet = await target("slack", ["failed"]);
    const base = { targetId: hook.id, event: "failed", finishedAt: new Date() };
    await prisma.notificationDelivery.create({
      data: { ...base, status: "sent", createdAt: new Date("2026-11-01T00:00:00Z") },
    });
    await prisma.notificationDelivery.create({
      data: { ...base, status: "failed", httpStatus: 503, createdAt: new Date("2026-11-02T00:00:00Z") },
    });

    const res = await request(app).get("/api/notifications").set("Cookie", cookie);

    const byId = Object.fromEntries(res.body.targets.map((t: { id: string }) => [t.id, t]));
    expect(byId[hook.id].lastDelivery).toEqual({
      status: "failed",
      event: "failed",
      httpStatus: 503,
      error: null,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: "2026-11-02T00:00:00.000Z",
    });
    expect(byId[quiet.id].lastDelivery).toBeNull();
  });

  it("agrees with the history on the newest delivery when two share a start time", async () => {
    const hook = await target("webhook", ["failed"]);
    const createdAt = new Date("2026-11-02T00:00:00Z");
    for (const status of ["sent", "failed"] as const) {
      await prisma.notificationDelivery.create({
        data: { targetId: hook.id, event: "failed", status, createdAt, finishedAt: createdAt },
      });
    }

    const list = await request(app).get("/api/notifications").set("Cookie", cookie);
    const history = await request(app).get(`/api/notifications/${hook.id}/deliveries`).set("Cookie", cookie);

    expect(list.body.targets[0].lastDelivery.status).toBe(history.body.deliveries[0].status);
  });

  it("returns the last delivery from PATCH", async () => {
    const hook = await target("webhook", ["failed"]);
    await prisma.notificationDelivery.create({
      data: { targetId: hook.id, event: "test", status: "sent", createdAt: new Date("2026-11-02T00:00:00Z"), finishedAt: new Date() },
    });

    const res = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: false });

    expect(res.body.target.lastDelivery).toMatchObject({ status: "sent", event: "test", createdAt: "2026-11-02T00:00:00.000Z" });
  });

  it("pages a target's history newest first, for members too, within the workspace", async () => {
    const hook = await target("webhook", ["failed"]);
    for (let day = 1; day <= 3; day++) {
      await prisma.notificationDelivery.create({
        data: {
          targetId: hook.id,
          event: "failed",
          status: "sent",
          attempts: 1,
          createdAt: new Date(`2026-11-0${day}T00:00:00Z`),
          finishedAt: new Date(`2026-11-0${day}T00:00:01Z`),
        },
      });
    }
    const { user: member, cookie: memberCookie } = await createUser("member@example.com");
    await addMember(workspaceId, member.id, "member");

    const first = await request(app)
      .get(`/api/notifications/${hook.id}/deliveries?limit=2`)
      .set("Cookie", memberCookie)
      .set(...inWorkspace(workspaceId));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(first.body.deliveries.map((d: { createdAt: string }) => d.createdAt)).toEqual([
      "2026-11-03T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
    ]);
    expect(first.body.deliveries[0]).toEqual({
      id: expect.any(String),
      event: "failed",
      status: "sent",
      httpStatus: null,
      error: null,
      attempts: 1,
      nextAttemptAt: null,
      jobId: null,
      createdAt: "2026-11-03T00:00:00.000Z",
      finishedAt: "2026-11-03T00:00:01.000Z",
    });

    const second = await request(app).get(`/api/notifications/${hook.id}/deliveries?page=2&limit=2`).set("Cookie", cookie);
    expect(second.body.deliveries).toHaveLength(1);

    const { cookie: otherCookie } = await createUser("other@example.com");
    const hidden = await request(app).get(`/api/notifications/${hook.id}/deliveries`).set("Cookie", otherCookie);
    expect(hidden.status).toBe(404);
  });

  it("drops a target's deliveries with it", async () => {
    const hook = await target("webhook", ["failed"]);
    await prisma.notificationDelivery.create({
      data: { targetId: hook.id, event: "test", status: "sent", finishedAt: new Date() },
    });

    await request(app).delete(`/api/notifications/${hook.id}`).set("Cookie", cookie).expect(204);

    expect(await prisma.notificationDelivery.count()).toBe(0);
  });
});

describe("/api/notifications", () => {
  it("lets an admin add a webhook, returning its secret once and only the host afterwards", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(false);
    const res = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "webhook", name: "CI", events: ["failed", "blocked"], url: "https://hooks.example.com/sw?key=1" });

    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.target).toMatchObject({ kind: "webhook", name: "CI", events: ["failed", "blocked"], host: "hooks.example.com" });
    const stored = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: res.body.target.id } });
    expect(decrypt(stored.encryptedSecret!)).toBe(res.body.secret);
    expect(decrypt(stored.encryptedUrl!)).toBe("https://hooks.example.com/sw?key=1");

    const list = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(list.body.targets).toHaveLength(1);
    expect(list.body.mailConfigured).toBe(false);
    expect(JSON.stringify(list.body)).not.toContain("key=1");
    expect(list.body.targets[0]).not.toHaveProperty("secret");
  });

  it("validates the target by kind", async () => {
    const noEvents = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "slack", name: "Team", events: [], url: "https://hooks.slack.com/x" });
    expect(noEvents.status).toBe(400);
    expect(noEvents.body.errors.events).toBeDefined();

    const badUrl = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "webhook", name: "CI", events: ["failed"], url: "ftp://example.com" });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.errors.url).toBeDefined();
  });

  it("rejects private URLs in production", async () => {
    const original = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      for (const url of ["https://127.0.0.1/hook", "https://[::1]/hook", "http://hooks.example.com/hook"]) {
        const res = await request(app)
          .post("/api/notifications")
          .set("Cookie", cookie)
          .send({ kind: "webhook", name: "CI", events: ["failed"], url });
        expect(res.status, url).toBe(400);
        expect(res.body.errors.url, url).toBeDefined();
      }
    } finally {
      env.NODE_ENV = original;
    }
    expect(await prisma.notificationTarget.count()).toBe(0);
  });

  it("adds a Google Chat target, showing only its host and no secret", async () => {
    const url = "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=chat-key-value&token=chat-token-value";
    const res = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "google_chat", name: "Space", events: ["blocked"], url });

    expect(res.status).toBe(201);
    expect(res.body.secret).toBeUndefined();
    expect(res.body.target).toMatchObject({ kind: "google_chat", name: "Space", host: "chat.googleapis.com" });
    expect(JSON.stringify(res.body)).not.toMatch(/chat-key-value|chat-token-value|AAAA/);
    const stored = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: res.body.target.id } });
    expect(stored.encryptedUrl).not.toContain("chat-token-value");
    expect(decrypt(stored.encryptedUrl!)).toBe(url);
    expect(stored.encryptedSecret).toBeNull();

    const list = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(JSON.stringify(list.body)).not.toMatch(/chat-key-value|chat-token-value|AAAA/);

    const edited = await request(app)
      .patch(`/api/notifications/${stored.id}`)
      .set("Cookie", cookie)
      .send({ url: url.replace("AAAA", "BBBB") });
    expect(edited.status).toBe(200);
    const removed = await request(app).delete(`/api/notifications/${stored.id}`).set("Cookie", cookie);
    expect(removed.status).toBeLessThan(300);
  });

  it.each([
    [
      "discord",
      "https://discord.com/api/webhooks/123456789012345678/discord-token-value",
      "discord.com",
      /discord-token-value|123456789012345678/,
    ],
    [
      "teams",
      "https://prod-12.westeurope.logic.azure.com:443/workflows/0123456789abcdef/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=teams-sig-value",
      "prod-12.westeurope.logic.azure.com",
      /teams-sig-value|0123456789abcdef/,
    ],
  ] as const)("adds, pauses, edits and removes a %s target, showing only its host and no secret", async (kind, url, host, secret) => {
    const res = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind, name: "Channel", events: ["blocked"], url });

    expect(res.status).toBe(201);
    expect(res.body.secret).toBeUndefined();
    expect(res.body.target).toMatchObject({ kind, name: "Channel", host, active: true });
    expect(JSON.stringify(res.body)).not.toMatch(secret);
    const stored = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: res.body.target.id } });
    expect(stored.encryptedUrl).not.toMatch(secret);
    expect(decrypt(stored.encryptedUrl!)).toBe(url);
    expect(stored.encryptedSecret).toBeNull();

    const list = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(JSON.stringify(list.body)).not.toMatch(secret);

    const paused = await request(app).patch(`/api/notifications/${stored.id}`).set("Cookie", cookie).send({ active: false });
    expect(paused.status).toBe(200);
    expect(paused.body.target.active).toBe(false);
    const edited = await request(app)
      .patch(`/api/notifications/${stored.id}`)
      .set("Cookie", cookie)
      .send({ url: `${url}2`, active: true });
    expect(edited.status).toBe(200);
    expect(decrypt((await prisma.notificationTarget.findUniqueOrThrow({ where: { id: stored.id } })).encryptedUrl!)).toBe(`${url}2`);
    // A webhook's secret is not something these kinds have to rotate.
    const rotated = await request(app).post(`/api/notifications/${stored.id}/rotate-secret`).set("Cookie", cookie);
    expect(rotated.status).toBe(400);
    const removed = await request(app).delete(`/api/notifications/${stored.id}`).set("Cookie", cookie);
    expect(removed.status).toBeLessThan(300);
    expect(await prisma.notificationTarget.count()).toBe(0);
  });

  it("adds email targets only for members, and only with mail configured", async () => {
    const { user: outsider } = await createUser("outsider@example.com");
    vi.spyOn(mailer, "configured").mockReturnValue(false);
    const unconfigured = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "email", name: "Leads", events: ["blocked"], recipientIds: [userId] });
    expect(unconfigured.status).toBe(400);

    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const notMember = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "email", name: "Leads", events: ["blocked"], recipientIds: [outsider.id] });
    expect(notMember.status).toBe(400);
    expect(notMember.body.errors.recipientIds).toBeDefined();

    const ok = await request(app)
      .post("/api/notifications")
      .set("Cookie", cookie)
      .send({ kind: "email", name: "Leads", events: ["blocked"], recipientIds: [userId] });
    expect(ok.status).toBe(201);
    expect(ok.body.target).toMatchObject({ kind: "email", host: null, recipientIds: [userId] });
  });

  it("updates a target's events and removes it", async () => {
    const hook = await target("webhook", ["failed"]);

    const patched = await request(app)
      .patch(`/api/notifications/${hook.id}`)
      .set("Cookie", cookie)
      .send({ events: ["completed", "failed"] });
    expect(patched.status).toBe(200);
    expect(patched.body.target.events).toEqual(["failed", "completed"]);

    const removed = await request(app).delete(`/api/notifications/${hook.id}`).set("Cookie", cookie);
    expect(removed.status).toBe(204);
    expect(await prisma.notificationTarget.count()).toBe(0);
  });

  it("pauses and resumes a target, which still takes test deliveries while paused", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    const hook = await target("webhook", ["failed"]);

    const list = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(list.body.targets[0].active).toBe(true);

    const paused = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: false });
    expect(paused.status).toBe(200);
    expect(paused.body.target).toMatchObject({ active: false, events: ["failed"], name: "webhook" });

    const tested = await request(app).post(`/api/notifications/${hook.id}/test`).set("Cookie", cookie);
    expect(tested.body.result).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(1);

    const resumed = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: true });
    expect(resumed.body.target.active).toBe(true);

    const invalid = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ active: "no" });
    expect(invalid.status).toBe(400);
  });

  it("reports a test delivery's outcome", async () => {
    const stub = fetchStub([
      { method: "POST", url: /hooks\.example\.com/ },
      { method: "POST", url: /broken\.example\.com/, status: 404 },
    ]);
    vi.stubGlobal("fetch", stub.fetch);
    const good = await target("webhook", ["failed"]);
    const bad = await target("slack", ["failed"], "https://broken.example.com/x");

    const ok = await request(app).post(`/api/notifications/${good.id}/test`).set("Cookie", cookie);
    expect(ok.body.result).toEqual({ ok: true });
    expect(JSON.parse(stub.calls[0]!.body!).event).toBe("test");
    expect(stub.calls[0]!.headers["x-sentryward-signature"]).toBe(signature("shh", stub.calls[0]!.body!));

    const failed = await request(app).post(`/api/notifications/${bad.id}/test`).set("Cookie", cookie);
    expect(failed.status).toBe(200);
    expect(failed.body.result).toEqual({ ok: false, error: "Responded with 404" });
  });

  it("lets members list but not change targets", async () => {
    const hook = await target("webhook", ["failed"]);
    const { user: member, cookie: memberCookie } = await createUser("member@example.com");
    await addMember(workspaceId, member.id, "member");
    const header = inWorkspace(workspaceId);

    const list = await request(app).get("/api/notifications").set("Cookie", memberCookie).set(...header);
    expect(list.status).toBe(200);
    expect(list.body.targets).toHaveLength(1);

    for (const call of [
      request(app).post("/api/notifications").send({ kind: "slack", name: "x", events: ["failed"], url: "https://a.b/c" }),
      request(app).patch(`/api/notifications/${hook.id}`).send({ name: "x" }),
      request(app).patch(`/api/notifications/${hook.id}`).send({ active: false }),
      request(app).patch(`/api/notifications/${hook.id}`).send({ url: "https://elsewhere.example.com/x" }),
      request(app).post(`/api/notifications/${hook.id}/test`),
      request(app).post(`/api/notifications/${hook.id}/rotate-secret`),
      request(app).delete(`/api/notifications/${hook.id}`),
    ]) {
      const res = await call.set("Cookie", memberCookie).set(...header);
      expect(res.status).toBe(403);
    }
    const stored = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: hook.id } });
    expect(stored.active).toBe(true);
    expect(decrypt(stored.encryptedUrl!)).toBe("https://hooks.example.com/sw");
    expect(decrypt(stored.encryptedSecret!)).toBe("shh");
    expect(stored.encryptedPreviousSecret).toBeNull();
  });

  it("hides another workspace's targets", async () => {
    const hook = await target("webhook", ["failed"]);
    const { cookie: otherCookie } = await createUser("other@example.com");

    const list = await request(app).get("/api/notifications").set("Cookie", otherCookie);
    expect(list.body.targets).toEqual([]);
    const removed = await request(app).delete(`/api/notifications/${hook.id}`).set("Cookie", otherCookie);
    expect(removed.status).toBe(404);
    const tested = await request(app).post(`/api/notifications/${hook.id}/test`).set("Cookie", otherCookie);
    expect(tested.status).toBe(404);
  });
});

describe("editing a target's URL and rotating its secret", () => {
  it("changes a webhook or Slack URL in place, keeping its settings and secret", async () => {
    const hook = await target("webhook", ["failed", "blocked"]);
    const slack = await target("slack", ["failed"], "https://hooks.slack.com/services/T/B/old");

    const res = await request(app)
      .patch(`/api/notifications/${hook.id}`)
      .set("Cookie", cookie)
      .send({ url: "https://new.example.com/hook?token=abc" });
    expect(res.status).toBe(200);
    expect(res.body.target).toMatchObject({ host: "new.example.com", events: ["failed", "blocked"], name: "webhook" });
    expect(JSON.stringify(res.body)).not.toContain("token=abc");
    const stored = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: hook.id } });
    expect(decrypt(stored.encryptedUrl!)).toBe("https://new.example.com/hook?token=abc");
    expect(decrypt(stored.encryptedSecret!)).toBe("shh");

    const slackRes = await request(app)
      .patch(`/api/notifications/${slack.id}`)
      .set("Cookie", cookie)
      .send({ url: "https://hooks.slack.com/services/T/B/new" });
    expect(slackRes.status).toBe(200);
    const storedSlack = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: slack.id } });
    expect(decrypt(storedSlack.encryptedUrl!)).toBe("https://hooks.slack.com/services/T/B/new");
  });

  it("sends queued deliveries to the new URL", async () => {
    const stub = fetchStub([{ method: "POST", url: /example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    const hook = await target("webhook", ["completed"]);
    const job = await finishedJob("completed", "pass");
    await notifyJob(job.id);

    await request(app)
      .patch(`/api/notifications/${hook.id}`)
      .set("Cookie", cookie)
      .send({ url: "https://moved.example.com/hook" })
      .expect(200);
    for (const id of await claimDueDeliveries(100)) await runDelivery(id);

    expect(stub.calls.map((call) => call.url)).toEqual(["https://moved.example.com/hook"]);
  });

  it("refuses an unsafe URL, a URL that is not http(s), and a URL for an email target", async () => {
    const hook = await target("webhook", ["failed"]);
    const email = await prisma.notificationTarget.create({
      data: { workspaceId, kind: "email", name: "Leads", events: ["failed"], recipientIds: [userId] },
    });

    const notHttp = await request(app).patch(`/api/notifications/${hook.id}`).set("Cookie", cookie).send({ url: "ftp://x.y/z" });
    expect(notHttp.status).toBe(400);
    expect(notHttp.body.errors.url).toBeDefined();

    const original = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const unsafe = await request(app)
        .patch(`/api/notifications/${hook.id}`)
        .set("Cookie", cookie)
        .send({ url: "https://127.0.0.1/hook" });
      expect(unsafe.status).toBe(400);
      expect(unsafe.body.errors.url).toBeDefined();
    } finally {
      env.NODE_ENV = original;
    }

    const forEmail = await request(app)
      .patch(`/api/notifications/${email.id}`)
      .set("Cookie", cookie)
      .send({ url: "https://hooks.example.com/x" });
    expect(forEmail.status).toBe(400);
    expect(forEmail.body.errors.url).toEqual(["Email targets have no URL"]);

    const stored = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: hook.id } });
    expect(decrypt(stored.encryptedUrl!)).toBe("https://hooks.example.com/sw");
    expect((await prisma.notificationTarget.findUniqueOrThrow({ where: { id: email.id } })).encryptedUrl).toBeNull();
  });

  it("rotates a webhook secret, returning the new one once and keeping the old one for the grace period", async () => {
    const hook = await target("webhook", ["failed"]);
    const before = Date.now();

    const res = await request(app).post(`/api/notifications/${hook.id}/rotate-secret`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[0-9a-f]{64}$/);
    const stored = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: hook.id } });
    expect(decrypt(stored.encryptedSecret!)).toBe(res.body.secret);
    expect(decrypt(stored.encryptedPreviousSecret!)).toBe("shh");
    const expires = stored.previousSecretExpiresAt!.getTime();
    expect(expires).toBeGreaterThanOrEqual(before + SECRET_GRACE_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + SECRET_GRACE_MS);
    expect(res.body.target.secretRotatedUntil).toBe(stored.previousSecretExpiresAt!.toISOString());

    const list = await request(app).get("/api/notifications").set("Cookie", cookie);
    expect(JSON.stringify(list.body)).not.toContain(res.body.secret);
    expect(list.body.targets[0].secretRotatedUntil).toBe(stored.previousSecretExpiresAt!.toISOString());
  });

  it("starts the failure count again when the URL changes", async () => {
    const hook = await target("webhook", ["failed"]);
    await prisma.notificationTarget.update({ where: { id: hook.id }, data: { consecutiveFailures: 4 } });

    const res = await request(app)
      .patch(`/api/notifications/${hook.id}`)
      .set("Cookie", cookie)
      .send({ url: "https://new.example.com/hook" });

    expect(res.status).toBe(200);
    expect((await prisma.notificationTarget.findUniqueOrThrow({ where: { id: hook.id } })).consecutiveFailures).toBe(0);
  });

  it("refuses a rotation when another one lands between reading and writing the secret", async () => {
    const hook = await target("webhook", ["failed"]);
    const updateMany = prisma.notificationTarget.updateMany.bind(prisma.notificationTarget);
    // The other rotation, committed after this request read the target.
    const raced = (async (args: Parameters<typeof updateMany>[0]) => {
      await prisma.notificationTarget.update({ where: { id: hook.id }, data: { encryptedSecret: encrypt("other") } });
      return updateMany(args);
    }) as unknown as typeof updateMany;
    vi.spyOn(prisma.notificationTarget, "updateMany").mockImplementationOnce(raced);

    const res = await request(app).post(`/api/notifications/${hook.id}/rotate-secret`).set("Cookie", cookie);

    expect(res.status).toBe(409);
    expect(res.body.secret).toBeUndefined();
    expect(decrypt((await prisma.notificationTarget.findUniqueOrThrow({ where: { id: hook.id } })).encryptedSecret!)).toBe(
      "other",
    );
  });

  it("keeps only the secret just replaced when rotated twice", async () => {
    const hook = await target("webhook", ["failed"]);
    const first = await request(app).post(`/api/notifications/${hook.id}/rotate-secret`).set("Cookie", cookie);
    const second = await request(app).post(`/api/notifications/${hook.id}/rotate-secret`).set("Cookie", cookie);

    const stored = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: hook.id } });
    expect(decrypt(stored.encryptedSecret!)).toBe(second.body.secret);
    expect(decrypt(stored.encryptedPreviousSecret!)).toBe(first.body.secret);
  });

  it("only rotates webhooks in the workspace", async () => {
    const slack = await target("slack", ["failed"]);
    const refused = await request(app).post(`/api/notifications/${slack.id}/rotate-secret`).set("Cookie", cookie);
    expect(refused.status).toBe(400);

    const hook = await target("webhook", ["failed"]);
    const { cookie: otherCookie } = await createUser("other@example.com");
    const elsewhere = await request(app).post(`/api/notifications/${hook.id}/rotate-secret`).set("Cookie", otherCookie);
    expect(elsewhere.status).toBe(404);
    expect(decrypt((await prisma.notificationTarget.findUniqueOrThrow({ where: { id: hook.id } })).encryptedSecret!)).toBe("shh");
  });

  it("signs with both secrets during the grace period, newest first, then with the new one only", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.example\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    const now = new Date("2026-11-11T09:30:00.000Z");
    const hook = await prisma.notificationTarget.update({
      where: { id: (await target("webhook", ["completed"])).id },
      data: {
        encryptedSecret: encrypt("new"),
        encryptedPreviousSecret: encrypt("shh"),
        previousSecretExpiresAt: new Date(now.getTime() + 60_000),
      },
    });
    const job = await finishedJob("completed", "pass");
    const payload = payloadFor(job, { provider: "github", fullPath: "acme/web" }, "completed");

    await deliver(hook, workspaceId, payload, { now });
    await deliver(hook, workspaceId, payload, { now: new Date(now.getTime() + 60_000) });

    const [during, after] = stub.calls;
    const ts = during!.headers["x-sentryward-timestamp"]!;
    expect(during!.headers["x-sentryward-signature-v2"]).toBe(
      `${timestampedSignature("new", ts, during!.body!)},${timestampedSignature("shh", ts, during!.body!)}`,
    );
    expect(during!.headers["x-sentryward-signature"]).toBe(
      `${signature("new", during!.body!)},${signature("shh", during!.body!)}`,
    );
    const afterTs = after!.headers["x-sentryward-timestamp"]!;
    expect(after!.headers["x-sentryward-signature-v2"]).toBe(timestampedSignature("new", afterTs, after!.body!));
    expect(after!.headers["x-sentryward-signature"]).toBe(signature("new", after!.body!));
  });
});
