import { createHmac } from "node:crypto";
import { env } from "../../config/env.ts";
import { HttpError } from "../../lib/httpError.ts";
import { prisma } from "../../lib/prisma.ts";
import { parseJson, REVIEW_COMMAND, safeEqual } from "../../lib/webhook.ts";
import type { ForgeConnection } from "../../generated/prisma/client.ts";
import { GitHubAdapter } from "../../review/forge/github.ts";
import type { GitHubApp } from "../../review/forge/githubApp.ts";
import { ForgeError } from "../../review/forge/http.ts";
import { githubConnectSchema } from "../../schemas/connections.schema.ts";
import {
  ACCESS_LOST_REASON,
  cancelForDisabledRepositories,
  cancelQueuedForClosedChange,
  enqueue,
  enqueueFromWebhook,
} from "../../worker/queue.ts";
import { getGitHubApp, githubConfigured } from "../githubApp.ts";
import { recordThreadReply } from "../threadReplies.ts";
import type { HeaderReader, ProviderDefinition, RepoWithConnection, WebhookOutcome } from "./types.ts";
import { decryptToken } from "./token.ts";

// "synchronize" brings new commits; the rest make a change reviewable.
const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
// Who may ask for a review in a comment, or act on a finding by replying to
// it: people who can already push.
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// The uninstall webhook cleared the installation id; the connection is kept
// for its history until a reinstall reattaches it. An HttpError, so it reaches
// the client as is whether thrown before or inside a forge call.
export class AppUninstalledError extends HttpError {
  constructor() {
    super(409, "The GitHub App is no longer installed for this account; install it again to reattach it");
  }
}

export interface GitHubPayload {
  action?: string;
  installation?: { id: number };
  repository?: { id: number };
  // installation_repositories events only.
  repositories_added?: { id: number }[];
  repositories_removed?: { id: number }[];
  pull_request?: { number: number; head: { sha: string }; user?: { id: number } };
  issue?: { number: number; pull_request?: unknown };
  comment?: {
    id?: number;
    body: string;
    author_association: string;
    user?: { login: string };
    // Review comments only: the thread's root comment, set on every reply.
    in_reply_to_id?: number;
  };
  sender?: { login: string };
}

function requireInstallation(connection: ForgeConnection): { app: GitHubApp; installationId: string } {
  const app = getGitHubApp();
  if (!app) {
    throw new HttpError(503, "GitHub is not configured on this server");
  }
  if (!connection.installationId) {
    throw new AppUninstalledError();
  }
  return { app, installationId: connection.installationId };
}

function adapterFor(connection: ForgeConnection): GitHubAdapter {
  if (connection.kind === "token") {
    const encryptedToken = connection.encryptedToken;
    if (!encryptedToken) {
      throw new HttpError(500, "GitHub connection has no token");
    }
    return new GitHubAdapter({
      host: connection.host,
      token: async () => decryptToken(encryptedToken, "GitHub"),
      selfLogin: connection.accountLogin,
      repoSource: "user",
    });
  }

  const { app, installationId } = requireInstallation(connection);
  return new GitHubAdapter({
    host: connection.host,
    token: () => app.installationToken(installationId),
    account: async () => ({ login: connection.accountLogin }),
    // An app posts as "<slug>[bot]", not as the account it is installed on.
    selfLogin: env.GITHUB_APP_SLUG ? `${env.GITHUB_APP_SLUG}[bot]` : undefined,
  });
}

export function verifyGithubSignature(header: HeaderReader, raw: Buffer, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return safeEqual(header("x-hub-signature-256") ?? "", expected);
}

function isPullRequestPush(event: string | undefined, payload: GitHubPayload): boolean {
  return event === "pull_request" && PR_ACTIONS.has(payload.action ?? "");
}

function isReviewCommand(event: string | undefined, payload: GitHubPayload): boolean {
  return (
    event === "issue_comment" &&
    payload.action === "created" &&
    Boolean(payload.issue?.pull_request) &&
    REVIEW_COMMAND.test(payload.comment?.body ?? "")
  );
}

// A reply in an inline thread. Whether the thread is Sentryward's is only known
// once its root comment is read.
function isThreadReply(event: string | undefined, payload: GitHubPayload): boolean {
  return (
    event === "pull_request_review_comment" &&
    payload.action === "created" &&
    Boolean(payload.pull_request) &&
    Boolean(payload.comment?.id && payload.comment.in_reply_to_id)
  );
}

// Closed covers merged: GitHub sends "closed" with merged set for both.
function isPullRequestClose(event: string | undefined, payload: GitHubPayload): boolean {
  return event === "pull_request" && payload.action === "closed";
}

export function isGithubReviewEvent(event: string | undefined, payload: GitHubPayload): boolean {
  return (
    isPullRequestPush(event, payload) ||
    isPullRequestClose(event, payload) ||
    isReviewCommand(event, payload) ||
    isThreadReply(event, payload)
  );
}

// Shared by the app's webhook and per-repository hooks once the repository is
// known and the event is one isGithubReviewEvent accepts.
export async function handleGithubEvent(
  repo: RepoWithConnection,
  event: string | undefined,
  payload: GitHubPayload,
): Promise<WebhookOutcome> {
  if (isPullRequestClose(event, payload)) {
    const cancelled = await cancelQueuedForClosedChange(repo, payload.pull_request!.number);
    return { body: { outcome: "closed", cancelled } };
  }

  if (isPullRequestPush(event, payload)) {
    const pull = payload.pull_request!;
    const result = await enqueueFromWebhook({
      repositoryId: repo.id,
      number: pull.number,
      headSha: pull.head.sha,
      trigger: "webhook",
      event: payload.action === "synchronize" ? "push" : "open",
      actor: payload.sender?.login,
      authorId: pull.user?.id === undefined ? undefined : String(pull.user.id),
    });
    return { body: result.queued ? { outcome: "queued", reviewId: result.job.id } : { outcome: result.reason } };
  }

  if (isThreadReply(event, payload)) {
    const comment = payload.comment!;
    return recordThreadReply({
      repo,
      forge: adapterFor(repo.connection),
      number: payload.pull_request!.number,
      threadId: String(comment.in_reply_to_id),
      commentId: String(comment.id),
      actor: comment.user?.login,
      body: comment.body,
      botLogin: repo.connection.kind !== "token",
      allowed: async () => TRUSTED.has(comment.author_association),
    });
  }

  if (!TRUSTED.has(payload.comment!.author_association)) {
    return { body: { outcome: "not_allowed" } };
  }
  const number = payload.issue!.number;
  const head = await adapterFor(repo.connection).getChangeHead(repo.fullPath, number);
  const job = await enqueue({
    repositoryId: repo.id,
    number,
    headSha: head.headSha,
    trigger: "comment",
    actor: payload.comment!.user?.login ?? payload.sender?.login,
  });
  return { body: { outcome: "queued", reviewId: job.id } };
}

// Brings the stored repositories in line with what a (re)attached installation
// can reach. Only repositories the app lost access to come back; one a user
// disabled stays disabled. Lost ones have their in-flight reviews cancelled.
export async function reconcileRepoAccess(connection: ForgeConnection): Promise<void> {
  const visible = (await adapterFor(connection).listRepos()).map((repo) => repo.externalId);
  await prisma.$transaction(async (tx) => {
    const lost = await tx.repository.findMany({
      where: { connectionId: connection.id, enabled: true, externalId: { notIn: visible } },
      select: { id: true },
    });
    const ids = lost.map((repo) => repo.id);
    await tx.repository.updateMany({
      where: { id: { in: ids } },
      data: { enabled: false, accessLostAt: new Date() },
    });
    await cancelForDisabledRepositories(ids, ACCESS_LOST_REASON, tx);
    await tx.repository.updateMany({
      where: { connectionId: connection.id, accessLostAt: { not: null }, externalId: { in: visible } },
      data: { enabled: true, accessLostAt: null },
    });
  });
}

export const githubProvider: ProviderDefinition = {
  adapterFor,

  async checkCredentials(connection) {
    if (connection.kind === "token") {
      await adapterFor(connection).currentAccount();
      return;
    }
    // Not installationToken(): it caches tokens for up to an hour, so it would
    // miss an uninstall. The installation lookup 404s as soon as it is gone.
    const { app, installationId } = requireInstallation(connection);
    const installation = await app.installation(installationId);
    if (installation.suspended_at) {
      throw new ForgeError(403, "GitHub App installation is suspended");
    }
  },

  // GitHub.com connects through the app; a token is for Enterprise Server.
  tokenConnect: {
    schema: githubConnectSchema,
    account: (host, token) => new GitHubAdapter({ host, token: async () => token }).currentAccount(),
  },

  appAvailable: githubConfigured,

  // The app delivers every installation's events to its single webhook.
  appWebhook(connection) {
    if (connection.kind !== "github_app") return null;
    return env.GITHUB_WEBHOOK_SECRET
      ? { active: true }
      : { active: false, error: "GITHUB_WEBHOOK_SECRET is not set on this server" };
  },

  repoWebhook: {
    verify: verifyGithubSignature,
    async handle(repo, header, raw) {
      const event = header("x-github-event");
      const payload = parseJson<GitHubPayload>(raw);
      if (event === "ping") return { status: 200, body: { outcome: "pong" } };
      if (!repo.enabled) return { body: { outcome: "not_enabled" } };
      if (!isGithubReviewEvent(event, payload)) return { body: { outcome: "ignored" } };
      return handleGithubEvent(repo, event, payload);
    },
  },
};
