import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.ts";
import { Prisma } from "../generated/prisma/client.ts";
import { encrypt } from "../lib/crypto.ts";
import { assertSafeForgeHost } from "../lib/hostSafety.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { ForgeError } from "../review/forge/http.ts";
import { FORGE_PROVIDERS, forgeName } from "../review/forge/providers.ts";
import { hostOrigin } from "../review/forge/types.ts";
import { loadWorkspaceConnection } from "../services/forge.ts";
import { getGitHubApp, githubInstallUrl } from "../services/githubApp.ts";
import {
  exchangeCode,
  gitlabAuthorizeUrl,
  gitlabOAuthConfigured,
  pkcePair,
  storedTokens,
} from "../services/gitlabOAuth.ts";
import { isCredentialRejection, recordCredentials } from "../services/providers/credentials.ts";
import { reconcileRepoAccess } from "../services/providers/github.ts";
import { isForgeProvider, PROVIDERS, providerFor } from "../services/providers/index.ts";
import { isUniqueViolation } from "../services/users.ts";
import { removeWebhook } from "../services/webhooks.ts";
import { loadMembership, requireRole } from "../services/workspaces.ts";
import { GitLabAdapter } from "../review/forge/gitlab.ts";
import {
  githubCallbackSchema,
  githubInstallSchema,
  gitlabOAuthCallbackSchema,
  gitlabOAuthStartSchema,
  reorderConnectionsSchema,
} from "../schemas/connections.schema.ts";

const publicConnection = {
  id: true,
  provider: true,
  host: true,
  kind: true,
  accountLogin: true,
  credentialsRejectedAt: true,
  createdAt: true,
  createdBy: { select: { name: true, email: true } },
} as const;

const INSTALL_STATE_PURPOSE = "github-install";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export async function listConnections(req: Request, res: Response) {
  const rows = await prisma.forgeConnection.findMany({
    where: { workspaceId: req.workspaceId },
    // Only enabled repositories count as added, matching the details sheet.
    select: { ...publicConnection, _count: { select: { repositories: { where: { enabled: true } } } } },
    orderBy: [{ position: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  const connections = rows.map(({ _count, ...connection }) => ({
    ...connection,
    repositoryCount: _count.repositories,
  }));
  const availableApps = FORGE_PROVIDERS.filter((provider) => PROVIDERS[provider].appAvailable?.());
  // Which host the OAuth app belongs to, so the client offers it on the matching
  // (cloud or self-hosted) option.
  const oauthHosts = gitlabOAuthConfigured() ? { gitlab: env.GITLAB_OAUTH_HOST } : {};
  res.json({ connections, availableApps, oauthHosts });
}

export async function reorderConnections(req: Request, res: Response) {
  const { ids } = reorderConnectionsSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    // Locking every row up front, always by id, makes overlapping reorders
    // wait for each other instead of deadlocking on rows taken in request
    // order, and keeps the check below true until the writes commit.
    const current = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM forge_connections
      WHERE workspace_id = ${req.workspaceId!}::uuid
      ORDER BY id
      FOR UPDATE`);
    // The full set, not a subset: a connection added or removed since the page
    // loaded would otherwise land somewhere nobody chose.
    const known = new Set(current.map((connection) => connection.id));
    if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
      throw new HttpError(409, "Connections changed since the page loaded; reload and try again");
    }
    for (const [position, id] of ids.entries()) {
      await tx.forgeConnection.update({ where: { id }, data: { position } });
    }
  });
  res.status(204).end();
}

const RECENT_REVIEWS = 5;

// Everything the details sheet shows, from the database only; credential
// health is the separate (slower) status check.
export async function getConnection(req: Request, res: Response) {
  const connection = await loadWorkspaceConnection(req.workspaceId!, String(req.params.id));
  const provider = providerFor(connection.provider);
  const reviewScope = { repository: { connectionId: connection.id } };

  const [repositories, total, recent] = await Promise.all([
    prisma.repository.findMany({
      where: { connectionId: connection.id, enabled: true },
      orderBy: { fullPath: "asc" },
    }),
    prisma.reviewJob.count({ where: reviewScope }),
    prisma.reviewJob.findMany({
      where: reviewScope,
      orderBy: { createdAt: "desc" },
      take: RECENT_REVIEWS,
      select: {
        id: true,
        number: true,
        status: true,
        verdict: true,
        createdAt: true,
        repository: { select: { fullPath: true, provider: true } },
      },
    }),
  ]);

  // Same rule as ensureWebhook: an app delivers events for every repository,
  // otherwise a repository needs its own hook. Hook ids and secrets stay here.
  const appWebhook = provider.appWebhook?.(connection) ?? null;
  res.json({
    connection: {
      id: connection.id,
      provider: connection.provider,
      host: connection.host,
      kind: connection.kind,
      accountLogin: connection.accountLogin,
      installationId: connection.installationId,
      credentialsRejectedAt: connection.credentialsRejectedAt,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    },
    repositories: repositories.map((repo) => ({
      id: repo.id,
      fullPath: repo.fullPath,
      defaultBranch: repo.defaultBranch,
      webUrl: `${hostOrigin(connection.host)}/${repo.fullPath}`,
      webhook: appWebhook ?? { active: Boolean(repo.webhookId) },
    })),
    reviews: { total, recent },
  });
}

// Asks the forge whether the stored credentials still work. Always 200: a
// refused or unreachable forge is the answer, not a failure of this request.
// The answer is stored, so a revoked token pauses automatic reviews and a
// working one resumes them; an unreachable forge proves neither.
export async function connectionStatus(req: Request, res: Response) {
  const connection = await loadWorkspaceConnection(req.workspaceId!, String(req.params.id));
  let status: "active" | "revoked" | "unreachable";
  try {
    await providerFor(connection.provider).checkCredentials(connection);
    status = "active";
  } catch (err) {
    status = isCredentialRejection(err) ? "revoked" : "unreachable";
  }
  if (status !== "unreachable") await recordCredentials(connection, status === "active");
  res.json({ status });
}

// Any forge whose provider definition accepts a pasted host and token.
export async function connectWithToken(req: Request, res: Response) {
  const provider = String(req.params.provider);
  if (!isForgeProvider(provider)) {
    throw new HttpError(404, "Unknown provider");
  }
  const tokenConnect = PROVIDERS[provider].tokenConnect;
  if (!tokenConnect) {
    throw new HttpError(404, `${forgeName(provider)} does not connect with a token`);
  }
  const { host, token } = tokenConnect.schema.parse(req.body);
  await assertSafeForgeHost(host);

  const name = forgeName(provider);
  let login: string;
  try {
    ({ login } = await tokenConnect.account(host, token));
  } catch (err) {
    if (err instanceof ForgeError && (err.status === 401 || err.status === 403)) {
      throw new HttpError(400, `${name} rejected this token`);
    }
    throw new HttpError(502, `Could not reach ${name} at ${host}`);
  }

  const workspaceId = req.workspaceId!;
  const existing = await prisma.forgeConnection.findFirst({
    where: { workspaceId, provider, kind: "token", host, accountLogin: login },
  });
  // A new token for an account already connected replaces the old one on the
  // same row, so its repositories and review history carry on.
  const data = { encryptedToken: encrypt(token), credentialsRejectedAt: null };
  const connection = existing
    ? await prisma.forgeConnection.update({ where: { id: existing.id }, data, select: publicConnection })
    : await prisma.forgeConnection.create({
        data: { ...data, workspaceId, createdById: req.userId, provider, host, kind: "token", accountLogin: login },
        select: publicConnection,
      });

  res.status(existing ? 200 : 201).json({ connection });
}

// A browser navigation, so the workspace comes as ?workspace= rather than the
// header. It travels to the callback inside the signed state.
export async function githubInstall(req: Request, res: Response) {
  const { workspace } = githubInstallSchema.parse(req.query);
  const access = await loadMembership(req.userId!, workspace);
  requireRole(access.role, "admin");
  const state = jwt.sign(
    { sub: req.userId, workspaceId: access.workspaceId, purpose: INSTALL_STATE_PURPOSE },
    env.JWT_SECRET,
    { expiresIn: "10m" },
  );
  const url = githubInstallUrl(state);
  if (!url) {
    throw new HttpError(503, "GitHub is not configured on this server");
  }
  res.redirect(url);
}

function backToClient(res: Response, params: Record<string, string>) {
  res.redirect(`${env.CLIENT_ORIGIN}/repositories?${new URLSearchParams({ tab: "installation", ...params })}`);
}

// The browser lands here from GitHub, so every outcome is a redirect back to
// the client rather than a JSON error.
export async function githubCallback(req: Request, res: Response) {
  const parsed = githubCallbackSchema.safeParse(req.query);
  const app = getGitHubApp();
  if (!parsed.success || !app) {
    return backToClient(res, { error: "github_install_failed" });
  }
  const { installation_id: installationId, setup_action: setupAction, state, code } = parsed.data;

  // The state ties the round trip to the logged-in user who started it, and
  // the workspace they started it for.
  let stateUser: unknown;
  let stateWorkspace: unknown;
  try {
    const payload = jwt.verify(state, env.JWT_SECRET);
    if (typeof payload === "object" && payload.purpose === INSTALL_STATE_PURPOSE) {
      ({ sub: stateUser, workspaceId: stateWorkspace } = payload);
    }
  } catch {
    stateUser = null;
  }
  if (!stateUser || stateUser !== req.userId || typeof stateWorkspace !== "string") {
    return backToClient(res, { error: "github_install_failed" });
  }
  // Rights may have changed during the round trip to GitHub.
  const access = await loadMembership(req.userId, stateWorkspace).catch(() => null);
  if (!access || access.role === "member") {
    return backToClient(res, { error: "github_install_failed" });
  }
  if (setupAction === "request" || !installationId) {
    // An org owner has to approve the installation first.
    return backToClient(res, { error: "github_pending_approval" });
  }
  if (!code) {
    return backToClient(res, { error: "github_install_failed" });
  }

  try {
    if (!(await app.userHasInstallation(code, installationId))) {
      return backToClient(res, { error: "github_install_forbidden" });
    }
    const installation = await app.installation(installationId);
    const workspaceId = access.workspaceId;
    const accountId = String(installation.account.id);
    const accountLogin = installation.account.login;
    // GitHub allows one installation of an app per account, so a new one for
    // an account this workspace already has replaces it, whether or not the
    // uninstall webhook arrived. Reusing that row brings its repositories and
    // review history back. Rows from before accountId was stored match by login.
    const candidates = await prisma.forgeConnection.findMany({
      where: {
        workspaceId,
        provider: "github",
        kind: "github_app",
        OR: [{ installationId }, { accountId }, { accountId: null, accountLogin }],
      },
      orderBy: { createdAt: "asc" },
    });
    const existing = candidates.find((row) => row.installationId === installationId) ?? candidates[0];
    const data = { accountLogin, accountId, host: env.GITHUB_HOST, installationId };
    let connection;
    if (existing) {
      connection = await prisma.forgeConnection.update({ where: { id: existing.id }, data });
    } else {
      try {
        connection = await prisma.forgeConnection.create({
          data: { ...data, workspaceId, createdById: req.userId, provider: "github", kind: "github_app" },
        });
      } catch (err) {
        // A concurrent callback for the same installation saved it first.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    // The connection is saved either way; repository access catches up on the
    // next installation_repositories event if this fails.
    if (connection) {
      await reconcileRepoAccess(connection).catch((err: unknown) => {
        console.error("GitHub repository access reconcile failed", err);
      });
    }
  } catch (err) {
    console.error("GitHub installation callback failed", err);
    return backToClient(res, { error: "github_install_failed" });
  }
  backToClient(res, { connected: "github" });
}

// Like githubInstall, a browser navigation that takes the workspace as a query
// parameter. The state is a single-use row rather than a signed token, so a
// callback URL cannot be replayed.
export async function gitlabOAuthStart(req: Request, res: Response) {
  const { workspace } = gitlabOAuthStartSchema.parse(req.query);
  const access = await loadMembership(req.userId!, workspace);
  requireRole(access.role, "admin");
  if (!gitlabOAuthConfigured()) {
    throw new HttpError(503, "GitLab OAuth is not configured on this server");
  }
  const host = env.GITLAB_OAUTH_HOST;
  await assertSafeForgeHost(host);

  await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const { verifier, challenge } = pkcePair();
  const state = await prisma.oAuthState.create({
    data: {
      id: randomBytes(32).toString("base64url"),
      userId: req.userId!,
      workspaceId: access.workspaceId,
      host,
      codeVerifier: verifier,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    },
  });
  res.redirect(gitlabAuthorizeUrl(host, state.id, challenge));
}

// GitLab sends the browser back here, so like githubCallback every outcome is
// a redirect to the client.
export async function gitlabOAuthCallback(req: Request, res: Response) {
  const parsed = gitlabOAuthCallbackSchema.safeParse(req.query);
  if (!parsed.success || !gitlabOAuthConfigured()) {
    return backToClient(res, { error: "gitlab_oauth_failed" });
  }
  const { state: stateId, code, error } = parsed.data;

  // Only the user who started the flow can use it, once: of two requests with
  // the same state, only the one whose delete removed the row goes on.
  const state = await prisma.oAuthState.findFirst({
    where: { id: stateId, userId: req.userId, expiresAt: { gt: new Date() } },
  });
  const consumed = state ? await prisma.oAuthState.deleteMany({ where: { id: state.id } }) : null;
  if (!state || consumed?.count !== 1) {
    return backToClient(res, { error: "gitlab_oauth_failed" });
  }
  if (error || !code) {
    return backToClient(res, { error: error === "access_denied" ? "gitlab_oauth_denied" : "gitlab_oauth_failed" });
  }
  // Rights may have changed during the round trip to GitLab.
  const access = await loadMembership(req.userId!, state.workspaceId).catch(() => null);
  if (!access || access.role === "member") {
    return backToClient(res, { error: "gitlab_oauth_failed" });
  }

  try {
    const tokens = await exchangeCode(state.host, code, state.codeVerifier);
    const { login } = await new GitLabAdapter({
      host: state.host,
      token: async () => tokens.accessToken,
      oauth: true,
    }).currentAccount();
    const workspaceId = access.workspaceId;
    const existing = await prisma.forgeConnection.findFirst({
      where: { workspaceId, provider: "gitlab", kind: "oauth", host: state.host, accountLogin: login },
    });
    const data = { ...storedTokens(tokens), credentialsRejectedAt: null };
    if (existing) {
      await prisma.forgeConnection.update({ where: { id: existing.id }, data });
    } else {
      await prisma.forgeConnection.create({
        data: {
          ...data,
          workspaceId,
          createdById: req.userId,
          provider: "gitlab",
          host: state.host,
          kind: "oauth",
          accountLogin: login,
        },
      });
    }
  } catch (err) {
    console.error("GitLab OAuth callback failed", err);
    return backToClient(res, { error: "gitlab_oauth_failed" });
  }
  backToClient(res, { connected: "gitlab" });
}

export async function deleteConnection(req: Request, res: Response) {
  const connection = await prisma.forgeConnection.findFirst({
    where: { id: String(req.params.id), workspaceId: req.workspaceId },
    include: { repositories: true },
  });
  if (!connection) {
    throw new HttpError(404, "Connection not found");
  }
  // Take Sentryward's hooks off the forge while the token still works.
  for (const repo of connection.repositories) {
    await removeWebhook(repo, connection).catch(() => undefined);
  }
  await prisma.forgeConnection.delete({ where: { id: connection.id } });
  res.status(204).end();
}
