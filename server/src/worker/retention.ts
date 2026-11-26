import { prisma } from "../lib/prisma.ts";
import { Prisma } from "../generated/prisma/client.ts";
import type { ReviewStatus } from "../generated/prisma/client.ts";
import { instancePolicy, shorterRetention } from "../services/privacyPolicy.ts";
import { HISTORY_MS } from "../review/learn/suggest.ts";
import { BURST_PAUSED_REASON } from "../review/config/filters.ts";

// Runs that reviewed nothing: once past the window the whole row goes.
const DELETED: ReviewStatus[] = ["superseded", "skipped", "cancelled"];
// Runs that reviewed something keep their row and summary digest, so lists,
// stats and findings (whose lastJobId points here) stay intact; only the large
// JSON columns are cleared. The newest completed or partial run of each change
// keeps them too: finding details, inline-thread answers and incremental
// reviews read its result.
const TRIMMED: ReviewStatus[] = ["completed", "partial", "failed"];

export interface PruneResult {
  deleted: number;
  trimmed: number;
}

interface PruneOptions {
  now?: Date;
  batchSize?: number;
  // Only these workspaces' data; absent means every workspace.
  workspaceIds?: string[];
}

const DAY_MS = 86_400_000;

function repositoryScope(workspaceIds?: string[]): Prisma.ReviewJobWhereInput {
  return workspaceIds ? { repository: { connection: { workspaceId: { in: workspaceIds } } } } : {};
}

function sqlScope(column: Prisma.Sql, workspaceIds?: string[]): Prisma.Sql {
  if (!workspaceIds) return Prisma.empty;
  return Prisma.sql`AND ${column} IN (
    SELECT r.id FROM repositories r JOIN forge_connections c ON c.id = r.connection_id
    WHERE c.workspace_id = ANY(${workspaceIds}::uuid[])
  )`;
}

// Works through ids a batch at a time so no statement holds row locks for
// long on a busy table. Every step is idempotent, so two workers pruning at
// once only repeat each other's work.
export async function pruneReviews(
  days: number,
  { now = new Date(), batchSize = 500, workspaceIds }: PruneOptions = {},
): Promise<PruneResult> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);

  let deleted = 0;
  for (;;) {
    const ids = await batchIds(
      { status: { in: DELETED }, finishedAt: { lt: cutoff }, ...repositoryScope(workspaceIds) },
      batchSize,
    );
    if (ids.length) {
      // A request ends the burst pauses that began before it (worker/burst.ts),
      // but rows are deleted by when they finished, not when they were made:
      // a superseded request can go while an older pause marker stays, and
      // the pause would come back. The markers it ended go with it.
      deleted += await prisma.$executeRaw`
        DELETE FROM review_jobs m USING review_jobs r
        WHERE r.id = ANY(${ids}::uuid[])
          -- Of the deleted statuses only a superseded request ended a pause.
          AND r.status = 'superseded'
          AND (r.trigger IN ('manual', 'comment') OR r.requested_at IS NOT NULL)
          AND m.repository_id = r.repository_id AND m.number = r.number
          AND m.trial = false AND m.status = 'skipped' AND m.error = ${BURST_PAUSED_REASON}
          AND m.created_at < COALESCE(r.requested_at, r.created_at)
          AND m.id <> ALL(${ids}::uuid[])`;
      deleted += (await prisma.reviewJob.deleteMany({ where: { id: { in: ids } } })).count;
    }
    if (ids.length < batchSize) break;
  }

  let trimmed = 0;
  for (;;) {
    const where = { status: { in: TRIMMED }, finishedAt: { lt: cutoff }, resultExpiredAt: null };
    const ids = await trimmableIds(cutoff, batchSize, workspaceIds);
    if (ids.length) {
      // The filter is repeated so a row trimmed by another worker in between
      // keeps its first expiry time.
      const { count } = await prisma.reviewJob.updateMany({
        where: { ...where, id: { in: ids } },
        data: { result: Prisma.DbNull, resolvedConfig: Prisma.DbNull, publication: Prisma.DbNull, resultExpiredAt: now },
      });
      trimmed += count;
    }
    if (ids.length < batchSize) break;
  }

  return { deleted, trimmed };
}

// Raw because Prisma cannot express "not the newest run of its change". Rows
// with nothing stored (a run that failed before reviewing) are skipped, so they
// still read as "did not run" rather than as an expired result. A trial is never
// a change's newest run: it never speaks for the change, so one finishing later
// must not cost the real latest review the result the backlog and incremental
// reviews build on, and nothing builds on a trial, so it is trimmed like any
// older run.
async function trimmableIds(cutoff: Date, batchSize: number, workspaceIds?: string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT j.id FROM review_jobs j
    WHERE j.status IN ('completed', 'partial', 'failed')
      AND j.finished_at < ${cutoff}
      AND j.result_expired_at IS NULL
      AND (j.result IS NOT NULL OR j.resolved_config IS NOT NULL OR j.publication IS NOT NULL)
      AND NOT (
        j.status IN ('completed', 'partial')
        AND j.trial = false
        AND NOT EXISTS (
          SELECT 1 FROM review_jobs n
          WHERE n.repository_id = j.repository_id
            AND n.number = j.number
            AND n.status IN ('completed', 'partial')
            AND n.trial = false
            AND n.finished_at > j.finished_at
        )
      )
      ${sqlScope(Prisma.sql`j.repository_id`, workspaceIds)}
    LIMIT ${batchSize}
  `;
  return rows.map((row) => row.id);
}

async function batchIds(where: Prisma.ReviewJobWhereInput, batchSize: number): Promise<string[]> {
  const rows = await prisma.reviewJob.findMany({ where, select: { id: true }, take: batchSize });
  return rows.map((row) => row.id);
}

export interface PurgeResult {
  changes: number;
  findings: number;
  postedFindings: number;
  replies: number;
}

// A change (repository + number) gone quiet for longer than the window loses
// what was kept about it beyond the review rows: its findings, the record of
// posted comments, finished thread replies (whose text is the commenter's),
// and the result its newest run kept for them. Whole changes only: deleting
// findings of a change still under review would lose their ignore state and
// lifecycle mid-PR. Job rows and summaries stay, so usage and the review list
// are unchanged. A change revived later is reviewed afresh; the forge's own
// markers keep inline comments from being posted twice. A change with findings
// the backlog could still take waits until the backlog sweep has asked the
// forge whether it merged (a failed check counts, so a broken forge delays it
// by one check, not for good), unless the sweep never will: the repository is
// turned off or its access is gone, and a merge recorded but not yet applied
// waits for the worker to apply it. Otherwise a worker down for longer than the
// window would purge merges it had not yet seen.
export async function purgeStaleChanges(
  days: number,
  { now = new Date(), batchSize = 200, workspaceIds }: PruneOptions = {},
): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const total: PurgeResult = { changes: 0, findings: 0, postedFindings: 0, replies: 0 };
  for (;;) {
    const changes = await staleChanges(cutoff, batchSize, workspaceIds);
    for (const change of changes) {
      const where = { repositoryId: change.repository_id, number: change.number };
      const [findings, posted, replies] = await prisma.$transaction([
        prisma.finding.deleteMany({ where }),
        prisma.postedFinding.deleteMany({ where }),
        prisma.threadReply.deleteMany({ where: { ...where, status: { in: ["done", "skipped", "failed"] } } }),
        prisma.reviewJob.updateMany({
          where: { ...where, resultExpiredAt: null, finishedAt: { lt: cutoff }, status: { in: TRIMMED } },
          data: { result: Prisma.DbNull, resolvedConfig: Prisma.DbNull, publication: Prisma.DbNull, resultExpiredAt: now },
        }),
        // What the backlog knew about it being open or closed; its backlog
        // items belong to the repository and stay. A merged row stays too: it
        // is the record that the merge was applied, so a later rerun, sweep or
        // redelivered webhook does not apply it again.
        prisma.changeState.deleteMany({ where: { ...where, state: { not: "merged" } } }),
      ]);
      total.changes++;
      total.findings += findings.count;
      total.postedFindings += posted.count;
      total.replies += replies.count;
    }
    if (changes.length < batchSize) break;
  }
  return total;
}

// Changes whose latest activity of any kind is before the cutoff, with nothing
// queued or running, and something left to purge (so a purged change is not
// picked again).
async function staleChanges(cutoff: Date, batchSize: number, workspaceIds?: string[]) {
  return prisma.$queryRaw<{ repository_id: string; number: number }[]>`
    WITH activity AS (
      SELECT repository_id, number, COALESCE(finished_at, created_at) AS at FROM review_jobs
      UNION ALL
      SELECT repository_id, number,
        GREATEST(last_seen_at, COALESCE(ignored_at, last_seen_at), COALESCE(resolved_at, last_seen_at)) FROM findings
      UNION ALL
      SELECT repository_id, number, created_at FROM thread_replies
      UNION ALL
      SELECT repository_id, number, created_at FROM posted_findings
    ), changes AS (
      SELECT repository_id, number FROM activity GROUP BY repository_id, number HAVING max(at) < ${cutoff}
    )
    SELECT c.repository_id, c.number FROM changes c
    WHERE NOT EXISTS (
        SELECT 1 FROM review_jobs j
        WHERE j.repository_id = c.repository_id AND j.number = c.number AND j.status IN ('queued', 'running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM thread_replies t
        WHERE t.repository_id = c.repository_id AND t.number = c.number AND t.status IN ('queued', 'running')
      )
      -- Unaddressed findings the backlog could still promote: on a change the
      -- sweep has not asked the forge about since they were last seen, or one
      -- recorded as merged that the worker has not applied yet.
      AND NOT EXISTS (
        SELECT 1 FROM findings f
        JOIN repositories r ON r.id = f.repository_id
        JOIN forge_connections fc ON fc.id = r.connection_id
        LEFT JOIN change_states s ON s.repository_id = f.repository_id AND s.number = f.number
        WHERE f.repository_id = c.repository_id AND f.number = c.number
          AND (f.state = 'open' OR (f.state = 'ignored' AND f.ignore_reason = 'fix_later'))
          AND r.enabled AND r.access_lost_at IS NULL AND fc.credentials_rejected_at IS NULL
          AND (
            s.id IS NULL
            OR (s.state = 'merged' AND s.merge_applied_at IS NULL)
            OR (s.state <> 'merged' AND s.checked_at < f.last_seen_at)
          )
      )
      AND (
        EXISTS (SELECT 1 FROM findings f WHERE f.repository_id = c.repository_id AND f.number = c.number)
        OR EXISTS (SELECT 1 FROM posted_findings p WHERE p.repository_id = c.repository_id AND p.number = c.number)
        OR EXISTS (SELECT 1 FROM thread_replies t WHERE t.repository_id = c.repository_id AND t.number = c.number)
        OR EXISTS (
          SELECT 1 FROM review_jobs j
          WHERE j.repository_id = c.repository_id AND j.number = c.number
            AND j.status IN ('completed', 'partial', 'failed') AND j.result_expired_at IS NULL
            AND j.finished_at < ${cutoff}
            AND (j.result IS NOT NULL OR j.resolved_config IS NOT NULL OR j.publication IS NOT NULL)
        )
      )
      ${sqlScope(Prisma.sql`c.repository_id`, workspaceIds)}
    LIMIT ${batchSize}
  `;
}

// Backlog items past the window. Resolved ones are deleted by when they were
// resolved, and open ones once neither their merge nor any review since has
// been within the window: an item nobody has seen for that long goes with the
// rest of what retention purges. A dismissal is a person's decision that must
// keep holding if the problem ships again, so a dismissed item is not deleted
// but scrubbed: its code-derived text and notes are cleared, the API stops
// showing it, and only the fingerprint and state remain.
export async function pruneBacklog(
  days: number,
  { now = new Date(), batchSize = 1000, workspaceIds }: PruneOptions = {},
): Promise<{ deleted: number; scrubbed: number }> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const scope: Prisma.BacklogItemWhereInput = workspaceIds
    ? { repository: { connection: { workspaceId: { in: workspaceIds } } } }
    : {};
  const stale: Prisma.BacklogItemWhereInput = {
    ...scope,
    OR: [
      { state: "resolved", resolvedAt: { lt: cutoff } },
      { state: "open", lastSeenAt: { lt: cutoff }, mergedAt: { lt: cutoff } },
    ],
  };
  const unscrubbed: Prisma.BacklogItemWhereInput = { ...scope, state: "dismissed", dismissedAt: { lt: cutoff }, scrubbedAt: null };
  let deleted = 0;
  let scrubbed = 0;
  for (;;) {
    const rows = await prisma.backlogItem.findMany({ where: stale, select: { id: true }, take: batchSize });
    if (rows.length) {
      deleted += (await prisma.backlogItem.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
    }
    if (rows.length < batchSize) break;
  }
  for (;;) {
    const rows = await prisma.backlogItem.findMany({ where: unscrubbed, select: { id: true }, take: batchSize });
    if (rows.length) {
      scrubbed += (
        await prisma.backlogItem.updateMany({
          // Checked again: a reopen between the read and this write keeps its text.
          where: { id: { in: rows.map((row) => row.id) }, state: "dismissed", scrubbedAt: null },
          data: {
            title: "",
            sourceChangeTitle: "",
            file: "",
            author: null,
            ignoreNote: null,
            dismissNote: null,
            ruleId: null,
            model: null,
            scrubbedAt: now,
          },
        })
      ).count;
    }
    if (rows.length < batchSize) break;
  }
  return { deleted, scrubbed };
}

// Review comments are kept only as rule suggestion evidence, which looks back
// HISTORY_MS, so none outlive that whatever the privacy period; a shorter
// period deletes them sooner. Suggestions keep ids and counts of their
// evidence, but its excerpts (people's words) go once what they quote is past
// the same cutoff, whatever the suggestion's status: privacy outranks an admin
// still deciding.
// Comments created, and excerpts quoting sources, before this are deleted.
// Shared with the rule suggestion run, which must not cite anything past it.
export function ruleHistoryCutoff(days: number | null, now: Date): Date {
  const windowDays = HISTORY_MS / DAY_MS;
  return new Date(now.getTime() - Math.min(days ?? windowDays, windowDays) * DAY_MS);
}

export async function pruneRuleHistory(
  days: number | null,
  { now = new Date(), batchSize = 1000, workspaceIds }: PruneOptions = {},
): Promise<{ comments: number; excerpts: number }> {
  const cutoff = ruleHistoryCutoff(days, now);
  const where: Prisma.ReviewCommentWhereInput = {
    createdAt: { lt: cutoff },
    ...(workspaceIds ? { repository: { connection: { workspaceId: { in: workspaceIds } } } } : {}),
  };
  let comments = 0;
  for (;;) {
    const rows = await prisma.reviewComment.findMany({ where, select: { id: true }, take: batchSize });
    if (rows.length) {
      comments += (await prisma.reviewComment.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
    }
    if (rows.length < batchSize) break;
  }
  const scope = workspaceIds ? Prisma.sql`AND workspace_id = ANY(${workspaceIds}::uuid[])` : Prisma.empty;
  // Each excerpt by its source's time: a new suggestion may quote a comment or
  // dismissal already near the cutoff. One stored without `at` falls back to
  // the suggestion's own age. The rows are locked in id order first, as the
  // settings save's excerpt strip does: two bulk UPDATEs locking the same rows
  // in different orders would deadlock. The result counts excerpts removed,
  // not rows changed, so it is taken from the locked read: the rows cannot
  // change before the UPDATE, which drops exactly the excerpts counted here.
  const excerpts = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; expired: number }[]>`
      SELECT id, (
        SELECT count(*) FROM jsonb_array_elements(evidence->'excerpts') e
        WHERE COALESCE((e->>'at')::timestamptz, created_at) < ${cutoff}
      )::int AS expired
      FROM rule_suggestions
      WHERE jsonb_typeof(evidence->'excerpts') = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(evidence->'excerpts') e
          WHERE COALESCE((e->>'at')::timestamptz, created_at) < ${cutoff}
        )
        ${scope}
      ORDER BY id FOR UPDATE
    `;
    if (!locked.length) return 0;
    await tx.$executeRaw`
      UPDATE rule_suggestions SET evidence = jsonb_set(evidence, '{excerpts}', COALESCE(
        (SELECT jsonb_agg(x.e ORDER BY x.i) FROM jsonb_array_elements(evidence->'excerpts') WITH ORDINALITY x(e, i)
         WHERE COALESCE((x.e->>'at')::timestamptz, created_at) >= ${cutoff}),
        '[]'::jsonb
      ))
      WHERE id = ANY(${locked.map((row) => row.id)}::uuid[])
    `;
    return locked.reduce((sum, row) => sum + row.expired, 0);
  });
  return { comments, excerpts };
}

export interface RetentionResult extends PruneResult, PurgeResult {
  auditRows: number;
  oauthStates: number;
  deliveries: number;
  backlogItems: number;
  backlogScrubbed: number;
  budgetAlerts: number;
  reviewComments: number;
  suggestionExcerpts: number;
}

// The delivery log answers "is this target working", so recent rows are all it
// needs; a fixed window keeps a busy target from growing it without bound. A
// workspace whose privacy retention is shorter keeps its log for that long
// instead, since a delivery row describes a review that is already gone.
export const DELIVERY_RETENTION_DAYS = 30;
// Budget alert rows only matter for their own month (each threshold is
// announced once a month); a year and a bit leaves the card's history and a
// year-on-year look. They hold no change content, so privacy retention does
// not shorten them, and a shorter period would let a month announce a
// threshold twice.
export const BUDGET_ALERT_RETENTION_DAYS = 400;
export const DELIVERIES_PER_TARGET = 100;

// Deletes deliveries older than `days`, a batch at a time like pruneReviews.
// Unscoped (every workspace) it also enforces the per-target cap; that cap is
// the same for everyone, so the scoped passes leave it to the unscoped one.
export async function pruneDeliveries(
  days: number,
  { now = new Date(), batchSize = 1000, workspaceIds }: PruneOptions = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  // Pending rows are still being sent; giving up bounds how long they last.
  // Held rows wait for their digest, which deletes them, so the fixed window
  // leaves them alone. A scoped pass is a workspace's privacy retention,
  // which wins over a complete digest: a held row carries forge text (titles,
  // errors) about a review that pass has already deleted.
  const where: Prisma.NotificationDeliveryWhereInput = {
    status: { notIn: workspaceIds ? ["pending"] : ["pending", "held"] },
    createdAt: { lt: cutoff },
    ...(workspaceIds ? { target: { workspaceId: { in: workspaceIds } } } : {}),
  };
  let deleted = 0;
  for (;;) {
    const rows = await prisma.notificationDelivery.findMany({ where, select: { id: true }, take: batchSize });
    if (rows.length) {
      deleted += (await prisma.notificationDelivery.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
    }
    if (rows.length < batchSize) break;
  }
  if (workspaceIds) return deleted;

  for (;;) {
    const surplus = await prisma.$executeRaw`
      DELETE FROM notification_deliveries WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY target_id ORDER BY created_at DESC, id DESC) AS rank
          FROM notification_deliveries
          WHERE status NOT IN ('pending', 'held')
        ) ranked
        WHERE rank > ${DELIVERIES_PER_TARGET}
        LIMIT ${batchSize}
      )
    `;
    deleted += surplus;
    if (surplus < batchSize) break;
  }
  return deleted;
}

// One retention pass: each workspace by its effective period (the shorter of
// its own and the instance's), then the audit log by the instance's audit
// period. Workspaces sharing a period are pruned together.
export async function runRetention({ now = new Date() }: { now?: Date } = {}): Promise<RetentionResult> {
  const instance = await instancePolicy();
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, privacy: { select: { retentionDays: true } } },
  });
  const byDays = new Map<number, string[]>();
  // Workspaces with no privacy period still lose review comments past the
  // suggestion window.
  const unlimited: string[] = [];
  for (const workspace of workspaces) {
    const days = shorterRetention(instance.retentionDays, workspace.privacy?.retentionDays ?? null);
    if (days === null) {
      unlimited.push(workspace.id);
      continue;
    }
    byDays.set(days, [...(byDays.get(days) ?? []), workspace.id]);
  }

  const result: RetentionResult = {
    deleted: 0,
    trimmed: 0,
    changes: 0,
    findings: 0,
    postedFindings: 0,
    replies: 0,
    auditRows: 0,
    oauthStates: 0,
    deliveries: 0,
    backlogItems: 0,
    backlogScrubbed: 0,
    budgetAlerts: 0,
    reviewComments: 0,
    suggestionExcerpts: 0,
  };
  for (const [days, workspaceIds] of byDays) {
    const pruned = await pruneReviews(days, { now, workspaceIds });
    const purged = await purgeStaleChanges(days, { now, workspaceIds });
    result.deleted += pruned.deleted;
    result.trimmed += pruned.trimmed;
    result.changes += purged.changes;
    result.findings += purged.findings;
    result.postedFindings += purged.postedFindings;
    result.replies += purged.replies;
    const backlog = await pruneBacklog(days, { now, workspaceIds });
    result.backlogItems += backlog.deleted;
    result.backlogScrubbed += backlog.scrubbed;
    if (days < DELIVERY_RETENTION_DAYS) {
      result.deliveries += await pruneDeliveries(days, { now, workspaceIds });
    }
    const history = await pruneRuleHistory(days, { now, workspaceIds });
    result.reviewComments += history.comments;
    result.suggestionExcerpts += history.excerpts;
  }
  if (unlimited.length) {
    const history = await pruneRuleHistory(null, { now, workspaceIds: unlimited });
    result.reviewComments += history.comments;
    result.suggestionExcerpts += history.excerpts;
  }

  if (instance.auditRetentionDays !== null) {
    const cutoff = new Date(now.getTime() - instance.auditRetentionDays * DAY_MS);
    for (;;) {
      const rows = await prisma.llmRequestLog.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: 1000 });
      if (rows.length) {
        result.auditRows += (await prisma.llmRequestLog.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
      }
      if (rows.length < 1000) break;
    }
  }

  // The start handlers only clear expired OAuth round trips when another one
  // begins, so without this an abandoned one (which can hold an encrypted
  // invite token) would outlive its TTL indefinitely on a quiet instance.
  const expired = { expiresAt: { lt: now } };
  result.oauthStates += (await prisma.signInState.deleteMany({ where: expired })).count;
  result.oauthStates += (await prisma.oAuthState.deleteMany({ where: expired })).count;
  result.deliveries += await pruneDeliveries(DELIVERY_RETENTION_DAYS, { now });
  result.budgetAlerts += (
    await prisma.budgetAlert.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - BUDGET_ALERT_RETENTION_DAYS * DAY_MS) } },
    })
  ).count;
  return result;
}
