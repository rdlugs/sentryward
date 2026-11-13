import { HttpError } from "../../lib/httpError.ts";
import { parseJson, parseReviewCommand, REVIEW_COMMAND, safeEqual } from "../../lib/webhook.ts";
import type { ForgeConnection } from "../../generated/prisma/client.ts";
import { GitLabAdapter } from "../../review/forge/gitlab.ts";
import { gitlabConnectSchema } from "../../schemas/connections.schema.ts";
import { gitlabAccessToken, gitlabOAuthConfigured } from "../gitlabOAuth.ts";
import { cancelQueuedForClosedChange, enqueue, enqueueFromWebhook } from "../../worker/queue.ts";
import { recordThreadReply } from "../threadReplies.ts";
import type { ProviderDefinition } from "./types.ts";
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
    last_commit?: { id: string };
  };
  changes?: { draft?: { previous: boolean; current: boolean } };
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
        return { body: { outcome: "closed", cancelled } };
      }

      if (event === "Merge Request Hook") {
        // An update only matters when it brought new commits (oldrev is set) or
        // took the MR out of draft, GitLab's equivalent of "ready for review".
        const pushed = attrs.action === "update" && Boolean(attrs.oldrev);
        const ready = attrs.action === "update" && payload.changes?.draft?.current === false;
        const opened = attrs.action === "open" || attrs.action === "reopen" || ready;
        if (!(opened || pushed) || !attrs.iid || !attrs.last_commit) return { body: { outcome: "ignored" } };
        const result = await enqueueFromWebhook({
          repositoryId: repo.id,
          number: attrs.iid,
          headSha: attrs.last_commit.id,
          trigger: "webhook",
          event: opened ? "open" : "push",
          actor: payload.user?.username,
          authorId: attrs.author_id === undefined ? undefined : String(attrs.author_id),
        });
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
          focus: parseReviewCommand(attrs.note ?? "").focus,
        });
        return { body: { outcome: "queued", reviewId: job.id } };
      }

      // A note on a diff thread. The thread's own first note arrives here too;
      // recordThreadReply drops it by its marker. Both connection kinds post as
      // the connected person, so the login cannot tell the bot apart.
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
        return recordThreadReply({
          repo,
          forge,
          number: payload.merge_request.iid,
          threadId: attrs.discussion_id,
          commentId: String(attrs.id),
          actor: user.username,
          body: attrs.note ?? "",
          botLogin: false,
          allowed: async () => (await forge.memberAccessLevel(repo.externalId, user.id)) >= DEVELOPER,
        });
      }

      return { body: { outcome: "ignored" } };
    },
  },
};
