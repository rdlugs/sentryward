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
  notificationSettingsSchema,
  updateNotificationSchema,
} from "../schemas/notifications.schema.ts";
import {
  DELIVERY_ORDER,
  deliveryStates,
  dropPendingDeliveries,
  newWebhookSecret,
  publicDelivery,
  publicTarget,
  SCOPE_REASON,
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

// Only the workspace's own repositories can be named, so a target cannot be
// pointed at (or reveal the existence of) another workspace's.
async function assertRepositories(workspaceId: string, repositoryIds: string[]) {
  if (!repositoryIds.length) return;
  const count = await prisma.repository.count({
    where: { id: { in: repositoryIds }, connection: { workspaceId } },
  });
  if (count !== repositoryIds.length) {
    throw new HttpError(400, "Validation failed", { repositoryIds: ["Choose repositories in this workspace"] });
  }
}

export async function listNotifications(req: Request, res: Response) {
  const [targets, workspace] = await Promise.all([
    prisma.notificationTarget.findMany({ where: { workspaceId: req.workspaceId }, orderBy: { createdAt: "asc" } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: req.workspaceId }, select: { notifyAutoPauseAfter: true } }),
  ]);
  const states = await deliveryStates(targets.map((target) => target.id));
  // mailConfigured lets the dashboard explain why email targets cannot be added.
  res.json({
    targets: targets.map((target) => publicTarget(target, states.last(target.id), states.pending(target.id))),
    mailConfigured: mailer.configured(),
    settings: { autoPauseAfter: workspace.notifyAutoPauseAfter },
  });
}

// Applies from the next delivery that fails for good; targets already past a
// lowered limit are paused then, not now.
export async function updateNotificationSettings(req: Request, res: Response) {
  const { autoPauseAfter } = notificationSettingsSchema.parse(req.body);
  const workspace = await prisma.workspace.update({
    where: { id: req.workspaceId },
    data: { notifyAutoPauseAfter: autoPauseAfter },
    select: { notifyAutoPauseAfter: true },
  });
  res.json({ settings: { autoPauseAfter: workspace.notifyAutoPauseAfter } });
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
  const base = {
    workspaceId,
    kind: input.kind,
    name: input.name,
    events: input.events,
    repositoryIds: input.repositoryIds,
    minSeverity: input.minSeverity,
    onlyVerdictChanges: input.onlyVerdictChanges,
  };
  await assertRepositories(workspaceId, input.repositoryIds);

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
  if (input.repositoryIds) await assertRepositories(target.workspaceId, input.repositoryIds);
  // Paused because its repositories were deleted: an empty list now means
  // every repository, so it stays off until an admin saves a choice (All
  // included) on purpose. Saving one clears the reason; it stays paused.
  const scopePaused = target.pausedReason === SCOPE_REASON && input.repositoryIds === undefined;
  if (scopePaused && input.active === true) {
    throw new HttpError(400, "Validation failed", {
      repositoryIds: ["Its repositories were removed; choose repositories, or All, before switching it on"],
    });
  }
  // An admin switching a target either way takes over from auto-pause: the
  // reason no longer applies and the failure count starts again. A scope
  // reason stays until repositories are saved, or switching it off and on
  // again would get round the check above.
  const clearReason = input.active !== undefined ? !scopePaused : target.pausedReason === SCOPE_REASON && !scopePaused;
  const data = {
    ...input,
    ...(input.active !== undefined ? { consecutiveFailures: 0 } : {}),
    ...(clearReason ? { pausedReason: null } : {}),
  };
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.notificationTarget.update({ where: { id: target.id }, data });
    // Paused means its queued deliveries are dropped, not held for a resume.
    if (input.active === false) await dropPendingDeliveries(tx, target.id);
    return row;
  });
  const states = await deliveryStates([updated.id]);
  res.json({ target: publicTarget(updated, states.last(updated.id), states.pending(updated.id)) });
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
