import { createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.ts";
import { Prisma } from "../generated/prisma/client.ts";
import type {
  NotificationDelivery,
  NotificationEvent,
  NotificationKind,
  NotificationTarget,
  ReviewJob,
  ReviewStatus,
} from "../generated/prisma/client.ts";
import { DecryptError, decrypt } from "../lib/crypto.ts";
import { assertSafeUrl } from "../lib/hostSafety.ts";
import { HttpError } from "../lib/httpError.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import { atLeast, SEVERITIES } from "../review/core/severity.ts";
import type { ResultSummary } from "../review/render/json.ts";

export const SIGNATURE_HEADER = "X-Sentryward-Signature";
export const EVENT_HEADER = "X-Sentryward-Event";
const DELIVERY_TIMEOUT_MS = 10_000;

// Skipped, cancelled and superseded jobs never notify: nothing was reviewed.
const NOTIFIED_STATUSES: ReviewStatus[] = ["completed", "partial", "failed"];
// Most specific first; a job is delivered once per target, as the first of its
// events that target listens for (and its filters let through).
const EVENT_ORDER: NotificationEvent[] = ["failed", "blocked", "resolved", "completed"];
// Events that are news whatever the target's filters say: a failure has no
// findings or verdict to filter on, and a resolved review usually has fewer
// findings, so a severity floor would hide exactly the good news.
const UNFILTERED_EVENTS: NotificationEvent[] = ["failed", "resolved"];

type JobFacts = Pick<ReviewJob, "id" | "number" | "status" | "verdict" | "error" | "summary">;

export interface NotificationPayload {
  event: NotificationEvent | "test";
  review: { id: string; url: string; status: ReviewStatus; verdict: ReviewJob["verdict"]; error: string | null };
  repository: { provider: string; fullPath: string };
  change: { number: number; title: string | null; url: string | null };
  findings: { total: number; bySeverity: ResultSummary["bySeverity"] } | null;
}

type Verdict = ReviewJob["verdict"];

// The previous finished review of the same change: undefined when there is
// none, otherwise its verdict.
export type PreviousVerdict = Verdict | undefined;

// Every event a finished job counts as. A blocked review is also a completed
// one, and so is a resolved one.
export function eventsFor(
  job: Pick<ReviewJob, "status" | "verdict">,
  previous: PreviousVerdict = undefined,
): NotificationEvent[] {
  if (job.status === "failed") return ["failed"];
  if (job.status !== "completed" && job.status !== "partial") return [];
  if (job.verdict === "blocked") return ["blocked", "completed"];
  return previous === "blocked" ? ["resolved", "completed"] : ["completed"];
}

// The verdict of the newest completed or partial review of the same change
// that finished before this one, however either was triggered. Failed runs are
// passed over: pass, failed, pass is not a change of verdict.
export async function previousVerdict(
  tx: Prisma.TransactionClient,
  job: Pick<ReviewJob, "id" | "repositoryId" | "number" | "finishedAt">,
): Promise<PreviousVerdict> {
  const previous = await tx.reviewJob.findFirst({
    where: {
      repositoryId: job.repositoryId,
      number: job.number,
      id: { not: job.id },
      status: { in: ["completed", "partial"] },
      ...(job.finishedAt ? { finishedAt: { lt: job.finishedAt } } : {}),
    },
    orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }],
    select: { verdict: true },
  });
  return previous ? previous.verdict : undefined;
}

export type TargetFilters = Pick<NotificationTarget, "events" | "minSeverity" | "onlyVerdictChanges">;

export interface JobFilterFacts {
  bySeverity: ResultSummary["bySeverity"];
  verdict: Verdict;
  previous: PreviousVerdict;
}

function meetsSeverity(target: TargetFilters, bySeverity: ResultSummary["bySeverity"]): boolean {
  const floor = target.minSeverity;
  if (!floor) return true;
  return SEVERITIES.some((severity) => (bySeverity[severity] ?? 0) > 0 && atLeast(severity, floor));
}

// The first review of a change counts as a change.
function verdictChanged(facts: JobFilterFacts): boolean {
  return facts.previous === undefined || facts.previous !== facts.verdict;
}

// The event a target hears about, or null when it listens for none of them or
// its filters let none through. The repository filter is applied by the query.
export function eventForTarget(
  events: NotificationEvent[],
  target: TargetFilters,
  facts: JobFilterFacts = { bySeverity: {}, verdict: null, previous: undefined },
) {
  return (
    EVENT_ORDER.find((event) => {
      if (!events.includes(event) || !target.events.includes(event)) return false;
      if (UNFILTERED_EVENTS.includes(event)) return true;
      if (!meetsSeverity(target, facts.bySeverity)) return false;
      return !target.onlyVerdictChanges || verdictChanged(facts);
    }) ?? null
  );
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
  resolved: "Blocking issues resolved",
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

// A delivery the far end answered with a non-2xx status. retryAfterMs is the
// wait a 429 asked for, when it named one.
export class DeliveryError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`Responded with ${httpStatus}`);
  }
}

// A failure that sending again cannot fix (the target's own settings, or the
// instance's), so it is never retried.
export class PermanentDeliveryError extends Error {}

// A job delivery is sent at most this many times, waiting RETRY_BACKOFF_MS[n-1]
// after the nth failed send.
export const MAX_DELIVERY_ATTEMPTS = 5;
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
// A Retry-After past this is a misconfigured endpoint, not a plan to follow.
const MAX_RETRY_AFTER_MS = 6 * 60 * 60_000;

// Retry-After is either delay-seconds or an HTTP date.
export function parseRetryAfter(value: string | null, now = new Date()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

export type FailureKind = "retryable" | "permanent" | "gone";

// Whether a failed send is worth repeating. "gone" is an endpoint that says it
// no longer exists: Slack answers 404 (no_service) or 410 for a deleted
// incoming webhook, and nothing else uses 410 lightly.
export function classifyFailure(err: unknown, kind: NotificationKind): FailureKind {
  if (err instanceof DeliveryError) {
    const status = err.httpStatus;
    if (status === 410 || (kind === "slack" && status === 404)) return "gone";
    if (status === 408 || status === 429 || status >= 500) return "retryable";
    return "permanent";
  }
  if (err instanceof PermanentDeliveryError || err instanceof DecryptError) return "permanent";
  // Timeouts, refused connections and SMTP errors may well pass.
  return "retryable";
}

// How long to wait after the nth failed send (attempts = n) before the next.
export function retryDelayMs(attempts: number, err: unknown): number {
  const backoff = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1]!;
  if (err instanceof DeliveryError && err.retryAfterMs !== null) return err.retryAfterMs;
  return backoff;
}

// Checked on every delivery, not only when saved, since the name can resolve
// elsewhere later. Redirects are not followed, so one cannot lead past the check.
async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<void> {
  try {
    await assertSafeUrl(url);
  } catch (err) {
    // A lookup that failed may work next time; a URL the rules refuse will not.
    if (err instanceof HttpError && !err.message.startsWith("Could not resolve")) {
      throw new PermanentDeliveryError(err.message);
    }
    throw err;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Sentryward", ...headers },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new DeliveryError(res.status, res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : null);
  }
}

function targetUrl(target: NotificationTarget): string {
  if (!target.encryptedUrl) throw new PermanentDeliveryError("No URL stored");
  return decrypt(target.encryptedUrl);
}

// Throws on failure; callers decide whether that is logged or reported.
export async function deliver(target: NotificationTarget, workspaceId: string, payload: NotificationPayload) {
  switch (target.kind) {
    case "webhook": {
      if (!target.encryptedSecret) throw new PermanentDeliveryError("No signing secret stored");
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
      if (!mailer.configured()) throw new PermanentDeliveryError("Mail is not configured");
      // Members removed since the target was saved are left out.
      const members = await prisma.membership.findMany({
        where: { workspaceId, userId: { in: target.recipientIds } },
        select: { user: { select: { email: true } } },
      });
      // Sending to nobody is not a success: the log would show a dead target
      // as healthy.
      if (!members.length) {
        throw new PermanentDeliveryError("None of this target's recipients are members of the workspace any more");
      }
      const subject = describe(payload);
      const text = `${subject}\n\n${payload.review.url}\n`;
      // One message each, so recipients do not see each other's addresses.
      const results = await Promise.allSettled(members.map(({ user }) => mailer.send({ to: user.email, subject, text })));
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed) {
        const text = `${failed} of ${members.length} emails could not be sent`;
        // Sending again would mail the recipients who did get it a second time.
        throw failed < members.length ? new PermanentDeliveryError(text) : new Error(text);
      }
      return;
    }
  }
}

export function message(err: unknown): string {
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
export function storedUrl(target: NotificationTarget): string | null {
  try {
    return targetUrl(target);
  } catch {
    return null;
  }
}

export type DeliveryOutcome = { ok: true } | { ok: false; error: string };

// A test delivery: sent once, now, and recorded with its outcome. Recording is
// best effort: a row that cannot be written is logged and the outcome still
// returned, so the answer never depends on the log. A success resets the
// target's failure count (the endpoint works); a failure does not add to it,
// since an admin probing a target should not pause it.
async function attempt(target: NotificationTarget, payload: NotificationPayload): Promise<DeliveryOutcome> {
  const createdAt = new Date();
  let outcome: DeliveryOutcome;
  let httpStatus: number | null = null;
  try {
    await deliver(target, target.workspaceId, payload);
    outcome = { ok: true };
  } catch (err) {
    if (err instanceof DeliveryError) httpStatus = err.httpStatus;
    outcome = { ok: false, error: redactError(message(err), storedUrl(target)) };
  }
  try {
    await prisma.notificationDelivery.create({
      data: {
        targetId: target.id,
        event: payload.event,
        status: outcome.ok ? "sent" : "failed",
        attempts: 1,
        httpStatus,
        // An HTTP failure is fully described by its status; the message is
        // only stored when there is no status to show.
        error: outcome.ok || httpStatus !== null ? null : outcome.error,
        createdAt,
        finishedAt: new Date(),
      },
    });
    if (outcome.ok) {
      await prisma.notificationTarget.update({ where: { id: target.id }, data: { consecutiveFailures: 0 } });
    }
  } catch (err) {
    console.error(`[notify] could not record a delivery to target ${target.id}`, err);
  }
  return outcome;
}

// Queues the job's deliveries when it reaches its final status, whoever
// finished it; the worker sends them (worker/deliveryQueue.ts). The rows are
// written in the same transaction that stamps notifiedAt, so a crash either
// leaves the job unstamped (the next caller queues them) or leaves them queued,
// never stamped with nothing to send. No network here, so it never holds a
// review slot. Nothing here throws; failures are logged.
export async function notifyJob(jobId: string): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.reviewJob.updateMany({
        where: { id: jobId, notifiedAt: null, status: { in: NOTIFIED_STATUSES } },
        data: { notifiedAt: new Date() },
      });
      if (count === 0) return;
      const job = await tx.reviewJob.findUniqueOrThrow({
        where: { id: jobId },
        include: { repository: { include: { connection: { select: { workspaceId: true } } } } },
      });
      const previous = job.status === "failed" ? undefined : await previousVerdict(tx, job);
      const events = eventsFor(job, previous);
      if (!events.length) return;
      // Paused targets are left out here, and pausing a target drops the rows
      // queued for it (dropPendingDeliveries), so a paused target misses this
      // job for good rather than catching up when it is resumed. A test
      // delivery still reaches it.
      const candidates = await tx.notificationTarget.findMany({
        where: {
          workspaceId: job.repository.connection.workspaceId,
          active: true,
          events: { hasSome: events },
          // An empty list is every repository.
          OR: [{ repositoryIds: { isEmpty: true } }, { repositoryIds: { has: job.repositoryId } }],
        },
      });
      const summary = job.summary as ResultSummary | null;
      const facts: JobFilterFacts = { bySeverity: summary?.bySeverity ?? {}, verdict: job.verdict, previous };
      const targets = candidates.flatMap((target) => {
        const event = eventForTarget(events, target, facts);
        return event ? [{ target, event }] : [];
      });
      if (!targets.length) return;
      const now = new Date();
      await tx.notificationDelivery.createMany({
        data: targets.map(({ target, event }) => {
          return {
            targetId: target.id,
            jobId: job.id,
            event,
            status: "pending" as const,
            attempts: 0,
            payload: payloadFor(job, job.repository, event) as unknown as Prisma.InputJsonValue,
            nextAttemptAt: now,
            createdAt: now,
          };
        }),
        // The unique (target, job) pair makes queueing twice a no-op.
        skipDuplicates: true,
      });
    });
  } catch (err) {
    console.error(`[notify] could not queue notifications for job ${jobId}`, err);
  }
}

// How long after a job finishes the sweep below takes over from the worker
// that finished it, which queues its deliveries right after storing the job.
export const MISSED_NOTIFY_GRACE_MS = 60_000;
// How far back the sweep looks. Jobs finished before notifiedAt existed have it
// null too, and a "review finished" message a day late is not worth sending.
export const MISSED_NOTIFY_LOOKBACK_MS = 24 * 60 * 60_000;
const MISSED_NOTIFY_BATCH = 100;

// Queues deliveries for finished jobs nothing queued them for: the worker
// stopped between storing the job's final status and calling notifyJob, or
// the queueing transaction failed. notifyJob only acts on a job still
// unstamped, so racing the worker that finished the job is harmless. Returns
// how many jobs were looked at.
export async function queueMissedNotifications(now = new Date()): Promise<number> {
  const jobs = await prisma.reviewJob.findMany({
    where: {
      status: { in: NOTIFIED_STATUSES },
      notifiedAt: null,
      finishedAt: {
        gte: new Date(now.getTime() - MISSED_NOTIFY_LOOKBACK_MS),
        lte: new Date(now.getTime() - MISSED_NOTIFY_GRACE_MS),
      },
    },
    select: { id: true },
    orderBy: { finishedAt: "asc" },
    take: MISSED_NOTIFY_BATCH,
  });
  for (const { id } of jobs) await notifyJob(id);
  return jobs.length;
}

export const PAUSED_BEFORE_SEND = "Target was paused before this could be sent";

// Fails a target's queued deliveries when it is paused, so a pause drops them
// for good rather than until a resume (see notifyJob). Rows a worker is sending
// right now are left to it: runDelivery settles them rather than rescheduling
// once it sees the target paused. Call in the transaction that pauses.
export function dropPendingDeliveries(tx: Prisma.TransactionClient, targetId: string, now = new Date()) {
  return tx.notificationDelivery.updateMany({
    where: { targetId, status: "pending", lockedAt: null },
    data: {
      status: "failed",
      error: PAUSED_BEFORE_SEND,
      httpStatus: null,
      nextAttemptAt: null,
      payload: Prisma.DbNull,
      finishedAt: now,
    },
  });
}

const STATUS_TEXT: Record<number, string> = { 404: "Not Found", 410: "Gone" };

function httpLabel(httpStatus: number): string {
  return `HTTP ${httpStatus}${STATUS_TEXT[httpStatus] ? ` ${STATUS_TEXT[httpStatus]}` : ""}`;
}

// The two reasons recordTargetFailure writes start with these, so the dashboard
// can tell an endpoint that is gone (fixed by adding the target again) from one
// that kept failing (worth a test and a resume).
const GONE_REASON = "Auto-paused: HTTP ";
const FAILURES_REASON = "Auto-paused after ";
// Written by dropRepositoriesFromTargets.
export const SCOPE_REASON = "Paused: its repositories were removed";

export type PauseCause = "gone" | "failures" | "scope";

export function pauseCause(reason: string | null): PauseCause | null {
  if (reason === null) return null;
  if (reason === SCOPE_REASON) return "scope";
  // Anything else (a reason written by an older version) counts as failures.
  return reason.startsWith(GONE_REASON) ? "gone" : "failures";
}

// Takes deleted repositories out of every target's filter. A target left with
// none would read as "all repositories", so instead it is paused (and its
// queued deliveries dropped) with SCOPE_REASON, already paused or not, and
// cannot be switched back on until an admin saves its repositories again (see
// updateNotification). Call in the transaction that deletes the repositories.
export async function dropRepositoriesFromTargets(tx: Prisma.TransactionClient, repositoryIds: string[]) {
  if (!repositoryIds.length) return;
  const rows = await tx.$queryRaw<{ id: string; remaining: number }[]>`
    UPDATE notification_targets
    SET repository_ids = ARRAY(
      SELECT id FROM unnest(repository_ids) AS id WHERE id <> ALL(${repositoryIds}::uuid[])
    )
    WHERE repository_ids && ${repositoryIds}::uuid[]
    RETURNING id, cardinality(repository_ids) AS remaining
  `;
  for (const row of rows) {
    if (row.remaining > 0) continue;
    await tx.notificationTarget.update({ where: { id: row.id }, data: { active: false, pausedReason: SCOPE_REASON } });
    await dropPendingDeliveries(tx, row.id);
  }
}

// Counts a delivery that failed for good against its target and pauses the
// target when the endpoint is gone or the workspace's limit is reached.
// Returns the reason when this call paused it, so the caller tells admins
// exactly once: the counting UPDATE locks the row, so a concurrent failure
// waits and then sees the target already paused.
export async function recordTargetFailure(
  targetId: string,
  failure: { httpStatus: number | null; gone: boolean },
): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ active: boolean; failures: number; limit: number }[]>`
      UPDATE notification_targets t
      SET consecutive_failures = t.consecutive_failures + 1
      FROM workspaces w
      WHERE t.id = ${targetId}::uuid AND w.id = t.workspace_id
      RETURNING t.active, t.consecutive_failures AS failures, w.notify_auto_pause_after AS limit
    `;
    if (!row || !row.active || row.limit <= 0) return null;
    if (!failure.gone && row.failures < row.limit) return null;
    const last = failure.httpStatus !== null ? ` (last: ${httpLabel(failure.httpStatus)})` : "";
    const reason =
      failure.gone && failure.httpStatus !== null
        ? `${GONE_REASON}${httpLabel(failure.httpStatus).slice("HTTP ".length)}`
        : `${FAILURES_REASON}${row.failures} failed deliveries in a row${last}`;
    await tx.notificationTarget.update({ where: { id: targetId }, data: { active: false, pausedReason: reason } });
    await dropPendingDeliveries(tx, targetId);
    return reason;
  });
}

// Tells the workspace's owners and admins, one message each, that a target was
// paused. Best effort: without mail, or when sending fails, the reason still
// shows on the Notifications page.
export async function emailAdminsAboutPause(targetId: string, reason: string): Promise<void> {
  if (!mailer.configured()) return;
  try {
    const target = await prisma.notificationTarget.findUnique({
      where: { id: targetId },
      select: { name: true, workspace: { select: { id: true, name: true } } },
    });
    if (!target) return;
    const admins = await prisma.membership.findMany({
      where: { workspaceId: target.workspace.id, role: { in: ["owner", "admin"] } },
      select: { user: { select: { email: true } } },
    });
    const subject = oneLine(`Notification target "${target.name}" was paused in ${target.workspace.name}`);
    const text =
      `${reason}.\n\nSentryward stopped sending to this target. Fix the endpoint, then switch the target ` +
      `back on under Notifications:\n${env.CLIENT_ORIGIN}/notifications?tab=failing\n`;
    const results = await Promise.allSettled(admins.map(({ user }) => mailer.send({ to: user.email, subject, text })));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) console.error(`[notify] ${failed} of ${admins.length} pause emails for target ${targetId} failed`);
  } catch (err) {
    console.error(`[notify] could not email admins about pausing target ${targetId}`, err);
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
  return attempt(target, sample);
}

export type LastDelivery = Pick<
  NotificationDelivery,
  "status" | "event" | "httpStatus" | "error" | "attempts" | "nextAttemptAt" | "createdAt"
>;

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
      attempts: number;
      next_attempt_at: Date | null;
      created_at: Date;
    }[]
  >`
    SELECT DISTINCT ON (target_id) target_id, status, event, http_status, error, attempts, next_attempt_at, created_at
    FROM notification_deliveries
    WHERE target_id = ANY(${targetIds}::uuid[])
    ORDER BY target_id, created_at DESC, id DESC
  `;
  return new Map(
    rows.map((row) => [
      row.target_id,
      {
        status: row.status,
        event: row.event,
        httpStatus: row.http_status,
        error: row.error,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        createdAt: row.created_at,
      },
    ]),
  );
}

// A queued row that already failed at least once and is due again.
export type PendingRetry = Pick<NotificationDelivery, "attempts" | "httpStatus" | "error" | "nextAttemptAt">;

export interface PendingDeliveries {
  count: number;
  // The retry due soonest, or null when every queued row is still untried.
  retry: PendingRetry | null;
}

// What each target still has queued, apart from its newest delivery: a test
// or a later job sent fine says nothing about an older row still retrying.
export async function pendingDeliveries(targetIds: string[]): Promise<Map<string, PendingDeliveries>> {
  if (!targetIds.length) return new Map();
  const rows = await prisma.$queryRaw<
    {
      target_id: string;
      count: number;
      attempts: number;
      http_status: number | null;
      error: string | null;
      next_attempt_at: Date | null;
    }[]
  >`
    SELECT DISTINCT ON (target_id)
      target_id, (count(*) OVER (PARTITION BY target_id))::int AS count,
      attempts, http_status, error, next_attempt_at
    FROM notification_deliveries
    WHERE status = 'pending' AND target_id = ANY(${targetIds}::uuid[])
    ORDER BY target_id, (attempts > 0) DESC, next_attempt_at ASC NULLS LAST, id
  `;
  return new Map(
    rows.map((row) => [
      row.target_id,
      {
        count: row.count,
        retry:
          row.attempts > 0
            ? {
                attempts: row.attempts,
                httpStatus: row.http_status,
                error: row.error,
                nextAttemptAt: row.next_attempt_at,
              }
            : null,
      },
    ]),
  );
}

// Both per-target delivery views the dashboard shows, for a list of targets.
export async function deliveryStates(targetIds: string[]) {
  const [last, pending] = await Promise.all([lastDeliveries(targetIds), pendingDeliveries(targetIds)]);
  return { last: (id: string) => last.get(id) ?? null, pending: (id: string) => pending.get(id) ?? null };
}

export function publicDelivery(delivery: NotificationDelivery) {
  return {
    id: delivery.id,
    event: delivery.event,
    status: delivery.status,
    httpStatus: delivery.httpStatus,
    error: delivery.error,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt,
    jobId: delivery.jobId,
    createdAt: delivery.createdAt,
    finishedAt: delivery.finishedAt,
  };
}

// Only the host of a URL ever leaves the server: the full Slack URL is the
// credential, and a webhook URL may carry one in its query.
export function publicTarget(
  target: NotificationTarget,
  lastDelivery: LastDelivery | null = null,
  pending: PendingDeliveries | null = null,
) {
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
    repositoryIds: target.repositoryIds,
    minSeverity: target.minSeverity,
    onlyVerdictChanges: target.onlyVerdictChanges,
    active: target.active,
    pausedReason: target.pausedReason,
    pauseCause: pauseCause(target.pausedReason),
    consecutiveFailures: target.consecutiveFailures,
    lastDelivery: lastDelivery && {
      status: lastDelivery.status,
      event: lastDelivery.event,
      httpStatus: lastDelivery.httpStatus,
      error: lastDelivery.error,
      attempts: lastDelivery.attempts,
      nextAttemptAt: lastDelivery.nextAttemptAt,
      createdAt: lastDelivery.createdAt,
    },
    pending: {
      count: pending?.count ?? 0,
      retry: pending?.retry
        ? {
            attempts: pending.retry.attempts,
            httpStatus: pending.retry.httpStatus,
            error: pending.retry.error,
            nextAttemptAt: pending.retry.nextAttemptAt,
          }
        : null,
    },
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}
