import { createHmac } from "node:crypto";
import { env } from "../../config/env.ts";
import { HttpError } from "../../lib/httpError.ts";
import { once } from "../../lib/once.ts";
import { prisma } from "../../lib/prisma.ts";
import { parseJson, parseReviewCommand, REVIEW_COMMAND, safeEqual } from "../../lib/webhook.ts";
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
import { recordChangeState, recordChangeStateQuietly } from "../backlog.ts";
import { getGitHubApp, githubConfigured } from "../githubApp.ts";
import { recordReviewComment } from "../reviewComments.ts";
import { recordThreadReply } from "../threadReplies.ts";
import { withdrawOnRetarget } from "./retarget.ts";
import type { HeaderReader, ProviderDefinition, RepoWithConnection, WebhookOutcome } from "./types.ts";
import { decryptToken } from "./token.ts";

// "synchronize" brings new commits; the rest make a change reviewable.
const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
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
  pull_request?: {
    number: number;
    head: { sha: string };
    base?: { ref: string; sha?: string };
    user?: { id: number };
    // Set on "closed": merged tells a merge from a close.
    merged?: boolean;
    merged_at?: string | null;
    closed_at?: string | null;
  };
  // "edited" only: what changed. base is set when the target branch was.
  changes?: { base?: unknown };
  issue?: { number: number; pull_request?: unknown };
  comment?: {
    id?: number;
    body: string;
    author_association: string;
    // type is "Bot" for apps, Sentryward's own included.
    user?: { login: string; type?: string };
    // Review comments only: the thread's root comment, set on every reply.
    in_reply_to_id?: number;
    // Review comments only: the file and the line on the new side (null when
    // the comment is on a removed line or the line no longer exists).
    path?: string;
    line?: number | null;
    created_at?: string;
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

// A new comment on a diff line: rule suggestion evidence when its workspace
// learns rules (reviewComments.ts), and, when it has in_reply_to_id, a reply
// in an inline thread. Whether that thread is Sentryward's is only known once
// its root comment is read.
function isDiffComment(event: string | undefined, payload: GitHubPayload): boolean {
  return (
    event === "pull_request_review_comment" &&
    payload.action === "created" &&
    Boolean(payload.pull_request) &&
    Boolean(payload.comment?.id)
  );
}

// Closed covers merged: GitHub sends "closed" with merged set for both.
function isPullRequestClose(event: string | undefined, payload: GitHubPayload): boolean {
  return event === "pull_request" && payload.action === "closed";
}

// The target branch was changed. This queues no review, but an approval given
// for the old target must not go on counting for the new one.
function isPullRequestRetarget(event: string | undefined, payload: GitHubPayload): boolean {
  return event === "pull_request" && payload.action === "edited" && Boolean(payload.pull_request) && Boolean(payload.changes?.base);
}

export function isGithubReviewEvent(event: string | undefined, payload: GitHubPayload): boolean {
  return (
    isPullRequestPush(event, payload) ||
    isPullRequestRetarget(event, payload) ||
    isPullRequestClose(event, payload) ||
    isReviewCommand(event, payload) ||
    // Covers thread replies too.
    isDiffComment(event, payload)
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
    const pull = payload.pull_request!;
    const cancelled = await cancelQueuedForClosedChange(repo, pull.number);
    // Whatever abortOnClose says: a merge moves the change's findings into the
    // backlog. Only recorded here (one upsert); the worker applies it once no
    // review of the change is running. A failure fails the delivery, which can
    // be redelivered, and the sweep finds the merge either way.
    const at = pull.merged ? pull.merged_at : pull.closed_at;
    await recordChangeState({
      repositoryId: repo.id,
      number: pull.number,
      state: pull.merged ? "merged" : "closed",
      baseBranch: pull.base?.ref,
      closedAt: at ? new Date(at) : null,
    });
    return { body: { outcome: "closed", cancelled } };
  }

  if (isPullRequestRetarget(event, payload)) {
    return withdrawOnRetarget(adapterFor(repo.connection), repo, payload.pull_request!.number);
  }

  if (isPullRequestPush(event, payload)) {
    const pull = payload.pull_request!;
    // A change closed unmerged can come back; the sweep stops treating it as closed.
    if (payload.action === "reopened") {
      await recordChangeStateQuietly({ repositoryId: repo.id, number: pull.number, state: "open", baseBranch: pull.base?.ref });
    }
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

  if (isDiffComment(event, payload)) {
    const comment = payload.comment!;
    const number = payload.pull_request!.number;
    const threadId = comment.in_reply_to_id ? String(comment.in_reply_to_id) : undefined;
    const forge = adapterFor(repo.connection);
    // The repository role, not author_association, which does not tell read
    // collaborators from writers. One lookup per delivery serves both handlers.
    const login = comment.user?.login;
    const allowed = once(async () => (login ? forge.canPush(repo.fullPath, login) : false));
    // Both handlers may need the thread's root; one forge call serves them.
    const threadRoot = threadId ? once(() => forge.getThreadRoot({ project: repo.fullPath, number }, threadId)) : undefined;
    const stored = await recordReviewComment({
      repo,
      number,
      commentId: String(comment.id),
      threadId,
      threadRoot,
      author: comment.user?.login,
      body: comment.body ?? "",
      createdAt: comment.created_at,
      file: comment.path,
      line: comment.line,
      isSelf: comment.user?.type === "Bot",
      allowed,
    });
    if (!threadId) {
      // Nothing else rides on this delivery, so a failure fails it: GitHub
      // shows it as failed and it can be redelivered, instead of the evidence
      // being lost behind a success.
      if (stored === "failed") return { status: 500, body: { outcome: "failed" } };
      return { body: { outcome: stored === "stored" ? "recorded" : "ignored" } };
    }
    // A reply is handled first, then a failure to store the comment fails the
    // delivery as above (a reply in a person's own thread is evidence too).
    // A redelivery is safe: both handlers answer "duplicate" for what they
    // already recorded.
    const reply = await recordThreadReply({
      repo,
      forge,
      number,
      threadId,
      commentId: String(comment.id),
      actor: comment.user?.login,
      body: comment.body,
      botLogin: repo.connection.kind !== "token",
      allowed,
      threadRoot,
    });
    if (stored === "failed") return { status: 500, body: { outcome: "failed" } };
    return reply;
  }

  // Only people who can already push may start a (billed) review. Checked by
  // repository role, as for thread replies: author_association COLLABORATOR
  // also covers read and triage collaborators.
  const forge = adapterFor(repo.connection);
  const login = payload.comment!.user?.login;
  let allowed = false;
  if (login) {
    try {
      allowed = await forge.canPush(repo.fullPath, login);
    } catch (err) {
      // A connection that may not read collaborator permissions cannot show
      // the commenter may push, so the command is refused like an outsider's.
      // Anything else (rate limit, forge down) fails the delivery cleanly so
      // it can be redelivered.
      if (err instanceof ForgeError && err.status === 403 && !err.rateLimited) {
        console.warn("[webhook] cannot read %s's permission on %s; refusing the review command", login, repo.fullPath);
      } else {
        console.error("[webhook] permission lookup for the review command on %s failed", repo.fullPath, err);
        return { status: 500, body: { outcome: "failed" } };
      }
    }
  }
  if (!allowed) return { body: { outcome: "not_allowed" } };
  const number = payload.issue!.number;
  const head = await forge.getChangeHead(repo.fullPath, number);
  const job = await enqueue({
    repositoryId: repo.id,
    number,
    headSha: head.headSha,
    trigger: "comment",
    actor: payload.comment!.user?.login ?? payload.sender?.login,
    ...parseReviewCommand(payload.comment!.body ?? ""),
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
