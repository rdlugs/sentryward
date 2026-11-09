import { prisma } from "../lib/prisma.ts";
import { Prisma } from "../generated/prisma/client.ts";
import type { ReviewStatus } from "../generated/prisma/client.ts";
import { instancePolicy, shorterRetention } from "../services/privacyPolicy.ts";

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
// still read as "did not run" rather than as an expired result.
async function trimmableIds(cutoff: Date, batchSize: number, workspaceIds?: string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT j.id FROM review_jobs j
    WHERE j.status IN ('completed', 'partial', 'failed')
      AND j.finished_at < ${cutoff}
      AND j.result_expired_at IS NULL
      AND (j.result IS NOT NULL OR j.resolved_config IS NOT NULL OR j.publication IS NOT NULL)
      AND NOT (
        j.status IN ('completed', 'partial')
        AND NOT EXISTS (
          SELECT 1 FROM review_jobs n
          WHERE n.repository_id = j.repository_id
            AND n.number = j.number
            AND n.status IN ('completed', 'partial')
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
// markers keep inline comments from being posted twice.
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

export interface RetentionResult extends PruneResult, PurgeResult {
  auditRows: number;
  oauthStates: number;
  deliveries: number;
}

// The delivery log answers "is this target working", so recent rows are all it
// needs; a fixed window keeps a busy target from growing it without bound. A
// workspace whose privacy retention is shorter keeps its log for that long
// instead, since a delivery row describes a review that is already gone.
export const DELIVERY_RETENTION_DAYS = 30;
export const DELIVERIES_PER_TARGET = 100;

// Deletes deliveries older than `days`, a batch at a time like pruneReviews.
// Unscoped (every workspace) it also enforces the per-target cap; that cap is
// the same for everyone, so the scoped passes leave it to the unscoped one.
export async function pruneDeliveries(
  days: number,
  { now = new Date(), batchSize = 1000, workspaceIds }: PruneOptions = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const where: Prisma.NotificationDeliveryWhereInput = {
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
  for (const workspace of workspaces) {
    const days = shorterRetention(instance.retentionDays, workspace.privacy?.retentionDays ?? null);
    if (days === null) continue;
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
    if (days < DELIVERY_RETENTION_DAYS) {
      result.deliveries += await pruneDeliveries(days, { now, workspaceIds });
    }
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
  return result;
}
