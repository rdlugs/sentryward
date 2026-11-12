import { Prisma } from "../generated/prisma/client.ts";
import type { NotificationTarget } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import {
  classifyFailure,
  DeliveryError,
  deliver,
  emailAboutPause,
  MAX_DELIVERY_ATTEMPTS,
  message,
  type DeliveryPayload,
  PAUSED_BEFORE_SEND,
  recordTargetFailure,
  redactError,
  retryDelayMs,
  storedHost,
  storedUrl,
} from "../services/notifications.ts";

// Far past a send's own limits (a 10s fetch timeout, 10s SMTP timeouts), so a
// lock this old means the worker holding it is gone.
export const DELIVERY_LOCK_TIMEOUT_MS = 5 * 60_000;

// Due job deliveries, claimed like review jobs (queue.ts claimNext): SKIP
// LOCKED so two workers never send one row at the same time. The claim counts
// the attempt before sending, so a worker that dies mid-send still uses one up.
// locked_at doubles as the claim's token (runDelivery only finishes a row
// still locked at that instant), so it is cut to the milliseconds a JS Date
// holds; Postgres keeps microseconds, which would never compare equal.
export async function claimDueDeliveries(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE notification_deliveries
    SET locked_at = date_trunc('milliseconds', clock_timestamp()), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM notification_deliveries
      WHERE status = 'pending' AND locked_at IS NULL AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id
  `;
  return rows.map((row) => row.id);
}

// Rows a dead worker was sending: due again at once, or failed once out of
// attempts. The far end may have taken the lost send, so this can deliver
// twice; that is rarer and cheaper than a notification never sent. A worker
// dying is not the target's fault, so the failure is not counted against it.
export async function recoverStaleDeliveries(lockTimeoutMs = DELIVERY_LOCK_TIMEOUT_MS): Promise<number> {
  const stale = { status: "pending", lockedAt: { lt: new Date(Date.now() - lockTimeoutMs) } } as const;
  const [requeued, failed] = await prisma.$transaction([
    prisma.notificationDelivery.updateMany({
      where: { ...stale, attempts: { lt: MAX_DELIVERY_ATTEMPTS } },
      data: { lockedAt: null },
    }),
    prisma.notificationDelivery.updateMany({
      where: { ...stale, attempts: { gte: MAX_DELIVERY_ATTEMPTS } },
      data: {
        status: "failed",
        error: "Worker stopped responding",
        httpStatus: null,
        lockedAt: null,
        nextAttemptAt: null,
        payload: Prisma.DbNull,
        finishedAt: new Date(),
      },
    }),
  ]);
  return requeued.count + failed.count;
}

export interface RunDeliveryDeps {
  deliver: (
    target: NotificationTarget,
    workspaceId: string,
    payload: DeliveryPayload,
    options: { deliveryId: string; now: Date },
  ) => Promise<void>;
  now: () => Date;
}

const defaultDeps: RunDeliveryDeps = { deliver, now: () => new Date() };

// The fields a row loses once it is final.
const settled = { lockedAt: null, nextAttemptAt: null, payload: Prisma.DbNull };

// Sends one claimed row and records the outcome: sent, due again after a
// backoff, or failed for good (which counts against the target and may pause
// it). Every write is conditional on the row still being pending under this
// claim, so a row stale recovery handed to another worker is never marked
// twice and a sent row is never sent again. Never throws.
export async function runDelivery(id: string, deps: RunDeliveryDeps = defaultDeps): Promise<void> {
  try {
    const row = await prisma.notificationDelivery.findUnique({ where: { id }, include: { target: true } });
    if (!row || row.status !== "pending" || !row.lockedAt || !row.payload) return;
    const claim = { id, status: "pending", lockedAt: row.lockedAt } as const;
    const { target } = row;

    // Pausing drops queued rows (dropPendingDeliveries); this catches one
    // claimed in the moment before the pause.
    if (!target.active) {
      await prisma.notificationDelivery.updateMany({
        where: claim,
        data: { ...settled, status: "failed", error: PAUSED_BEFORE_SEND, finishedAt: deps.now() },
      });
      return;
    }

    let err: unknown = null;
    try {
      // The row id is the delivery id, so every retry of a row carries the same one.
      // The send's timestamp comes from the same clock as the row's outcome.
      await deps.deliver(target, target.workspaceId, row.payload as unknown as DeliveryPayload, {
        deliveryId: row.id,
        now: deps.now(),
      });
    } catch (caught) {
      err = caught ?? new Error("Unknown error");
    }
    const now = deps.now();

    if (err === null) {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.notificationDelivery.updateMany({
          where: claim,
          data: { ...settled, status: "sent", httpStatus: null, error: null, finishedAt: now },
        });
        if (count) await tx.notificationTarget.update({ where: { id: target.id }, data: { consecutiveFailures: 0 } });
      });
      return;
    }

    const httpStatus = err instanceof DeliveryError ? err.httpStatus : null;
    // An HTTP failure is fully described by its status, as in the test log.
    const error = httpStatus !== null ? null : redactError(message(err), storedUrl(target));
    const failure = classifyFailure(err, target.kind, storedHost(target));
    const detail = error ?? `HTTP ${httpStatus}`;

    if (failure === "retryable" && row.attempts < MAX_DELIVERY_ATTEMPTS) {
      const nextAttemptAt = new Date(now.getTime() + retryDelayMs(row.attempts, err));
      // A target paused while this was sending had its queued rows dropped, but
      // not this locked one; rescheduling it would send after a resume. The
      // target row lock orders this against a concurrent pause.
      const rescheduled = await prisma.$transaction(async (tx) => {
        const [current] = await tx.$queryRaw<{ active: boolean }[]>`
          SELECT active FROM notification_targets WHERE id = ${target.id}::uuid FOR SHARE
        `;
        if (!current?.active) {
          await tx.notificationDelivery.updateMany({
            where: claim,
            data: { ...settled, status: "failed", httpStatus, error, finishedAt: now },
          });
          return false;
        }
        await tx.notificationDelivery.updateMany({
          where: claim,
          data: { lockedAt: null, nextAttemptAt, httpStatus, error },
        });
        return true;
      });
      if (!rescheduled) {
        console.error(`[notify] target ${target.id} delivery ${id} failed (${detail}); target was paused, not retrying`);
        return;
      }
      console.error(
        `[notify] target ${target.id} delivery ${id} attempt ${row.attempts} failed (${detail}); retrying at ${nextAttemptAt.toISOString()}`,
      );
      return;
    }

    const { count } = await prisma.notificationDelivery.updateMany({
      where: claim,
      data: { ...settled, status: "failed", httpStatus, error, finishedAt: now },
    });
    console.error(`[notify] target ${target.id} delivery ${id} failed after ${row.attempts} attempt(s): ${detail}`);
    if (!count) return;
    const reason = await recordTargetFailure(target.id, { httpStatus, gone: failure === "gone" });
    if (reason) {
      console.error(`[notify] target ${target.id} paused: ${reason}`);
      await emailAboutPause(target.id, reason);
    }
  } catch (err) {
    // Left locked; stale recovery makes it due again.
    console.error(`[notify] could not run delivery ${id}`, err);
  }
}
