import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { env } from "../config/env.ts";
import { Prisma } from "../generated/prisma/client.ts";
import type {
  ForgeProvider,
  NotificationDelivery,
  NotificationEvent,
  NotificationKind,
  NotificationTarget,
  ReviewJob,
  ReviewStatus,
  SignInProvider,
} from "../generated/prisma/client.ts";
import { DecryptError, decrypt } from "../lib/crypto.ts";
import { assertSafeUrl } from "../lib/hostSafety.ts";
import { HttpError } from "../lib/httpError.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import { plural } from "../review/core/plural.ts";
import { atLeast, SEVERITIES } from "../review/core/severity.ts";
import { FORGE_INFO } from "../review/forge/providers.ts";
import type { ResultSummary } from "../review/render/json.ts";
import { formatDigestTime } from "./digestSchedule.ts";

// Body-only signature, kept for receivers written before SIGNATURE_V2_HEADER.
// Deprecated: it can be replayed indefinitely; removed in the next minor release.
export const SIGNATURE_HEADER = "X-Sentryward-Signature";
// Covers "<timestamp>.<body>", so a receiver can reject an old delivery.
export const SIGNATURE_V2_HEADER = "X-Sentryward-Signature-V2";
export const TIMESTAMP_HEADER = "X-Sentryward-Timestamp";
export const DELIVERY_HEADER = "X-Sentryward-Delivery";
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

type JobFacts = Pick<ReviewJob, "id" | "number" | "status" | "verdict" | "error" | "summary" | "headSha" | "trigger">;

export interface NotificationPayload {
  event: NotificationEvent | "test";
  // trigger and headSha are missing from rows queued before they were added.
  review: {
    id: string;
    url: string;
    status: ReviewStatus;
    verdict: ReviewJob["verdict"];
    error: string | null;
    trigger?: ReviewJob["trigger"];
  };
  repository: { provider: string; fullPath: string };
  change: { number: number; title: string | null; url: string | null; headSha?: string };
  findings: { total: number; bySeverity: ResultSummary["bySeverity"] } | null;
}

// A digest: what a target in daily or weekly mode gets instead of one
// delivery per review, built by worker/digests.ts from the reviews it held.
export interface DigestPayload {
  event: "digest";
  // The target's schedule, or null for the final digest sent when a target
  // goes back to one delivery per review.
  schedule: "daily" | "weekly" | null;
  period: { from: string; to: string; timeZone: string };
  counts: {
    reviews: number;
    failed: number;
    resolved: number;
    byVerdict: { pass: number; blocked: number; error: number };
  };
  // Repositories by blocked reviews in the period, most first.
  topBlockedRepositories: { provider: string; fullPath: string; blocked: number }[];
  // Changes whose newest review was blocked, at most DIGEST_BLOCKED_LIMIT, with
  // `blockedTruncated` counting those left out.
  blocked: NotificationPayload[];
  blockedTruncated: number;
  // Every review, blocked and failed first, then the rest, each oldest first;
  // at most DIGEST_REVIEW_LIMIT, with `truncated` counting those left out.
  // Up to DIGEST_FAILED_RESERVE of those places are kept for failed reviews,
  // so a busy period of blocked ones cannot leave the failures out.
  reviews: NotificationPayload[];
  truncated: number;
}

// What a delivery row carries and deliver() sends.
export type DeliveryPayload = NotificationPayload | DigestPayload;

export const DIGEST_REVIEW_LIMIT = 200;
// Blocked entries repeat payloads already in `reviews`, so they get a smaller
// cap of their own to keep a webhook body well short of doubling.
export const DIGEST_BLOCKED_LIMIT = 50;
// Places in `reviews` kept for failed reviews: they come after blocked ones,
// and the failure details the email and Slack digests show are read from it.
export const DIGEST_FAILED_RESERVE = 50;
const TOP_BLOCKED_REPOSITORIES = 5;

const DIGEST_PRIORITY: Record<string, number> = { blocked: 0, failed: 1, resolved: 2, completed: 3 };
const FAILED_PRIORITY = DIGEST_PRIORITY.failed!;

export type DigestPeriod = { from: Date; to: Date; timeZone: string; schedule: DigestPayload["schedule"] };

// "github:acme/api#42": a change, across the reviews a digest holds.
export function changeKey(review: Pick<NotificationPayload, "repository" | "change">): string {
  return `${review.repository.provider}:${review.repository.fullPath}#${review.change.number}`;
}

// Rolls held reviews into one digest a page at a time (oldest first), so a
// busy week never has to sit in memory at once. Counts cover every review;
// only the lists are capped, and only the first DIGEST_REVIEW_LIMIT of each
// priority are kept as they arrive. Which changes are still blocked needs the
// newest review of every change, so the caller works that out in the database
// (stillBlockedChanges) and hands build() the capped list: what this keeps is
// bounded by the caps and the number of repositories, not by the period.
export function createDigestBuilder(period: DigestPeriod) {
  const counts: DigestPayload["counts"] = {
    reviews: 0,
    failed: 0,
    resolved: 0,
    byVerdict: { pass: 0, blocked: 0, error: 0 },
  };
  const repos = new Map<string, DigestPayload["topBlockedRepositories"][number]>();
  const byPriority = new Map<number, NotificationPayload[]>();
  return {
    add(held: NotificationPayload[]) {
      for (const review of held) {
        counts.reviews++;
        const failed = review.review.status === "failed";
        if (failed) counts.failed++;
        if (review.event === "resolved") counts.resolved++;
        // Failed runs are left out of every verdict figure, so the headline
        // and the most-blocked list agree, and say nothing about whether the
        // change is still blocked.
        const verdict = failed ? null : review.review.verdict;
        if (verdict) counts.byVerdict[verdict]++;
        if (verdict === "blocked") {
          const repoKey = `${review.repository.provider}:${review.repository.fullPath}`;
          const repo = repos.get(repoKey) ?? { ...review.repository, blocked: 0 };
          repo.blocked++;
          repos.set(repoKey, repo);
        }
        const priority = DIGEST_PRIORITY[review.event] ?? 4;
        const list = byPriority.get(priority) ?? [];
        if (list.length < DIGEST_REVIEW_LIMIT) list.push(review);
        byPriority.set(priority, list);
      }
    },
    // `blocked`: the still-blocked changes (stillBlockedChanges), already
    // capped, with `blockedTruncated` counting the rest. `from` overrides the
    // period's start once the caller knows the oldest review.
    build({
      blocked = [],
      blockedTruncated = 0,
      from = period.from,
    }: { blocked?: NotificationPayload[]; blockedTruncated?: number; from?: Date } = {}): DigestPayload {
      // Failed reviews get their reserved places first; the rest are filled
      // in priority order, and the list keeps that order.
      const reserved = Math.min(byPriority.get(FAILED_PRIORITY)?.length ?? 0, DIGEST_FAILED_RESERVE);
      let room = DIGEST_REVIEW_LIMIT - reserved;
      const reviews = [...byPriority.entries()]
        .sort(([a], [b]) => a - b)
        .flatMap(([priority, list]) => {
          const base = priority === FAILED_PRIORITY ? reserved : 0;
          const extra = Math.min(list.length - base, room);
          room -= extra;
          return list.slice(0, base + extra);
        });
      return {
        event: "digest",
        schedule: period.schedule,
        period: { from: from.toISOString(), to: period.to.toISOString(), timeZone: period.timeZone },
        counts,
        topBlockedRepositories: [...repos.values()]
          .sort((a, b) => b.blocked - a.blocked || a.fullPath.localeCompare(b.fullPath))
          .slice(0, TOP_BLOCKED_REPOSITORIES),
        blocked,
        blockedTruncated,
        reviews,
        truncated: Math.max(0, counts.reviews - DIGEST_REVIEW_LIMIT),
      };
    },
  };
}

// One call for a list already in memory (tests, small digests).
export function digestPayloadFor(held: NotificationPayload[], period: DigestPeriod): DigestPayload {
  const builder = createDigestBuilder(period);
  builder.add(held);
  return builder.build();
}

// The changes a target's held reviews (up to `until`) still show as blocked,
// oldest first, at most `limit` with `truncated` counting the rest. A change
// counts when its newest held review that did not fail was blocked and no
// newer finished review of it, held or not, says otherwise: a target only
// holds the reviews its events let through, so a pass after a block may never
// have been held. A change whose jobs retention already deleted is left as the
// held review says. Worked out in the database, so a period with many changes
// never has them all in memory; call it before the held rows are deleted.
export async function stillBlockedChanges(
  tx: Prisma.TransactionClient,
  targetId: string,
  until: Date,
  limit: number,
): Promise<{ blocked: NotificationPayload[]; truncated: number }> {
  // Ordered like the builder reads held rows (created_at, id), newest last,
  // so the same review is taken as the change's latest.
  const rows = await tx.$queryRaw<{ payload: NotificationPayload; total: number }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (
        d.payload->'repository'->>'provider',
        d.payload->'repository'->>'fullPath',
        d.payload->'change'->>'number'
      ) d.id, d.job_id, d.payload, d.created_at
      FROM notification_deliveries d
      WHERE d.target_id = ${targetId}::uuid
        AND d.status = 'held'
        AND d.created_at <= ${until}
        AND d.payload->'review'->>'status' IS DISTINCT FROM 'failed'
      ORDER BY
        d.payload->'repository'->>'provider',
        d.payload->'repository'->>'fullPath',
        d.payload->'change'->>'number',
        d.created_at DESC,
        d.id DESC
    )
    SELECT l.payload, (count(*) OVER ())::int AS total
    FROM latest l
    LEFT JOIN review_jobs b ON b.id = l.job_id
    LEFT JOIN LATERAL (
      SELECT true AS found, r.verdict::text AS verdict
      FROM review_jobs r
      WHERE r.repository_id = b.repository_id
        AND r.number = b.number
        AND r.status IN ('completed', 'partial')
        AND r.finished_at <= ${until}
      ORDER BY r.finished_at DESC, r.created_at DESC
      LIMIT 1
    ) newest ON true
    WHERE l.payload->'review'->>'verdict' = 'blocked'
      AND (newest.found IS NULL OR newest.verdict = 'blocked')
    ORDER BY l.created_at, l.id
    LIMIT ${limit}
  `;
  return { blocked: rows.map((row) => row.payload), truncated: Math.max(0, (rows[0]?.total ?? 0) - rows.length) };
}

type Verdict = ReviewJob["verdict"];

// The previous finished review of the same change: undefined when there is
// none, otherwise its verdict.
export type PreviousVerdict = Verdict | undefined;

// Every event a finished job counts as. A blocked review is also a completed
// one, and so is a resolved one. Only a pass resolves: a partial review with no
// blocking findings ("error") may have skipped the code the blockers were in.
export function eventsFor(
  job: Pick<ReviewJob, "status" | "verdict">,
  previous: PreviousVerdict = undefined,
): NotificationEvent[] {
  if (job.status === "failed") return ["failed"];
  if (job.status !== "completed" && job.status !== "partial") return [];
  if (job.verdict === "blocked") return ["blocked", "completed"];
  return previous === "blocked" && job.verdict === "pass" ? ["resolved", "completed"] : ["completed"];
}

// The verdict of the newest completed or partial review of the same change
// that finished before this one, however either was triggered. Failed runs are
// passed over: pass, failed, pass is not a change of verdict. A job without
// finishedAt (not expected for a finished one) is bounded by its createdAt, so
// a later review is never taken for the previous one.
export async function previousVerdict(
  tx: Prisma.TransactionClient,
  job: Pick<ReviewJob, "id" | "repositoryId" | "number" | "finishedAt" | "createdAt">,
): Promise<PreviousVerdict> {
  const previous = await tx.reviewJob.findFirst({
    where: {
      repositoryId: job.repositoryId,
      number: job.number,
      id: { not: job.id },
      status: { in: ["completed", "partial"] },
      finishedAt: { lt: job.finishedAt ?? job.createdAt },
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

// change.url comes from the forge's API; it is only ever kept when it is
// plainly http(s), so a stored javascript: or data: URL never becomes a link.
// payloadFor applies it once for every target; renderers apply it again
// because rows queued before that carry the URL unchecked.
function safeLinkUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
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
      trigger: job.trigger,
    },
    repository: { provider: repository.provider, fullPath: repository.fullPath },
    change: { number: job.number, title: summary?.title ?? null, url: safeLinkUrl(summary?.webUrl), headSha: job.headSha },
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

function clipText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// A forge title or a provider's error can run to kilobytes; some mail relays
// truncate or refuse a message with a subject or body that size.
const EMAIL_SUBJECT_LIMIT = 200;
const EMAIL_TITLE_LIMIT = 300;
const EMAIL_ERROR_LIMIT = 2000;

// Plain text, for an email subject.
function describe(payload: NotificationPayload): string {
  const { headline, title, error, findings } = messageParts(payload);
  const detail = error ?? findings;
  return clipText(`${headline}${title ? ` "${title}"` : ""}${detail ? ` - ${detail}` : ""}`, EMAIL_SUBJECT_LIMIT);
}

// Slack rejects a plain_text object over 3000 characters.
const SLACK_TEXT_LIMIT = 2000;
function clip(value: string): string {
  return clipText(value, SLACK_TEXT_LIMIT);
}

function plainText(text: string) {
  return { type: "plain_text", text: clip(text), emoji: false };
}

const EMOJI: Record<NotificationPayload["event"], string> = {
  failed: "\u26A0\uFE0F",
  blocked: "\u{1F534}",
  resolved: "\u2705",
  completed: "\u{1F7E2}",
  test: "\u{1F514}",
};

// "1 major · 2 minor", in SEVERITIES order, from our own numbers only.
function severityBreakdown(bySeverity: ResultSummary["bySeverity"] | undefined): string | null {
  const parts = SEVERITIES.flatMap((severity) => {
    const count = bySeverity?.[severity] ?? 0;
    return count > 0 ? [`${count} ${severity}`] : [];
  });
  return parts.length ? parts.join(" · ") : null;
}

// Stored payloads type provider as a string, so one we no longer know (or a
// row from before a forge was added) falls back to the generic word.
function changeNouns(provider: string): { noun: string; abbrev: string } {
  if (!Object.hasOwn(FORGE_INFO, provider)) return { noun: "change", abbrev: "change" };
  const info = FORGE_INFO[provider as keyof typeof FORGE_INFO];
  return { noun: info.changeNoun, abbrev: info.changeAbbrev };
}

// Slack rejects a message whose link is too long, which would lose the whole
// notification; past this the link is left out instead.
const SLACK_URL_LIMIT = 2000;

// A URL as the target of a mrkdwn link `<url|label>`. URL parsing already
// encodes spaces and angle brackets, but not `|`, which would end the URL early
// and let the rest pass for the label; all three are encoded to be sure.
function slackLinkUrl(url: string | null | undefined): string | null {
  const safe = safeLinkUrl(url);
  if (!safe) return null;
  const encoded = safe.replace(/[|<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return encoded.length > SLACK_URL_LIMIT ? null : encoded;
}

function slackLink(url: string, label: string): string {
  return `<${url}|${label}>`;
}

// The rule for every Slack message: mrkdwn cannot be escaped completely (there
// is no escape for `*`, `_`, `~` or backticks, and bare URLs are always
// linked), so forge text only ever goes into plain_text objects, and mrkdwn
// only carries links with our own labels to our review URL or a checked,
// encoded change URL. Links rather than url buttons: an incoming webhook has no
// interactivity endpoint to answer a button click. The title gets its own
// block so it cannot pass for a line of ours. The fallback `text` (shown in
// notifications) carries no title or error at all.
function slackMessage(payload: NotificationPayload) {
  const { headline, title, error, findings } = messageParts(payload);
  const header = `${EMOJI[payload.event]} ${HEADLINES[payload.event]} · ${oneLine(payload.repository.fullPath)} #${payload.change.number}`;
  const blocks: object[] = [{ type: "section", text: plainText(header) }];
  if (title) blocks.push({ type: "context", elements: [plainText(title)] });
  if (error) {
    blocks.push({ type: "context", elements: [plainText(error)] });
  } else if (findings) {
    const breakdown = severityBreakdown(payload.findings?.bySeverity);
    blocks.push({ type: "section", text: plainText(breakdown ? `${findings}   ${breakdown}` : findings) });
  }
  const links = [slackLink(payload.review.url, "View review")];
  const changeUrl = slackLinkUrl(payload.change.url);
  if (changeUrl) links.push(slackLink(changeUrl, `Open ${changeNouns(payload.repository.provider).abbrev}`));
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: links.join(" · ") }] });
  return { text: escapeSlack(headline), blocks };
}

const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]!);
}

function emailButton(href: string, label: string): string {
  return (
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:8px 14px;margin:0 8px 8px 0;` +
    `border-radius:6px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(label)}</a>`
  );
}

// One review's email: a text part and an HTML part with the same content.
// Forge text (title, repository, error) is escaped everywhere it lands in the
// HTML, and hrefs are only our review URL and a checked change URL.
function reviewEmail(payload: NotificationPayload, targetName: string): { subject: string; text: string; html: string } {
  const parts = messageParts(payload);
  const title = parts.title && clipText(parts.title, EMAIL_TITLE_LIMIT);
  const error = parts.error && clipText(parts.error, EMAIL_ERROR_LIMIT);
  const { findings } = parts;
  const repository = `${oneLine(payload.repository.fullPath)} #${payload.change.number}`;
  const breakdown = error ? null : severityBreakdown(payload.findings?.bySeverity);
  const detail = error ?? (findings ? `${findings}${breakdown ? ` (${breakdown})` : ""}` : null);
  const changeUrl = safeLinkUrl(payload.change.url);
  const { noun } = changeNouns(payload.repository.provider);
  const footer = `You get this as a recipient of "${oneLine(targetName)}".`;

  const lines = [HEADLINES[payload.event], repository];
  if (title) lines.push(title);
  if (detail) lines.push(detail);
  lines.push("", `Review: ${payload.review.url}`);
  if (changeUrl) lines.push(`${noun[0]!.toUpperCase()}${noun.slice(1)}: ${changeUrl}`);
  lines.push("", footer, "");

  const muted = "color:#6b7280;font-size:13px";
  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;max-width:560px">`,
    `<h2 style="font-size:18px;margin:0 0 4px">${escapeHtml(`${EMOJI[payload.event]} ${HEADLINES[payload.event]}`)}</h2>`,
    `<p style="margin:0 0 4px;${muted}">${escapeHtml(repository)}</p>`,
    title ? `<p style="margin:0 0 12px;font-size:15px;font-weight:600">${escapeHtml(title)}</p>` : "",
    detail ? `<p style="margin:0 0 16px">${escapeHtml(detail)}</p>` : "",
    `<p style="margin:0 0 16px">`,
    emailButton(payload.review.url, "View review"),
    changeUrl ? emailButton(changeUrl, `Open ${noun}`) : "",
    `</p>`,
    `<p style="margin:16px 0 0;${muted}">${escapeHtml(footer)}</p>`,
    `</div>`,
  ].join("");
  return { subject: describe(payload), text: lines.join("\n"), html };
}

// Slack reads `<...>` in text as a link, a mention or a command such as
// `<!channel>`. These are the three characters Slack documents escaping.
const SLACK_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export function escapeSlack(value: string): string {
  return value.replace(/[&<>]/g, (c) => SLACK_ENTITIES[c]!);
}

// Our own words and numbers only, so it is safe as a subject and as mrkdwn.
function digestHeadline(payload: DigestPayload): string {
  const name = payload.schedule === "daily" ? "Daily digest" : payload.schedule === "weekly" ? "Weekly digest" : "Digest";
  const { counts } = payload;
  const parts = [plural(counts.reviews, "review")];
  if (counts.byVerdict.blocked) parts.push(`${counts.byVerdict.blocked} blocked`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.resolved) parts.push(`${counts.resolved} resolved`);
  if (counts.byVerdict.pass) parts.push(`${counts.byVerdict.pass} passed`);
  return `${name}: ${parts.join(", ")}`;
}

function digestPeriod(payload: DigestPayload): string {
  const { from, to, timeZone } = payload.period;
  return `${formatDigestTime(new Date(from), timeZone)} to ${formatDigestTime(new Date(to), timeZone)} (${timeZone})`;
}

// "acme/api#42 Add login", from forge text: plain contexts only.
function changeLabel(review: NotificationPayload): string {
  const title = review.change.title ? ` ${oneLine(review.change.title)}` : "";
  return `${oneLine(review.repository.fullPath)}#${review.change.number}${title}`;
}

function topRepositories(payload: DigestPayload): string | null {
  if (!payload.topBlockedRepositories.length) return null;
  const list = payload.topBlockedRepositories.map((repo) => `${oneLine(repo.fullPath)} (${repo.blocked})`);
  return `Most blocked: ${list.join(", ")}`;
}

function failedReviews(payload: DigestPayload): NotificationPayload[] {
  return payload.reviews.filter((review) => review.review.status === "failed");
}

// Slack allows 50 blocks a message; these caps keep a digest well under it.
const SLACK_DIGEST_BLOCKED = 20;
const SLACK_DIGEST_FAILED = 5;

// Same rule as slackMessage: forge text only in plain_text, mrkdwn only for
// links to our own pages.
function slackDigest(payload: DigestPayload) {
  const headline = digestHeadline(payload);
  const blocks: object[] = [
    { type: "section", text: plainText(headline) },
    { type: "context", elements: [plainText(digestPeriod(payload))] },
  ];
  const top = topRepositories(payload);
  if (top) blocks.push({ type: "section", text: plainText(top) });
  const item = (review: NotificationPayload, label: string) => ({
    type: "context",
    elements: [plainText(label), { type: "mrkdwn", text: slackLink(review.review.url, "View review") }],
  });
  if (payload.blocked.length) {
    blocks.push({ type: "section", text: plainText("Still blocked") });
    for (const review of payload.blocked.slice(0, SLACK_DIGEST_BLOCKED)) blocks.push(item(review, changeLabel(review)));
    const shown = Math.min(payload.blocked.length, SLACK_DIGEST_BLOCKED);
    const more = payload.blocked.length + payload.blockedTruncated - shown;
    if (more > 0) blocks.push({ type: "context", elements: [plainText(`and ${more} more`)] });
  }
  const failed = failedReviews(payload);
  if (failed.length) {
    blocks.push({ type: "section", text: plainText("Failed") });
    for (const review of failed.slice(0, SLACK_DIGEST_FAILED)) {
      blocks.push(item(review, `${changeLabel(review)}: ${oneLine(review.review.error ?? "no reason recorded")}`));
    }
    const more = payload.counts.failed - Math.min(failed.length, SLACK_DIGEST_FAILED);
    if (more > 0) blocks.push({ type: "context", elements: [plainText(`and ${more} more`)] });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${env.CLIENT_ORIGIN}/reviews|All reviews>` }] });
  return { text: escapeSlack(headline), blocks };
}

// Plain text, so forge text needs no escaping; each entry is flattened to one
// line so a title cannot pass for a heading of ours.
function digestEmail(payload: DigestPayload): { subject: string; text: string } {
  const subject = digestHeadline(payload);
  const lines = [subject, digestPeriod(payload), ""];
  const top = topRepositories(payload);
  if (top) lines.push(top, "");
  if (payload.blocked.length) {
    lines.push("Still blocked:");
    for (const review of payload.blocked) {
      lines.push(
        `- ${changeLabel(review)}`,
        `  ${safeLinkUrl(review.change.url) ?? review.review.url}`,
        `  Review: ${review.review.url}`,
      );
    }
    if (payload.blockedTruncated) lines.push(`${plural(payload.blockedTruncated, "more blocked change")} not listed.`);
    lines.push("");
  }
  const failed = failedReviews(payload);
  if (failed.length) {
    lines.push("Failed:");
    for (const review of failed) {
      lines.push(`- ${changeLabel(review)}: ${oneLine(review.review.error ?? "no reason recorded")}`, `  ${review.review.url}`);
    }
    lines.push("");
  }
  if (payload.truncated) lines.push(`${plural(payload.truncated, "more review")} not listed.`, "");
  lines.push(`All reviews: ${env.CLIENT_ORIGIN}/reviews`, "");
  return { subject, text: lines.join("\n") };
}

// "sha256=<hex>" over the exact body sent, as GitHub signs its webhooks.
export function signature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// The same, over "<timestamp>.<body>": a receiver that checks the timestamp is
// recent cannot be fed a captured delivery again later.
export function timestampedSignature(secret: string, timestamp: string, body: string): string {
  return signature(secret, `${timestamp}.${body}`);
}

export function newWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

// How long a rotated-out secret keeps signing deliveries next to the new one.
export const SECRET_GRACE_MS = 24 * 60 * 60_000;

// The secrets a webhook delivery is signed with at `now`: the current one,
// then the one a rotation replaced while its grace period lasts.
export function signingSecrets(
  target: Pick<NotificationTarget, "encryptedSecret" | "encryptedPreviousSecret" | "previousSecretExpiresAt">,
  now: Date,
): string[] {
  if (!target.encryptedSecret) throw new PermanentDeliveryError("No signing secret stored");
  const secrets = [decrypt(target.encryptedSecret)];
  if (target.encryptedPreviousSecret && target.previousSecretExpiresAt && target.previousSecretExpiresAt > now) {
    // A previous secret that cannot be read only loses its grace period; the
    // delivery still goes out signed with the current one.
    try {
      secrets.push(decrypt(target.encryptedPreviousSecret));
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
    }
  }
  return secrets;
}

// One "sha256=<hex>" per secret, comma separated, current secret first. A
// receiver accepts the delivery when any of them matches, so it keeps working
// whichever secret it holds during a rotation.
function signatures(secrets: string[], sign: (secret: string) => string): string {
  return secrets.map(sign).join(",");
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

export interface DeliverOptions {
  // The delivery row's id, the same on every retry so a receiver can tell a
  // retry from a new delivery. A fresh one when there is no row.
  deliveryId?: string;
  now?: Date;
}

// Throws on failure; callers decide whether that is logged or reported.
export async function deliver(
  target: NotificationTarget,
  workspaceId: string,
  payload: DeliveryPayload,
  options: DeliverOptions = {},
) {
  switch (target.kind) {
    case "webhook": {
      // Added at send time, not stored: each try gets its own timestamp, so a
      // retry hours later is not rejected as old.
      const now = options.now ?? new Date();
      const deliveryId = options.deliveryId ?? randomUUID();
      const seconds = Math.floor(now.getTime() / 1000);
      const timestamp = String(seconds);
      // The body's timestamp is the header's second, so the two never disagree,
      // and both are set after the payload so a stored key cannot replace them.
      const body = JSON.stringify({ ...payload, deliveryId, timestamp: new Date(seconds * 1000).toISOString() });
      const secrets = signingSecrets(target, now);
      await post(targetUrl(target), body, {
        [EVENT_HEADER]: payload.event,
        [DELIVERY_HEADER]: deliveryId,
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_V2_HEADER]: signatures(secrets, (secret) => timestampedSignature(secret, timestamp, body)),
        [SIGNATURE_HEADER]: signatures(secrets, (secret) => signature(secret, body)),
      });
      return;
    }
    case "slack": {
      const message = payload.event === "digest" ? slackDigest(payload) : slackMessage(payload);
      await post(targetUrl(target), JSON.stringify(message));
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
      const mail: { subject: string; text: string; html?: string } =
        payload.event === "digest" ? digestEmail(payload) : reviewEmail(payload, target.name);
      // One message each, so recipients do not see each other's addresses.
      const results = await Promise.allSettled(members.map(({ user }) => mailer.send({ to: user.email, ...mail })));
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
  // The row is written after sending, under the id the receiver was given.
  const id = randomUUID();
  let outcome: DeliveryOutcome;
  let httpStatus: number | null = null;
  try {
    await deliver(target, target.workspaceId, payload, { deliveryId: id });
    outcome = { ok: true };
  } catch (err) {
    if (err instanceof DeliveryError) httpStatus = err.httpStatus;
    outcome = { ok: false, error: redactError(message(err), storedUrl(target)) };
  }
  try {
    await prisma.notificationDelivery.create({
      data: {
        id,
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

// The sign-in provider whose identities are accounts on each forge; null for
// a forge nobody can sign in with, whose authors are never matched.
const SIGN_IN_FOR_FORGE: Record<ForgeProvider, SignInProvider | null> = { github: "github", gitlab: "gitlab" };

// A personal target hears about reviews of changes its member opened: the
// change's author id must be a sign-in identity the member linked on the same
// forge host, which the provider verified, so nobody can claim another
// person's changes. Returns the target and its member's user id, or null.
async function personalTarget(
  tx: Prisma.TransactionClient,
  job: Pick<ReviewJob, "authorId">,
  connection: { workspaceId: string; provider: ForgeProvider; host: string },
  possibleEvents: NotificationEvent[],
): Promise<{ target: NotificationTarget; userId: string } | null> {
  const provider = SIGN_IN_FOR_FORGE[connection.provider];
  if (!job.authorId || !provider) return null;
  // One query, run for every finished job: it returns nothing cheaply in a
  // workspace where nobody has a personal target.
  const found = await tx.notificationTarget.findFirst({
    where: {
      workspaceId: connection.workspaceId,
      active: true,
      events: { hasSome: possibleEvents },
      membership: {
        workspaceId: connection.workspaceId,
        user: { identities: { some: { provider, host: connection.host, providerUserId: job.authorId } } },
      },
    },
    include: { membership: { select: { userId: true } } },
  });
  if (!found?.membership) return null;
  const { membership, ...target } = found;
  return { target, userId: membership.userId };
}

// A digest target holds a review's row until its digest is built
// (worker/digests.ts). One with no due time (a schedule left incomplete
// outside the API) would never be picked up, so it gets each review instead
// of holding rows nothing sends.
function holdsForDigest(target: Pick<NotificationTarget, "deliveryMode" | "digestDueAt">): boolean {
  return target.deliveryMode !== "each" && target.digestDueAt !== null;
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
        include: {
          repository: { include: { connection: { select: { workspaceId: true, provider: true, host: true } } } },
        },
      });
      const baseEvents = eventsFor(job);
      if (!baseEvents.length) return;
      // Resolved depends on the previous review, which is only looked up when
      // a target can use it, so any finished review may be resolved here.
      const possibleEvents: NotificationEvent[] = job.status === "failed" ? baseEvents : [...baseEvents, "resolved"];
      // Paused targets are left out here, and pausing a target drops the rows
      // queued for it (dropPendingDeliveries), so a paused target misses this
      // job for good rather than catching up when it is resumed. A test
      // delivery still reaches it.
      const workspaceTargets = await tx.notificationTarget.findMany({
        where: {
          workspaceId: job.repository.connection.workspaceId,
          membershipId: null,
          active: true,
          events: { hasSome: possibleEvents },
          // An empty list is every repository.
          OR: [{ repositoryIds: { isEmpty: true } }, { repositoryIds: { has: job.repositoryId } }],
        },
      });
      const personal = await personalTarget(tx, job, job.repository.connection, possibleEvents);
      const candidates = personal ? [...workspaceTargets, personal.target] : workspaceTargets;
      if (!candidates.length) return;
      const needsPrevious =
        job.status !== "failed" &&
        candidates.some((target) => target.onlyVerdictChanges || target.events.includes("resolved"));
      const previous = needsPrevious ? await previousVerdict(tx, job) : undefined;
      const events = needsPrevious ? eventsFor(job, previous) : baseEvents;
      const summary = job.summary as ResultSummary | null;
      const facts: JobFilterFacts = { bySeverity: summary?.bySeverity ?? {}, verdict: job.verdict, previous };
      const targets = workspaceTargets.flatMap((target) => {
        const event = eventForTarget(events, target, facts);
        return event ? [{ target, event }] : [];
      });
      if (personal) {
        const event = eventForTarget(events, personal.target, facts);
        // A member already mailed about this review by a workspace email
        // target is not mailed a second time. A digest target does not count:
        // it mails the review hours or days later, and the member asked to
        // hear about their own change now.
        const mailed = targets.some(
          ({ target }) =>
            target.kind === "email" && target.recipientIds.includes(personal.userId) && !holdsForDigest(target),
        );
        if (event && !mailed) targets.push({ target: personal.target, event });
      }
      if (!targets.length) return;
      const now = new Date();
      await tx.notificationDelivery.createMany({
        data: targets.map(({ target, event }) => {
          // The filters above already chose it; a digest holds it.
          const digest = holdsForDigest(target);
          return {
            targetId: target.id,
            jobId: job.id,
            event,
            status: digest ? ("held" as const) : ("pending" as const),
            attempts: 0,
            payload: payloadFor(job, job.repository, event) as unknown as Prisma.InputJsonValue,
            nextAttemptAt: digest ? null : now,
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
// once it sees the target paused. Reviews held for a digest are deleted, as
// they never show in the history. Call in the transaction that pauses.
export async function dropPendingDeliveries(tx: Prisma.TransactionClient, targetId: string, now = new Date()) {
  await tx.notificationDelivery.deleteMany({ where: { targetId, status: "held" } });
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
    ),
    -- A raw UPDATE skips Prisma's @updatedAt.
    updated_at = now()
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

// Tells whoever can switch a paused target back on: the workspace's owners
// and admins, one message each, or the member for their personal target.
// Best effort: without mail, or when sending fails, the reason still shows on
// the Notifications page. A personal target only sends email, so its notice
// often fails for the same reason the target paused; it gets through when the
// failures were passing or specific to those messages.
export async function emailAboutPause(targetId: string, reason: string): Promise<void> {
  if (!mailer.configured()) return;
  try {
    const target = await prisma.notificationTarget.findUnique({
      where: { id: targetId },
      select: {
        name: true,
        membership: { select: { user: { select: { email: true } } } },
        workspace: { select: { id: true, name: true } },
      },
    });
    if (!target) return;
    let recipients: string[];
    let subject: string;
    let text: string;
    if (target.membership) {
      recipients = [target.membership.user.email];
      subject = oneLine(`Your review emails in ${target.workspace.name} were paused`);
      text =
        `${reason}.\n\nSentryward stopped emailing you about reviews of your changes. Switch them back on ` +
        `under Notifications:\n${env.CLIENT_ORIGIN}/notifications\n`;
    } else {
      const admins = await prisma.membership.findMany({
        where: { workspaceId: target.workspace.id, role: { in: ["owner", "admin"] } },
        select: { user: { select: { email: true } } },
      });
      recipients = admins.map(({ user }) => user.email);
      subject = oneLine(`Notification target "${target.name}" was paused in ${target.workspace.name}`);
      text =
        `${reason}.\n\nSentryward stopped sending to this target. Fix the endpoint, then switch the target ` +
        `back on under Notifications:\n${env.CLIENT_ORIGIN}/notifications?tab=failing\n`;
    }
    const results = await Promise.allSettled(recipients.map((to) => mailer.send({ to, subject, text })));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) console.error(`[notify] ${failed} of ${recipients.length} pause emails for target ${targetId} failed`);
  } catch (err) {
    console.error(`[notify] could not email about pausing target ${targetId}`, err);
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
      trigger: "manual",
    },
    repository: { provider: "github", fullPath: "example/repository" },
    change: {
      number: 1,
      title: "Test notification from Sentryward",
      url: null,
      headSha: "0000000000000000000000000000000000000000",
    },
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
    WHERE target_id = ANY(${targetIds}::uuid[]) AND status <> 'held'
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

// How many reviews each target holds for its next digest.
export async function heldCounts(targetIds: string[]): Promise<Map<string, number>> {
  if (!targetIds.length) return new Map();
  const rows = await prisma.notificationDelivery.groupBy({
    by: ["targetId"],
    where: { targetId: { in: targetIds }, status: "held" },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.targetId, row._count._all]));
}

// The per-target delivery views the dashboard shows, for a list of targets.
export async function deliveryStates(targetIds: string[]) {
  const [last, pending, held] = await Promise.all([
    lastDeliveries(targetIds),
    pendingDeliveries(targetIds),
    heldCounts(targetIds),
  ]);
  return {
    last: (id: string) => last.get(id) ?? null,
    pending: (id: string) => pending.get(id) ?? null,
    held: (id: string) => held.get(id) ?? 0,
  };
}

export type TargetStates = Awaited<ReturnType<typeof deliveryStates>>;

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

export const PERSONAL_TARGET_NAME = "Reviews of my changes";
// What a member who has never saved their personal notifications is shown.
export const PERSONAL_EVENTS_DEFAULT: NotificationEvent[] = ["failed", "blocked", "resolved"];

export interface PersonalForge {
  provider: ForgeProvider;
  host: string;
  linked: boolean;
}

// A member's view of their personal target; null before the first save.
export function publicPersonal(target: NotificationTarget | null, forges: PersonalForge[], mailConfigured: boolean) {
  return {
    enabled: target?.active ?? false,
    events: target ? EVENT_ORDER.filter((event) => target.events.includes(event)) : PERSONAL_EVENTS_DEFAULT,
    pausedReason: target?.pausedReason ?? null,
    forges,
    mailConfigured,
  };
}

// Only the host of a URL ever leaves the server: the full Slack URL is the
// credential, and a webhook URL may carry one in its query.
export function publicTarget(
  target: NotificationTarget,
  lastDelivery: LastDelivery | null = null,
  pending: PendingDeliveries | null = null,
  held = 0,
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
    delivery: {
      mode: target.deliveryMode,
      hour: target.digestHour,
      weekday: target.digestWeekday,
      timeZone: target.digestTimeZone,
      // Only while digests are on: a final digest after switching back is
      // an implementation detail, not a schedule.
      nextDigestAt: target.deliveryMode === "each" ? null : target.digestDueAt,
      held,
    },
    // While set, deliveries are also signed with the secret the last rotation
    // replaced.
    secretRotatedUntil:
      target.previousSecretExpiresAt && target.previousSecretExpiresAt > new Date()
        ? target.previousSecretExpiresAt
        : null,
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
