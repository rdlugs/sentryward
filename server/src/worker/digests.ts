import type { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { nextDigestAt } from "../services/digestSchedule.ts";
import { digestPayloadFor, type NotificationPayload } from "../services/notifications.ts";

// Targets handled per pass; the rest wait for the next poll.
const DIGEST_BATCH = 50;

// Builds the digest of every target whose digestDueAt has passed: its held
// reviews become one pending delivery (sent and retried like any other by
// deliveryQueue.ts) and are deleted, and the next due time is set, all in one
// transaction under the target's row lock. So a digest is queued exactly once,
// two workers never build the same one (SKIP LOCKED), a worker that was down
// at the due time builds it on its next poll, and an empty period just moves
// the schedule on. Held rows are deleted by id, so a review held while this
// runs waits for the next digest instead of being lost. Returns how many
// digests were queued.
export async function runDueDigests(now = new Date()): Promise<number> {
  let queued = 0;
  for (let handled = 0; handled < DIGEST_BATCH; handled++) {
    const result = await prisma.$transaction((tx) => buildNextDigest(tx, now));
    if (result === "none") break;
    if (result === "queued") queued++;
  }
  return queued;
}

async function buildNextDigest(tx: Prisma.TransactionClient, now: Date): Promise<"none" | "empty" | "queued"> {
  const [due] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM notification_targets
    WHERE digest_due_at <= ${now}
    ORDER BY digest_due_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `;
  if (!due) return "none";
  const target = await tx.notificationTarget.findUniqueOrThrow({ where: { id: due.id } });
  const held = await tx.notificationDelivery.findMany({
    where: { targetId: target.id, status: "held" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, payload: true, createdAt: true },
  });
  // A target back on one delivery per review has no schedule left, so this
  // final digest is its last.
  await tx.notificationTarget.update({
    where: { id: target.id },
    data: { digestSince: now, digestDueAt: nextDigestAt(target, now) },
  });
  if (!held.length) return "empty";

  const payloads = held.flatMap((row) => (row.payload ? [row.payload as unknown as NotificationPayload] : []));
  const payload = digestPayloadFor(payloads, {
    from: target.digestSince ?? held[0]!.createdAt,
    to: now,
    timeZone: target.digestTimeZone ?? "UTC",
    schedule: target.deliveryMode === "each" ? null : target.deliveryMode,
  });
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
  await tx.notificationDelivery.deleteMany({ where: { id: { in: held.map((row) => row.id) } } });
  return "queued";
}
