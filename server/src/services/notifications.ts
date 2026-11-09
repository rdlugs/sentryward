import { createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.ts";
import type {
  NotificationDelivery,
  NotificationEvent,
  NotificationTarget,
  Prisma,
  ReviewJob,
  ReviewStatus,
} from "../generated/prisma/client.ts";
import { DecryptError, decrypt } from "../lib/crypto.ts";
import { assertSafeUrl } from "../lib/hostSafety.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import type { ResultSummary } from "../review/render/json.ts";

export const SIGNATURE_HEADER = "X-Sentryward-Signature";
export const EVENT_HEADER = "X-Sentryward-Event";
const DELIVERY_TIMEOUT_MS = 10_000;

// Skipped, cancelled and superseded jobs never notify: nothing was reviewed.
const NOTIFIED_STATUSES: ReviewStatus[] = ["completed", "partial", "failed"];
// Most specific first; a job is delivered once per target, as the first of its
// events that target listens for.
const EVENT_ORDER: NotificationEvent[] = ["failed", "blocked", "completed"];

type JobFacts = Pick<ReviewJob, "id" | "number" | "status" | "verdict" | "error" | "summary">;

export interface NotificationPayload {
  event: NotificationEvent | "test";
  review: { id: string; url: string; status: ReviewStatus; verdict: ReviewJob["verdict"]; error: string | null };
  repository: { provider: string; fullPath: string };
  change: { number: number; title: string | null; url: string | null };
  findings: { total: number; bySeverity: ResultSummary["bySeverity"] } | null;
}

// Every event a finished job counts as. A blocked review is also a completed one.
export function eventsFor(job: Pick<ReviewJob, "status" | "verdict">): NotificationEvent[] {
  if (job.status === "failed") return ["failed"];
  if (job.status !== "completed" && job.status !== "partial") return [];
  return job.verdict === "blocked" ? ["blocked", "completed"] : ["completed"];
}

// The event a target hears about, or null when it listens for none of them.
export function eventForTarget(events: NotificationEvent[], target: Pick<NotificationTarget, "events">) {
  return EVENT_ORDER.find((event) => events.includes(event) && target.events.includes(event)) ?? null;
}

export function payloadFor(
  job: JobFacts,
  repository: { provider: string; fullPath: string },
  event: NotificationPayload["event"],
): NotificationPayload {
  const summary = job.summary as ResultSummary | null;
  return {
    event,
    review: {
      id: job.id,
      url: `${env.CLIENT_ORIGIN}/reviews/${job.id}`,
      status: job.status,
      verdict: job.verdict,
      error: job.error,
    },
    repository: { provider: repository.provider, fullPath: repository.fullPath },
    change: { number: job.number, title: summary?.title ?? null, url: summary?.webUrl ?? null },
    findings: summary ? { total: summary.total, bySeverity: summary.bySeverity } : null,
  };
}

const HEADLINES: Record<NotificationPayload["event"], string> = {
  failed: "Review failed",
  blocked: "Review blocked",
  completed: "Review completed",
  test: "Test notification",
};

// A multi-line value would spread over several lines of a Slack message (where
// a second line can pass for a headline of ours) or into an email subject.
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// The change title, the repository path and a failed review's error come from
// the forge, so anyone who can open a pull request controls them. They are
// returned raw (only flattened to one line); each target decides how to keep
// them from meaning anything in its format.
function messageParts(payload: NotificationPayload) {
  const headline = `${HEADLINES[payload.event]}: ${oneLine(payload.repository.fullPath)}#${payload.change.number}`;
  const title = payload.change.title ? oneLine(payload.change.title) : null;
  const error = payload.event === "failed" ? oneLine(payload.review.error ?? "no reason recorded") : null;
  const findings = payload.findings
    ? `${payload.findings.total} finding${payload.findings.total === 1 ? "" : "s"}`
    : null;
  return { headline, title, error, findings };
}

// Plain text, for an email subject.
function describe(payload: NotificationPayload): string {
  const { headline, title, error, findings } = messageParts(payload);
  const detail = error ?? findings;
  return `${headline}${title ? ` "${title}"` : ""}${detail ? ` - ${detail}` : ""}`;
}

// Slack rejects a plain_text object over 3000 characters.
const SLACK_TEXT_LIMIT = 2000;
function clip(value: string): string {
  return value.length > SLACK_TEXT_LIMIT ? `${value.slice(0, SLACK_TEXT_LIMIT - 1)}…` : value;
}

function plainText(text: string) {
  return { type: "plain_text", text: clip(text), emoji: false };
}

// mrkdwn cannot be escaped completely: there is no escape for `*`, `_`, `~` or
// backticks, and bare URLs are always linked. So forge text only ever goes into
// plain_text objects, and mrkdwn carries nothing but our own link. The title
// gets its own block so it cannot pass for the findings count beside it. The
// fallback `text` (shown in notifications) carries no title or error at all.
function slackMessage(payload: NotificationPayload) {
  const { headline, title, error, findings } = messageParts(payload);
  const blocks: object[] = [
    { type: "section", text: plainText(findings && !error ? `${headline} - ${findings}` : headline) },
  ];
  if (title) blocks.push({ type: "context", elements: [plainText(title)] });
  if (error) blocks.push({ type: "section", text: plainText(error) });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${payload.review.url}|View review>` }] });
  return { text: escapeSlack(headline), blocks };
}

// Slack reads `<...>` in text as a link, a mention or a command such as
// `<!channel>`. These are the three characters Slack documents escaping.
const SLACK_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export function escapeSlack(value: string): string {
  return value.replace(/[&<>]/g, (c) => SLACK_ENTITIES[c]!);
}

// "sha256=<hex>" over the exact body sent, as GitHub signs its webhooks.
export function signature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function newWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

// A delivery the far end answered with a non-2xx status.
export class DeliveryError extends Error {
  constructor(readonly httpStatus: number) {
    super(`Responded with ${httpStatus}`);
  }
}

// Checked on every delivery, not only when saved, since the name can resolve
// elsewhere later. Redirects are not followed, so one cannot lead past the check.
async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<void> {
  await assertSafeUrl(url);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Sentryward", ...headers },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new DeliveryError(res.status);
  }
}

function targetUrl(target: NotificationTarget): string {
  if (!target.encryptedUrl) throw new Error("No URL stored");
  return decrypt(target.encryptedUrl);
}

// Throws on failure; callers decide whether that is logged or reported.
export async function deliver(target: NotificationTarget, workspaceId: string, payload: NotificationPayload) {
  switch (target.kind) {
    case "webhook": {
      if (!target.encryptedSecret) throw new Error("No signing secret stored");
      const body = JSON.stringify(payload);
      await post(targetUrl(target), body, {
        [EVENT_HEADER]: payload.event,
        [SIGNATURE_HEADER]: signature(decrypt(target.encryptedSecret), body),
      });
      return;
    }
    case "slack": {
      await post(targetUrl(target), JSON.stringify(slackMessage(payload)));
      return;
    }
    case "email": {
      if (!mailer.configured()) throw new Error("Mail is not configured");
      // Members removed since the target was saved are left out.
      const members = await prisma.membership.findMany({
        where: { workspaceId, userId: { in: target.recipientIds } },
        select: { user: { select: { email: true } } },
      });
      // Sending to nobody is not a success: the log would show a dead target
      // as healthy.
      if (!members.length) throw new Error("None of this target's recipients are members of the workspace any more");
      const subject = describe(payload);
      const text = `${subject}\n\n${payload.review.url}\n`;
      // One message each, so recipients do not see each other's addresses.
      const results = await Promise.allSettled(members.map(({ user }) => mailer.send({ to: user.email, subject, text })));
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed) throw new Error(`${failed} of ${members.length} emails could not be sent`);
      return;
    }
  }
}

function message(err: unknown): string {
  if (err instanceof DecryptError) return "The stored URL can't be decrypted; add the target again";
  return err instanceof Error ? err.message : String(err);
}

const STORED_ERROR_LIMIT = 500;
const MIN_REDACTED_PART = 8;

// Members can read stored errors, and the URL (or its query) may be the
// credential, so it is cut out of whatever a library put in the message
// before anything is stored. Nothing we throw names the URL today; this keeps
// it that way if a dependency starts to.
export function redactError(error: string, url: string | null): string {
  let text = error;
  if (url) {
    const forms = new Set([url]);
    // Pieces of the URL, any of which may be the credential on its own. Short
    // ones are skipped so a word like "in" is not cut out of every message.
    const parts = new Set<string>();
    const decoded = (value: string) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    try {
      const parsed = new URL(url);
      forms.add(parsed.href);
      forms.add(`${parsed.origin}${parsed.pathname}`);
      if (parsed.pathname.length > 1) {
        parts.add(parsed.pathname);
        parts.add(decoded(parsed.pathname));
        for (const segment of parsed.pathname.split("/")) {
          parts.add(segment);
          parts.add(decoded(segment));
        }
      }
      if (parsed.search) {
        parts.add(parsed.search.slice(1));
        parts.add(decoded(parsed.search.slice(1)));
        for (const raw of parsed.search.slice(1).split("&")) {
          parts.add(raw);
          parts.add(raw.slice(raw.indexOf("=") + 1));
        }
        for (const [key, value] of parsed.searchParams) {
          parts.add(`${key}=${value}`);
          parts.add(value);
        }
      }
      if (parsed.hash) parts.add(parsed.hash.slice(1));
      parts.add(decoded(parsed.username));
      parts.add(decoded(parsed.password));
      if (parsed.password) parts.add(`${parsed.username}:${parsed.password}`);
    } catch {
      // Not a URL we can take apart; the raw string is still removed.
    }
    for (const part of parts) {
      if (part.length >= MIN_REDACTED_PART) forms.add(part);
    }
    // Longest first, so a shorter form never leaves the tail of a longer one.
    for (const form of [...forms].sort((a, b) => b.length - a.length)) {
      text = text.split(form).join("[redacted]");
    }
  }
  text = oneLine(text) || "Unknown error";
  return text.length > STORED_ERROR_LIMIT ? `${text.slice(0, STORED_ERROR_LIMIT - 1)}…` : text;
}

// The URL to redact, or null when there is none or it cannot be read.
function storedUrl(target: NotificationTarget): string | null {
  try {
    return targetUrl(target);
  } catch {
    return null;
  }
}

export type DeliveryOutcome = { ok: true } | { ok: false; error: string };

// Delivers and records the outcome. Recording is best effort: a row that cannot
// be written is logged and the outcome still returned, so neither a review nor
// a test answer ever depends on the log.
async function attempt(
  target: NotificationTarget,
  workspaceId: string,
  payload: NotificationPayload,
  jobId: string | null,
): Promise<DeliveryOutcome> {
  const createdAt = new Date();
  let outcome: DeliveryOutcome;
  let httpStatus: number | null = null;
  try {
    await deliver(target, workspaceId, payload);
    outcome = { ok: true };
  } catch (err) {
    if (err instanceof DeliveryError) httpStatus = err.httpStatus;
    outcome = { ok: false, error: redactError(message(err), storedUrl(target)) };
  }
  try {
    await prisma.notificationDelivery.create({
      data: {
        targetId: target.id,
        jobId,
        event: payload.event,
        status: outcome.ok ? "sent" : "failed",
        httpStatus,
        // An HTTP failure is fully described by its status; the message is
        // only stored when there is no status to show.
        error: outcome.ok || httpStatus !== null ? null : outcome.error,
        createdAt,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    console.error(`[notify] could not record a delivery to target ${target.id}`, err);
  }
  return outcome;
}

// Best effort and at most once per job: called when a job reaches its final
// status, whoever finished it. Nothing here throws, so a failed delivery can
// never change the job's outcome; failures are logged.
export async function notifyJob(jobId: string): Promise<void> {
  try {
    const { count } = await prisma.reviewJob.updateMany({
      where: { id: jobId, notifiedAt: null, status: { in: NOTIFIED_STATUSES } },
      data: { notifiedAt: new Date() },
    });
    if (count === 0) return;
    const job = await prisma.reviewJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { repository: { include: { connection: { select: { workspaceId: true } } } } },
    });
    const events = eventsFor(job);
    const workspaceId = job.repository.connection.workspaceId;
    // Paused targets are left out here only; a test delivery still reaches them.
    // notifiedAt is already stamped, so a paused target misses this job for
    // good rather than catching up when it is resumed.
    const targets = await prisma.notificationTarget.findMany({
      where: { workspaceId, active: true, events: { hasSome: events } },
    });
    await Promise.all(
      targets.map(async (target) => {
        const event = eventForTarget(events, target)!;
        const outcome = await attempt(target, workspaceId, payloadFor(job, job.repository, event), job.id);
        if (!outcome.ok) {
          console.error(`[notify] target ${target.id} job ${jobId}: ${outcome.error}`);
        }
      }),
    );
  } catch (err) {
    console.error(`[notify] could not notify for job ${jobId}`, err);
  }
}

// A sample delivery from the dashboard; the outcome is the answer either way.
export async function testTarget(target: NotificationTarget): Promise<DeliveryOutcome> {
  const sample: NotificationPayload = {
    event: "test",
    review: {
      id: "00000000-0000-0000-0000-000000000000",
      url: `${env.CLIENT_ORIGIN}/reviews`,
      status: "completed",
      verdict: "pass",
      error: null,
    },
    repository: { provider: "github", fullPath: "example/repository" },
    change: { number: 1, title: "Test notification from Sentryward", url: null },
    findings: { total: 0, bySeverity: {} },
  };
  return attempt(target, target.workspaceId, sample, null);
}

export type LastDelivery = Pick<NotificationDelivery, "status" | "event" | "httpStatus" | "error" | "createdAt">;

// Newest first by when the attempt started (rows are stamped before sending),
// with the id breaking ties. lastDeliveries uses the same order, so a target's
// Last delivery is always the top row of its history.
export const DELIVERY_ORDER = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.NotificationDeliveryOrderByWithRelationInput[];

// Each target's newest delivery in one query, one row read per target.
export async function lastDeliveries(targetIds: string[]): Promise<Map<string, LastDelivery>> {
  if (!targetIds.length) return new Map();
  const rows = await prisma.$queryRaw<
    {
      target_id: string;
      status: LastDelivery["status"];
      event: string;
      http_status: number | null;
      error: string | null;
      created_at: Date;
    }[]
  >`
    SELECT DISTINCT ON (target_id) target_id, status, event, http_status, error, created_at
    FROM notification_deliveries
    WHERE target_id = ANY(${targetIds}::uuid[])
    ORDER BY target_id, created_at DESC, id DESC
  `;
  return new Map(
    rows.map((row) => [
      row.target_id,
      { status: row.status, event: row.event, httpStatus: row.http_status, error: row.error, createdAt: row.created_at },
    ]),
  );
}

export function publicDelivery(delivery: NotificationDelivery) {
  return {
    id: delivery.id,
    event: delivery.event,
    status: delivery.status,
    httpStatus: delivery.httpStatus,
    error: delivery.error,
    attempts: delivery.attempts,
    jobId: delivery.jobId,
    createdAt: delivery.createdAt,
    finishedAt: delivery.finishedAt,
  };
}

// Only the host of a URL ever leaves the server: the full Slack URL is the
// credential, and a webhook URL may carry one in its query.
export function publicTarget(target: NotificationTarget, lastDelivery: LastDelivery | null = null) {
  let host: string | null = null;
  let undecryptable = false;
  if (target.encryptedUrl) {
    try {
      host = new URL(decrypt(target.encryptedUrl)).host;
    } catch (error) {
      if (!(error instanceof DecryptError)) throw error;
      undecryptable = true;
    }
  }
  return {
    id: target.id,
    kind: target.kind,
    name: target.name,
    events: EVENT_ORDER.filter((event) => target.events.includes(event)),
    host,
    undecryptable,
    recipientIds: target.recipientIds,
    active: target.active,
    lastDelivery: lastDelivery && {
      status: lastDelivery.status,
      event: lastDelivery.event,
      httpStatus: lastDelivery.httpStatus,
      error: lastDelivery.error,
      createdAt: lastDelivery.createdAt,
    },
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}
