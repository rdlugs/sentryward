import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.ts";
import { hashPassword, verifyPassword } from "../lib/password.ts";
import { AUTH_COOKIE, authCookieOptions, signToken } from "../lib/jwt.ts";
import { HttpError } from "../lib/httpError.ts";
import { env } from "../config/env.ts";
import type { Invite, Prisma } from "../generated/prisma/client.ts";
import { assertInviteEmail, consumeInvite, findValidInvite, joinWorkspace } from "../services/invites.ts";
import { completePasswordReset, findValidReset, requestPasswordReset } from "../services/passwordResets.ts";
import { emailTaken, isUniqueViolation } from "../services/users.ts";
import { mailer } from "../lib/mailer.ts";
import { createPersonalWorkspace, workspacesFor } from "../services/workspaces.ts";
import {
  inviteTokenParamsSchema,
  loginSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  registerSchema,
  resetTokenParamsSchema,
} from "../schemas/auth.schema.ts";

export const publicUser = {
  id: true,
  name: true,
  email: true,
  role: true,
  avatarUpdatedAt: true,
  createdAt: true,
} as const;

// Signs with the user's current session version, so the cookie survives until
// the next password change or reset.
export function setAuthCookie(res: Response, user: { id: string; sessionVersion: number }) {
  res.cookie(AUTH_COOKIE, signToken(user.id, user.sessionVersion), authCookieOptions);
}

// Applies REGISTRATION_MODE to everyone but the first account, and returns the
// invite to spend once the user exists. A token is checked whenever one is
// given: in open mode a team invite still brings the new user into its workspace.
async function admitRegistration(
  tx: Prisma.TransactionClient,
  email: string,
  inviteToken?: string,
): Promise<Invite | null> {
  const invite = inviteToken ? await findValidInvite(inviteToken, tx) : null;
  if (inviteToken && !invite) {
    throw new HttpError(400, "This invite is invalid or has expired");
  }
  if (invite) assertInviteEmail(invite, email);
  if (env.REGISTRATION_MODE === "closed") {
    throw new HttpError(403, "Registration is closed on this Sentryward instance");
  }
  if (env.REGISTRATION_MODE === "invite" && !invite) {
    throw new HttpError(403, "An invite is required to register on this Sentryward instance");
  }
  if (env.REGISTRATION_MODE === "invite" && invite?.workspaceId) {
    // Team roles do not authorize new accounts. Check the original creator's
    // current instance role so demotion or deletion removes that authority.
    const inviter = invite.invitedById
      ? await tx.user.findUnique({ where: { id: invite.invitedById }, select: { role: true } })
      : null;
    if (inviter?.role !== "admin") {
      throw new HttpError(403, "This team invite cannot create an account. Ask an instance admin for an invite.");
    }
  }
  return invite;
}

// Everything the client needs about who is signed in and where they can work.
async function session(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: publicUser });
  if (!user) {
    throw new HttpError(401, "Not authenticated");
  }
  return { user, workspaces: await workspacesFor(userId) };
}

export async function register(req: Request, res: Response) {
  const { name, email, password, inviteToken } = registerSchema.parse(req.body);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw emailTaken();
  }

  const passwordHash = await hashPassword(password);
  // The first account on an empty install bootstraps it as admin. Two people
  // registering at that same instant would both become admin, which is harmless.
  // The invite is spent in the same transaction, so only if the user is created.
  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const firstUser = (await tx.user.count()) === 0;
      const invite = firstUser ? null : await admitRegistration(tx, email, inviteToken);
      const created = await tx.user.create({
        data: { name, email, passwordHash, role: firstUser ? "admin" : "member" },
        select: { ...publicUser, sessionVersion: true },
      });
      await createPersonalWorkspace(tx, created);
      if (invite?.workspaceId) {
        await joinWorkspace(tx, invite, created.id);
      } else if (invite) {
        await consumeInvite(tx, invite);
      }
      return created;
    });
  } catch (error) {
    // Another registration claimed the email between the check and the create.
    if (isUniqueViolation(error)) {
      throw emailTaken();
    }
    throw error;
  }

  setAuthCookie(res, user);
  res.status(201).json(await session(user.id));
}

// A real argon2id hash that no password matches. Login verifies against it when
// the email has no account, so an unknown email costs the same argon2 work as a
// wrong password instead of returning early (see #208).
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$Ot0BouBhK863gjT/0MWGBQ$4Sqk/V1EioOT6m4QJPZcmhc6ofe2A1Q0lHIzHUJ+/SA";

export async function login(req: Request, res: Response) {
  const { email, password } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email } });
  // Always run argon2, even for an unknown email: skipping it here is a timing
  // oracle for which addresses have accounts.
  const passwordOk = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, password);
  if (!user || !passwordOk) {
    throw new HttpError(401, "Invalid email or password");
  }

  setAuthCookie(res, user);
  res.json(await session(user.id));
}

export function clearAuthCookie(res: Response) {
  const { maxAge: _maxAge, ...clearOptions } = authCookieOptions;
  res.clearCookie(AUTH_COOKIE, clearOptions);
}

export function logout(_req: Request, res: Response) {
  clearAuthCookie(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response) {
  res.json(await session(req.userId!));
}

// Lets the register page say up front whether it can be used, and the forgot
// password page whether a reset can be emailed or needs an admin.
export async function registration(_req: Request, res: Response) {
  const firstUser = (await prisma.user.count()) === 0;
  res.json({ mode: env.REGISTRATION_MODE, firstUser, mailConfigured: mailer.configured() });
}

// Always the same answer, so the endpoint cannot be used to find out which
// emails have accounts. Not awaited: the lookup and any database writes would
// otherwise make known addresses answer measurably slower.
export async function postPasswordResetRequest(req: Request, res: Response) {
  const { email } = passwordResetRequestSchema.parse(req.body);
  void requestPasswordReset(email);
  res.status(202).json({});
}

// Lets the reset page show an expired link up front instead of after the form.
export async function showPasswordReset(req: Request, res: Response) {
  const { token } = resetTokenParamsSchema.parse(req.params);
  const reset = await findValidReset(token);
  if (!reset) {
    throw new HttpError(404, "This reset link is invalid or has expired");
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: reset.userId }, select: { email: true } });
  res.json({ email: user.email });
}

// Signs the user in with a cookie on the new session version; every other
// session, including one this browser may already hold, has ended.
export async function postPasswordReset(req: Request, res: Response) {
  const { token } = resetTokenParamsSchema.parse(req.params);
  const { password } = passwordResetSchema.parse(req.body);
  const user = await completePasswordReset(token, password);
  setAuthCookie(res, user);
  res.json(await session(user.id));
}

export async function showInvite(req: Request, res: Response) {
  const { token } = inviteTokenParamsSchema.parse(req.params);
  const valid = await findValidInvite(token);
  if (!valid) {
    throw new HttpError(404, "This invite is invalid or has expired");
  }
  const invite = await prisma.invite.findUniqueOrThrow({
    where: { id: valid.id },
    select: {
      email: true,
      role: true,
      expiresAt: true,
      invitedBy: { select: { name: true } },
      workspace: { select: { name: true } },
    },
  });
  res.json({ invite });
}

// A signed-in user joining a workspace from an invite link.
export async function acceptInvite(req: Request, res: Response) {
  const { token } = inviteTokenParamsSchema.parse(req.params);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true } });
  if (!user) {
    throw new HttpError(401, "Not authenticated");
  }
  const workspaceId = await prisma.$transaction(async (tx) => {
    const invite = await findValidInvite(token, tx);
    if (!invite) {
      throw new HttpError(404, "This invite is invalid or has expired");
    }
    assertInviteEmail(invite, user.email);
    await joinWorkspace(tx, invite, req.userId!);
    return invite.workspaceId!;
  });
  const workspace = (await workspacesFor(req.userId!)).find((w) => w.id === workspaceId);
  res.status(201).json({ workspace });
}
