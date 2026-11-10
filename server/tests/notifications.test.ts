import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import type { NotificationEvent, ReviewStatus, ReviewVerdict } from "../src/generated/prisma/client.ts";
import { decrypt, encrypt } from "../src/lib/crypto.ts";
import { mailer } from "../src/lib/mailer.ts";
import { prisma } from "../src/lib/prisma.ts";
import { escapeSlack, eventsFor, notifyJob, redactError, signature } from "../src/services/notifications.ts";
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

function target(kind: "webhook" | "slack", events: NotificationEvent[], url = "https://hooks.example.com/sw") {
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
    expect(call!.headers["x-sentryward-signature"]).toBe(signature("shh", call!.body!));
    expect(JSON.parse(call!.body!)).toEqual({
      event: "completed",
      review: {
        id: job.id,
        url: `${env.CLIENT_ORIGIN}/reviews/${job.id}`,
        status: "completed",
        verdict: "blocked",
        error: null,
      },
      repository: { provider: "github", fullPath: "acme/web" },
      change: { number: 7, title: "Add login", url: "https://github.com/acme/web/pull/7" },
      findings: { total: 3, bySeverity: { major: 1, minor: 2 } },
    });
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

  it("posts a short Slack message linking to the review", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("slack", ["failed"], "https://hooks.slack.com/services/T/B/X");
    const job = await finishedJob("failed", "error", "No API key for anthropic");

    await notifyAndSend(job.id);

    expect(JSON.parse(stub.calls[0]!.body!)).toEqual({
      text: "Review failed: acme/web#7",
      blocks: [
        { type: "section", text: { type: "plain_text", text: "Review failed: acme/web#7", emoji: false } },
        { type: "section", text: { type: "plain_text", text: "No API key for anthropic", emoji: false } },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `<${env.CLIENT_ORIGIN}/reviews/${job.id}|View review>` }],
        },
      ],
    });
  });

  it("puts the title in its own plain-text block beside our findings count", async () => {
    const stub = fetchStub([{ method: "POST", url: /hooks\.slack\.com/ }]);
    vi.stubGlobal("fetch", stub.fetch);
    await target("slack", ["blocked"], "https://hooks.slack.com/services/T/B/X");
    const job = await finishedJob("completed", "blocked");

    await notifyAndSend(job.id);

    const { text, blocks } = JSON.parse(stub.calls[0]!.body!);
    expect(text).toBe("Review blocked: acme/web#7");
    expect(blocks.slice(0, 2)).toEqual([
      { type: "section", text: { type: "plain_text", text: "Review blocked: acme/web#7 - 3 findings", emoji: false } },
      { type: "context", elements: [{ type: "plain_text", text: "Add login", emoji: false }] },
    ]);
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
      // The only mrkdwn is the link we build.
      expect(strings.filter((s) => s.type === "mrkdwn")).toEqual([
        { type: "mrkdwn", text: `<${env.CLIENT_ORIGIN}/reviews/${jobs[i]!.id}|View review>` },
      ]);
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
    expect(send).toHaveBeenCalledWith({
      to: "dev@example.com",
      subject: 'Review blocked: acme/web#7 "Add login" - 3 findings',
      text: `Review blocked: acme/web#7 "Add login" - 3 findings\n\n${env.CLIENT_ORIGIN}/reviews/${job.id}\n`,
    });
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
      request(app).post(`/api/notifications/${hook.id}/test`),
      request(app).delete(`/api/notifications/${hook.id}`),
    ]) {
      const res = await call.set("Cookie", memberCookie).set(...header);
      expect(res.status).toBe(403);
    }
    expect((await prisma.notificationTarget.findUniqueOrThrow({ where: { id: hook.id } })).active).toBe(true);
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
