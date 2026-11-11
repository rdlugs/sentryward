import type { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { nextDigestAt } from "../services/digestSchedule.ts";
import { createDigestBuilder, type NotificationPayload, unblockedChanges } from "../services/notifications.ts";

// Targets handled per pass; the rest wait for the next poll.
const DIGEST_BATCH = 50;
// Held rows read at a time, so a busy week's payloads never sit in memory at once.
const HELD_PAGE = 500;
// Room for a large digest; Prisma's 5s default would roll back a busy week's
// digest on every poll.
const DIGEST_TRANSACTION_TIMEOUT_MS = 60_000;
// How long a target whose digest failed waits before it is tried again.
export const DIGEST_RETRY_MS = 60 * 60 * 1000;

// Builds the digest of every target whose digestDueAt has passed: its held
// reviews become one pending delivery (sent and retried like any other by
// deliveryQueue.ts) and are deleted, and the next due time is set, all in one
// transaction under the target's row lock. So a digest is queued exactly once,
// two workers never build the same one (SKIP LOCKED), a worker that was down
// at the due time builds it on its next poll, and an empty period just moves
// the schedule on. Returns how many digests were queued; a target whose digest
// fails is moved aside and retried later rather than blocking the others.
export async function runDueDigests(now = new Date()): Promise<number> {
  let queued = 0;
  for (let handled = 0; handled < DIGEST_BATCH; handled++) {
    // Set once the target is locked, so a failure can be pinned on it.
    let targetId: string | null = null;
    try {
      const result = await prisma.$transaction(
        (tx) =>
          buildNextDigest(tx, now, (id) => {
            targetId = id;
          }),
        { timeout: DIGEST_TRANSACTION_TIMEOUT_MS },
      );
      if (result === "none") break;
      if (result === "queued") queued++;
    } catch (err) {
      // Not knowing which target failed means nothing can be moved aside, so
      // the next poll would just fail the same way; let the caller log it.
      if (targetId === null) throw err;
      // The query below orders by digest_due_at, so a target left due would
      // be picked first again and stall every other target's digest. Moving
      // it later lets the rest go out; its held rows wait for the retry.
      console.error(`[worker] notification digest for target ${targetId} failed, retrying later`, err);
      await prisma.notificationTarget.update({
        where: { id: targetId },
        data: { digestDueAt: new Date(now.getTime() + DIGEST_RETRY_MS) },
      });
    }
  }
  return queued;
}

async function buildNextDigest(
  tx: Prisma.TransactionClient,
  now: Date,
  locked: (id: string) => void,
): Promise<"none" | "empty" | "queued"> {
  const [due] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM notification_targets
    WHERE digest_due_at <= ${now}
    ORDER BY digest_due_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `;
  if (!due) return "none";
  locked(due.id);
  const target = await tx.notificationTarget.findUniqueOrThrow({ where: { id: due.id } });
  const builder = createDigestBuilder({
    from: target.digestSince ?? now,
    to: now,
    timeZone: target.digestTimeZone ?? "UTC",
    schedule: target.deliveryMode === "each" ? null : target.deliveryMode,
  });
  let held = 0;
  let oldest: Date | null = null;
  // Each page is deleted once read (the transaction undoes it all on
  // failure), so the next read starts where this one ended and no statement
  // carries an unbounded id list. Reviews held after `now` wait for the next
  // digest, which also bounds the loop.
  for (;;) {
    const page = await tx.notificationDelivery.findMany({
      where: { targetId: target.id, status: "held", createdAt: { lte: now } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, payload: true, createdAt: true },
      take: HELD_PAGE,
    });
    if (!page.length) break;
    oldest ??= page[0]!.createdAt;
    builder.add(page.flatMap((row) => (row.payload ? [row.payload as unknown as NotificationPayload] : [])));
    await tx.notificationDelivery.deleteMany({ where: { id: { in: page.map((row) => row.id) } } });
    held += page.length;
    if (page.length < HELD_PAGE) break;
  }
  // A target back on one delivery per review has no schedule left, so this
  // final digest is its last.
  await tx.notificationTarget.update({
    where: { id: target.id },
    data: { digestSince: now, digestDueAt: nextDigestAt(target, now) },
  });
  if (!held) return "empty";

  const unblocked = await unblockedChanges(tx, builder.blockedChanges(), now);
  // The period starts at the earlier of digestSince and the oldest held
  // review, so it always covers every review it lists.
  const from = target.digestSince && target.digestSince < oldest! ? target.digestSince : oldest!;
  const payload = builder.build({ unblocked, from });
  await tx.notificationDelivery.create({
    data: {
      targetId: target.id,
      event: "digest",
      status: "pending",
      attempts: 0,
      payload: payload as unknown as Prisma.InputJsonValue,
      nextAttemptAt: now,
      createdAt: now,
    },
  });
  return "queued";
}
