import type { Request, Response } from "express";
import type { NotificationTarget, Prisma } from "../generated/prisma/client.ts";
import { encrypt } from "../lib/crypto.ts";
import { assertSafeUrl } from "../lib/hostSafety.ts";
import { HttpError } from "../lib/httpError.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import {
  createNotificationSchema,
  type DeliveryInput,
  deliveriesQuerySchema,
  notificationParamsSchema,
  notificationSettingsSchema,
  personalNotificationSchema,
  updateNotificationSchema,
} from "../schemas/notifications.schema.ts";
import { nextDigestAt } from "../services/digestSchedule.ts";
import {
  DELIVERY_ORDER,
  deliveryStates,
  dropPendingDeliveries,
  newWebhookSecret,
  PERSONAL_TARGET_NAME,
  publicDelivery,
  publicPersonal,
  publicTarget,
  SCOPE_REASON,
  SECRET_GRACE_MS,
  testTarget,
} from "../services/notifications.ts";

// Workspace targets only: a member's personal target is never listed, edited,
// tested or shown in a delivery log through these routes, even to admins.
async function loadTarget(req: Request) {
  const { id } = notificationParamsSchema.parse(req.params);
  const target = await prisma.notificationTarget.findFirst({
    where: { id, workspaceId: req.workspaceId, membershipId: null },
  });
  if (!target) {
    throw new HttpError(404, "Notification target not found");
  }
  return target;
}

// The same check every delivery makes (services/notifications.ts post), run
// on save so a refused URL is a field error rather than a target that fails.
async function assertSafeTargetUrl(url: string) {
  try {
    await assertSafeUrl(url);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new HttpError(400, "Validation failed", { url: [error.message] });
    }
    throw error;
  }
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
// pointed at (or reveal the existence of) another workspace's. Run in the
// transaction that saves the ids: FOR SHARE makes a repository deletion wait
// until the save commits, so its dropRepositoriesFromTargets then sees (and
// removes) the saved id; a deletion that committed first leaves the row
// missing here and the save is refused.
async function assertRepositories(tx: Prisma.TransactionClient, workspaceId: string, repositoryIds: string[]) {
  if (!repositoryIds.length) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM repositories r
    JOIN forge_connections c ON c.id = r.connection_id
    WHERE r.id = ANY(${repositoryIds}::uuid[]) AND c.workspace_id = ${workspaceId}::uuid
    FOR SHARE OF r
  `;
  if (rows.length !== repositoryIds.length) {
    throw new HttpError(400, "Validation failed", { repositoryIds: ["Choose repositories in this workspace"] });
  }
}

// The stored form of a delivery choice, and when the next digest is due.
// Switching to digests (or changing their schedule) starts counting from now;
// reviews already held carry over into the next digest. Switching back to one
// delivery per review keeps the schedule fields (so the form can offer them
// again) and makes the target due at once, so whatever it held goes out as a
// final digest on the worker's next poll. Pass the target being updated, if
// any.
function deliveryData(input: DeliveryInput, current: NotificationTarget | null, now = new Date()) {
  if (input.mode === "each") {
    const wasDigest = current !== null && current.deliveryMode !== "each";
    return { deliveryMode: input.mode, ...(wasDigest ? { digestDueAt: now } : {}) };
  }
  const schedule = {
    deliveryMode: input.mode,
    digestHour: input.hour,
    digestWeekday: input.mode === "weekly" ? input.weekday : null,
    digestTimeZone: input.timeZone,
  };
  // A target switched back to each review still owes a final digest until the
  // worker builds it (digestDueAt set); coming back to digests before then
  // keeps that period, so its held reviews go out in the next digest under
  // the right "from".
  const startsPeriod = current === null || (current.deliveryMode === "each" && current.digestDueAt === null);
  return {
    ...schedule,
    digestDueAt: nextDigestAt(schedule, now),
    ...(startsPeriod ? { digestSince: now } : {}),
  };
}

export async function listNotifications(req: Request, res: Response) {
  const [targets, workspace] = await Promise.all([
    prisma.notificationTarget.findMany({
      where: { workspaceId: req.workspaceId, membershipId: null },
      orderBy: { createdAt: "asc" },
    }),
    prisma.workspace.findUniqueOrThrow({ where: { id: req.workspaceId }, select: { notifyAutoPauseAfter: true } }),
  ]);
  const states = await deliveryStates(targets.map((target) => target.id));
  // mailConfigured lets the dashboard explain why email targets cannot be added.
  res.json({
    targets: targets.map((target) =>
      publicTarget(target, states.last(target.id), states.pending(target.id), states.held(target.id)),
    ),
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
  // Reviews held for a digest are not deliveries yet; the digest is.
  const where = { targetId: target.id, status: { not: "held" as const } };
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
    ...deliveryData(input.delivery, null),
  };

  if (input.kind === "email") {
    if (!mailer.configured()) {
      throw new HttpError(400, "Email notifications need mail to be configured (SMTP_URL)");
    }
    await assertMembers(workspaceId, input.recipientIds);
    const target = await prisma.$transaction(async (tx) => {
      await assertRepositories(tx, workspaceId, input.repositoryIds);
      return tx.notificationTarget.create({ data: { ...base, recipientIds: input.recipientIds } });
    });
    res.status(201).json({ target: publicTarget(target) });
    return;
  }

  await assertSafeTargetUrl(input.url);
  const secret = input.kind === "webhook" ? newWebhookSecret() : undefined;
  const target = await prisma.$transaction(async (tx) => {
    await assertRepositories(tx, workspaceId, input.repositoryIds);
    return tx.notificationTarget.create({
      data: { ...base, encryptedUrl: encrypt(input.url), encryptedSecret: secret ? encrypt(secret) : null },
    });
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
  // Queued deliveries read the URL when they are sent, so they go to the new one.
  if (input.url !== undefined) {
    if (target.kind === "email") {
      throw new HttpError(400, "Validation failed", { url: ["Email targets have no URL"] });
    }
    await assertSafeTargetUrl(input.url);
  }
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
  const { delivery, url, ...fields } = input;
  // A new URL is a new endpoint, so the old one's failures no longer count
  // towards the auto-pause limit. A target paused for them stays off with its
  // reason until an admin switches it on, which is the deliberate step.
  const data = {
    ...fields,
    ...(url !== undefined ? { encryptedUrl: encrypt(url), consecutiveFailures: 0 } : {}),
    ...(delivery ? deliveryData(delivery, target) : {}),
    ...(input.active !== undefined ? { consecutiveFailures: 0 } : {}),
    ...(clearReason ? { pausedReason: null } : {}),
  };
  const updated = await prisma.$transaction(async (tx) => {
    if (input.repositoryIds) await assertRepositories(tx, target.workspaceId, input.repositoryIds);
    const row = await tx.notificationTarget.update({ where: { id: target.id }, data });
    // Paused means its queued deliveries are dropped, not held for a resume.
    if (input.active === false) await dropPendingDeliveries(tx, target.id);
    return row;
  });
  const states = await deliveryStates([updated.id]);
  res.json({
    target: publicTarget(updated, states.last(updated.id), states.pending(updated.id), states.held(updated.id)),
  });
}

// A new signing secret, in this response only, as on create. The one it
// replaces keeps signing deliveries (alongside the new one) for
// SECRET_GRACE_MS, so the receiver can be switched over without dropping any;
// a second rotation within that window forgets the oldest of the three.
export async function rotateNotificationSecret(req: Request, res: Response) {
  const target = await loadTarget(req);
  if (target.kind !== "webhook") {
    throw new HttpError(400, "Only webhook targets have a signing secret");
  }
  const secret = newWebhookSecret();
  // Only if the secret is still the one read above: two rotations at once
  // would otherwise both keep it as the previous one, and the first caller
  // would be shown a secret that is no longer stored anywhere.
  const { count } = await prisma.notificationTarget.updateMany({
    where: { id: target.id, encryptedSecret: target.encryptedSecret },
    data: {
      encryptedSecret: encrypt(secret),
      encryptedPreviousSecret: target.encryptedSecret,
      previousSecretExpiresAt: target.encryptedSecret ? new Date(Date.now() + SECRET_GRACE_MS) : null,
    },
  });
  if (count === 0) {
    throw new HttpError(409, "The secret was rotated by someone else at the same time; reload and try again");
  }
  const updated = await prisma.notificationTarget.findUniqueOrThrow({ where: { id: target.id } });
  const states = await deliveryStates([updated.id]);
  res.json({
    target: publicTarget(updated, states.last(updated.id), states.pending(updated.id), states.held(updated.id)),
    secret,
  });
}

// Sends a sample; a delivery that fails is reported as the result, not an error.
export async function testNotification(req: Request, res: Response) {
  const target = await loadTarget(req);
  res.json({ result: await testTarget(target) });
}

export async function deleteNotification(req: Request, res: Response) {
  const { id } = notificationParamsSchema.parse(req.params);
  const { count } = await prisma.notificationTarget.deleteMany({
    where: { id, workspaceId: req.workspaceId, membershipId: null },
  });
  if (count === 0) {
    throw new HttpError(404, "Notification target not found");
  }
  res.status(204).end();
}

// The forge hosts this workspace reviews on, and whether the member has
// linked a sign-in identity on each: only changes opened from a linked
// account can be matched to them.
// The target is passed when the caller has just written it, to save reading
// the membership again.
async function personalState(userId: string, workspaceId: string, saved?: NotificationTarget) {
  const [target, connections, identities] = await Promise.all([
    saved ??
      prisma.membership
        .findUniqueOrThrow({
          where: { userId_workspaceId: { userId, workspaceId } },
          select: { personalNotifications: true },
        })
        .then((membership) => membership.personalNotifications),
    prisma.forgeConnection.findMany({
      where: { workspaceId },
      distinct: ["provider", "host"],
      select: { provider: true, host: true },
      orderBy: [{ provider: "asc" }, { host: "asc" }],
    }),
    prisma.userIdentity.findMany({ where: { userId }, select: { provider: true, host: true } }),
  ]);
  const forges = connections.map(({ provider, host }) => ({
    provider,
    host,
    linked: identities.some((identity) => identity.provider === provider && identity.host === host),
  }));
  return publicPersonal(target, forges, mailer.configured());
}

// Any member, for themselves: the personal target is created on first save.
export async function getPersonalNotifications(req: Request, res: Response) {
  res.json(await personalState(req.userId!, req.workspaceId!));
}

// Switching it back on clears an auto-pause: the member has seen the reason
// and chose to carry on, as an admin switching a workspace target does. Other
// saves (events, or keeping it off) leave the reason showing.
export async function updatePersonalNotifications(req: Request, res: Response) {
  const { enabled, events } = personalNotificationSchema.parse(req.body);
  const userId = req.userId!;
  const workspaceId = req.workspaceId!;
  if (enabled && !mailer.configured()) {
    throw new HttpError(400, "Email notifications need mail to be configured (SMTP_URL)");
  }
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true, personalNotifications: { select: { active: true } } },
  });
  const resuming = enabled && !membership.personalNotifications?.active;
  const state = { events, active: enabled, ...(resuming ? { consecutiveFailures: 0, pausedReason: null } : {}) };
  const saved = await prisma.$transaction(async (tx) => {
    const target = await tx.notificationTarget.upsert({
      where: { membershipId: membership.id },
      create: {
        ...state,
        workspaceId,
        membershipId: membership.id,
        kind: "email",
        name: PERSONAL_TARGET_NAME,
        recipientIds: [userId],
      },
      update: state,
    });
    if (!enabled) await dropPendingDeliveries(tx, target.id);
    return target;
  });
  res.json(await personalState(userId, workspaceId, saved));
}
