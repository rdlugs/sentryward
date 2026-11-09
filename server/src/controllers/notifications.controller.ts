import type { Request, Response } from "express";
import { encrypt } from "../lib/crypto.ts";
import { assertSafeUrl } from "../lib/hostSafety.ts";
import { HttpError } from "../lib/httpError.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import {
  createNotificationSchema,
  deliveriesQuerySchema,
  notificationParamsSchema,
  updateNotificationSchema,
} from "../schemas/notifications.schema.ts";
import {
  DELIVERY_ORDER,
  lastDeliveries,
  newWebhookSecret,
  publicDelivery,
  publicTarget,
  testTarget,
} from "../services/notifications.ts";

async function loadTarget(req: Request) {
  const { id } = notificationParamsSchema.parse(req.params);
  const target = await prisma.notificationTarget.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!target) {
    throw new HttpError(404, "Notification target not found");
  }
  return target;
}

// Recipients are chosen from the workspace's members, never typed in, so a
// target cannot mail arbitrary addresses.
async function assertMembers(workspaceId: string, userIds: string[]) {
  const count = await prisma.membership.count({ where: { workspaceId, userId: { in: userIds } } });
  if (count !== userIds.length) {
    throw new HttpError(400, "Validation failed", { recipientIds: ["Choose members of this workspace"] });
  }
}

export async function listNotifications(req: Request, res: Response) {
  const targets = await prisma.notificationTarget.findMany({
    where: { workspaceId: req.workspaceId },
    orderBy: { createdAt: "asc" },
  });
  const last = await lastDeliveries(targets.map((target) => target.id));
  // Lets the dashboard explain why email targets cannot be added.
  res.json({
    targets: targets.map((target) => publicTarget(target, last.get(target.id) ?? null)),
    mailConfigured: mailer.configured(),
  });
}

// Newest first. Members can read it like the list: stored errors never carry
// the target URL.
export async function listDeliveries(req: Request, res: Response) {
  const target = await loadTarget(req);
  const { page, limit } = deliveriesQuerySchema.parse(req.query);
  const where = { targetId: target.id };
  const [deliveries, total] = await prisma.$transaction([
    prisma.notificationDelivery.findMany({
      where,
      orderBy: DELIVERY_ORDER,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.notificationDelivery.count({ where }),
  ]);
  res.json({ deliveries: deliveries.map(publicDelivery), total, page, limit });
}

// A webhook's signing secret is in this response only; the dashboard never
// shows it again. A new target has never delivered, so its lastDelivery is
// null without a lookup.
export async function createNotification(req: Request, res: Response) {
  const input = createNotificationSchema.parse(req.body);
  const workspaceId = req.workspaceId!;
  const base = { workspaceId, kind: input.kind, name: input.name, events: input.events };

  if (input.kind === "email") {
    if (!mailer.configured()) {
      throw new HttpError(400, "Email notifications need mail to be configured (SMTP_URL)");
    }
    await assertMembers(workspaceId, input.recipientIds);
    const target = await prisma.notificationTarget.create({ data: { ...base, recipientIds: input.recipientIds } });
    res.status(201).json({ target: publicTarget(target) });
    return;
  }

  try {
    await assertSafeUrl(input.url);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new HttpError(400, "Validation failed", { url: [error.message] });
    }
    throw error;
  }
  const secret = input.kind === "webhook" ? newWebhookSecret() : undefined;
  const target = await prisma.notificationTarget.create({
    data: { ...base, encryptedUrl: encrypt(input.url), encryptedSecret: secret ? encrypt(secret) : null },
  });
  res.status(201).json({ target: publicTarget(target), ...(secret ? { secret } : {}) });
}

export async function updateNotification(req: Request, res: Response) {
  const target = await loadTarget(req);
  const input = updateNotificationSchema.parse(req.body);
  if (input.recipientIds) {
    if (target.kind !== "email") {
      throw new HttpError(400, "Validation failed", { recipientIds: ["Only email targets have recipients"] });
    }
    await assertMembers(target.workspaceId, input.recipientIds);
  }
  const updated = await prisma.notificationTarget.update({ where: { id: target.id }, data: input });
  const last = await lastDeliveries([updated.id]);
  res.json({ target: publicTarget(updated, last.get(updated.id) ?? null) });
}

// Sends a sample; a delivery that fails is reported as the result, not an error.
export async function testNotification(req: Request, res: Response) {
  const target = await loadTarget(req);
  res.json({ result: await testTarget(target) });
}

export async function deleteNotification(req: Request, res: Response) {
  const { id } = notificationParamsSchema.parse(req.params);
  const { count } = await prisma.notificationTarget.deleteMany({ where: { id, workspaceId: req.workspaceId } });
  if (count === 0) {
    throw new HttpError(404, "Notification target not found");
  }
  res.status(204).end();
}
