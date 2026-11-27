import { HttpError } from "../../lib/httpError.ts";
import { once } from "../../lib/once.ts";
import { parseJson, parseReviewCommand, REVIEW_COMMAND, safeEqual } from "../../lib/webhook.ts";
import type { ForgeConnection } from "../../generated/prisma/client.ts";
import { GitLabAdapter } from "../../review/forge/gitlab.ts";
import { gitlabConnectSchema } from "../../schemas/connections.schema.ts";
import { gitlabAccessToken, gitlabOAuthConfigured } from "../gitlabOAuth.ts";
import { cancelQueuedForClosedChange, enqueue, enqueueFromWebhook } from "../../worker/queue.ts";
import { recordChangeState, recordChangeStateQuietly } from "../backlog.ts";
import { recordReviewComment } from "../reviewComments.ts";
import { recordThreadReply } from "../threadReplies.ts";
import { withdrawOnRetarget } from "./retarget.ts";
import type { ProviderDefinition, WebhookOutcome } from "./types.ts";
import { decryptToken } from "./token.ts";

const DEVELOPER = 30;

interface GitLabPayload {
  object_kind?: string;
  user?: { id: number; username?: string };
  object_attributes?: {
    id?: number;
    action?: string;
    iid?: number;
    author_id?: number;
    oldrev?: string;
    noteable_type?: string;
    note?: string;
    // "DiffNote" for a note on a diff line, which is where inline threads live.
    type?: string | null;
    discussion_id?: string;
    // DiffNotes only: where on the diff the note was left.
    position?: { new_path?: string; old_path?: string; new_line?: number | null };
    created_at?: string;
    last_commit?: { id: string };
    target_branch?: string;
  };
  changes?: {
    draft?: { previous: boolean; current: boolean };
    // Set when the target branch was changed.
    target_branch?: { previous: string; current: string };
  };
  merge_request?: { iid: number; last_commit: { id: string } };
}

function adapterFor(connection: ForgeConnection): GitLabAdapter {
  if (connection.kind === "oauth") {
    return new GitLabAdapter({
      host: connection.host,
      // By id, not from this snapshot: the stored token may have been refreshed since.
      token: () => gitlabAccessToken(connection.id),
      oauth: true,
      selfLogin: connection.accountLogin,
    });
  }
  const encryptedToken = connection.encryptedToken;
  if (!encryptedToken) {
    throw new HttpError(500, "GitLab connection has no token");
  }
  return new GitLabAdapter({
    host: connection.host,
    token: async () => decryptToken(encryptedToken, "GitLab"),
    selfLogin: connection.accountLogin,
  });
}

export const gitlabProvider: ProviderDefinition = {
  adapterFor,

  async checkCredentials(connection) {
    await adapterFor(connection).currentAccount();
  },

  tokenConnect: {
    schema: gitlabConnectSchema,
    account: (host, token) => new GitLabAdapter({ host, token: async () => token }).currentAccount(),
  },

  // GitLab has no app install; this is the OAuth connect flow. Events still
  // arrive through a hook registered on each repository.
  appAvailable: gitlabOAuthConfigured,

  repoWebhook: {
    verify: (header, _raw, secret) => safeEqual(header("x-gitlab-token") ?? "", secret),

    async handle(repo, header, raw) {
      if (!repo.enabled) return { body: { outcome: "not_enabled" } };

      const event = header("x-gitlab-event");
      const payload = parseJson<GitLabPayload>(raw);
      const attrs = payload.object_attributes ?? {};

      if (event === "Merge Request Hook" && (attrs.action === "close" || attrs.action === "merge") && attrs.iid) {
        const cancelled = await cancelQueuedForClosedChange(repo, attrs.iid);
        // Whatever abortOnClose says: a merge moves the change's findings into
        // the backlog. Only recorded here (one upsert); the worker applies it
        // once no review of the change is running. A failure fails the
        // delivery, and the sweep finds the merge either way.
        await recordChangeState({
          repositoryId: repo.id,
          number: attrs.iid,
          state: attrs.action === "merge" ? "merged" : "closed",
          baseBranch: attrs.target_branch,
        });
        return { body: { outcome: "closed", cancelled } };
      }

      // A change closed unmerged can come back; the sweep stops treating it as closed.
      if (event === "Merge Request Hook" && attrs.action === "reopen" && attrs.iid) {
        await recordChangeStateQuietly({ repositoryId: repo.id, number: attrs.iid, state: "open", baseBranch: attrs.target_branch });
      }

      if (event === "Merge Request Hook") {
        // A retarget withdraws Sentryward's approval (retarget.ts). The same
        // update may also have brought commits or taken the MR out of draft, so
        // it still goes through the trigger checks below; the retarget's own
        // outcome is returned only when there is no review to queue.
        let retarget: WebhookOutcome | undefined;
        if (attrs.action === "update" && payload.changes?.target_branch && attrs.iid) {
          retarget = await withdrawOnRetarget(adapterFor(repo.connection), repo, attrs.iid);
        }
        // An update only matters when it brought new commits (oldrev is set) or
        // took the MR out of draft, GitLab's equivalent of "ready for review".
        const pushed = attrs.action === "update" && Boolean(attrs.oldrev);
        const ready = attrs.action === "update" && payload.changes?.draft?.current === false;
        const opened = attrs.action === "open" || attrs.action === "reopen" || ready;
        if (!(opened || pushed) || !attrs.iid || !attrs.last_commit) return retarget ?? { body: { outcome: "ignored" } };
        const result = await enqueueFromWebhook({
          repositoryId: repo.id,
          number: attrs.iid,
          headSha: attrs.last_commit.id,
          trigger: "webhook",
          event: opened ? "open" : "push",
          actor: payload.user?.username,
          authorId: attrs.author_id === undefined ? undefined : String(attrs.author_id),
        });
        // A failed withdrawal still fails the delivery, after the push was queued.
        if (retarget?.status) return retarget;
        return { body: result.queued ? { outcome: "queued", reviewId: result.job.id } : { outcome: result.reason } };
      }

      if (event === "Note Hook" && attrs.noteable_type === "MergeRequest" && REVIEW_COMMAND.test(attrs.note ?? "")) {
        const mr = payload.merge_request;
        if (!mr || !payload.user) return { body: { outcome: "ignored" } };
        // GitLab's note payload does not say what the author may do; ask.
        const level = await adapterFor(repo.connection).memberAccessLevel(repo.externalId, payload.user.id);
        if (level < DEVELOPER) return { body: { outcome: "not_allowed" } };
        const job = await enqueue({
          repositoryId: repo.id,
          number: mr.iid,
          headSha: mr.last_commit.id,
          trigger: "comment",
          actor: payload.user.username,
          ...parseReviewCommand(attrs.note ?? ""),
        });
        return { body: { outcome: "queued", reviewId: job.id } };
      }

      // A note on a diff thread. The thread's own first note arrives here too;
      // recordThreadReply drops it by its marker. Both connection kinds post as
      // the connected person, so the login cannot tell the bot apart. Other
      // bots (access tokens, service accounts) are not marked in the payload
      // either; rule evidence asks the users API, once it would be kept.
      if (
        event === "Note Hook" &&
        attrs.noteable_type === "MergeRequest" &&
        attrs.type === "DiffNote" &&
        attrs.discussion_id &&
        attrs.id &&
        payload.merge_request &&
        payload.user
      ) {
        const user = payload.user;
        const forge = adapterFor(repo.connection);
        const number = payload.merge_request.iid;
        const threadId = attrs.discussion_id;
        // Both handlers may ask who the author is and what opened the
        // discussion; each forge call is made once per delivery.
        const allowed = once(async () => (await forge.memberAccessLevel(repo.externalId, user.id)) >= DEVELOPER);
        const threadRoot = once(() => forge.getThreadRoot({ project: repo.fullPath, number }, threadId));
        // Rule suggestion evidence when the workspace learns rules. Every note
        // of a discussion arrives with its id, so a discussion Sentryward opened
        // is skipped there, as are its own notes by their markers.
        const stored = await recordReviewComment({
          repo,
          number,
          commentId: String(attrs.id),
          threadId,
          threadRoot,
          author: user.username,
          body: attrs.note ?? "",
          createdAt: attrs.created_at,
          file: attrs.position?.new_path ?? attrs.position?.old_path,
          line: attrs.position?.new_line,
          isSelf: false,
          allowed,
          isBot: once(() => forge.userIsBot(user.id)),
        });
        const reply = await recordThreadReply({
          repo,
          forge,
          number,
          threadId,
          commentId: String(attrs.id),
          actor: user.username,
          body: attrs.note ?? "",
          botLogin: false,
          allowed,
          threadRoot,
        });
        // Every GitLab diff note is in a discussion, so unlike GitHub a failure
        // to store it cannot wait for a delivery without a thread. The reply is
        // handled first, then the delivery fails so GitLab can redeliver it:
        // both handlers answer "duplicate" for what they already recorded.
        // Only a failure a retry could fix: GitLab disables a hook that keeps
        // failing, which would stop automatic reviews too.
        if (stored === "failed") return { status: 500, body: { outcome: "failed" } };
        return reply;
      }

      return { body: { outcome: "ignored" } };
    },
  },
};
