import { createHmac } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { prisma } from "../src/lib/prisma.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { encryptWithOtherKey } from "./helpers/foreignKey.ts";
import { createUser } from "./helpers/users.ts";

const SECRET = "webhook-secret";
let workspaceId: string;

async function githubRepo(owner = workspaceId, enabled = true) {
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: owner, provider: "github", host: "github.com", kind: "github_app", installationId: "55", accountLogin: "acme" },
  });
  return prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "github",
      host: "github.com",
      fullPath: "acme/web",
      externalId: "900",
      defaultBranch: "main",
      enabled,
    },
  });
}

async function gitlabRepo() {
  const connection = await prisma.forgeConnection.create({
    data: {
      workspaceId,
      provider: "gitlab",
      host: "gitlab.com",
      kind: "token",
      accountLogin: "bot",
      encryptedToken: encrypt("glpat"),
    },
  });
  return prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "gitlab",
      host: "gitlab.com",
      fullPath: "team/app",
      externalId: "77",
      defaultBranch: "main",
      enabled: true,
      webhookId: "h1",
      encryptedWebhookSecret: encrypt("gl-secret"),
    },
  });
}

async function githubTokenRepo(enabled = true) {
  const connection = await prisma.forgeConnection.create({
    data: {
      workspaceId,
      provider: "github",
      host: "ghe.acme.com",
      kind: "token",
      accountLogin: "dev",
      encryptedToken: encrypt("ghp"),
    },
  });
  return prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "github",
      host: "ghe.acme.com",
      fullPath: "acme/api",
      externalId: "901",
      defaultBranch: "main",
      enabled,
      webhookId: "h2",
      encryptedWebhookSecret: encrypt("gh-repo-secret"),
    },
  });
}

function sendGithub(event: string, payload: unknown, secret = SECRET, path = "/api/webhooks/github") {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return request(app)
    .post(path)
    .set("Content-Type", "application/json")
    .set("X-GitHub-Event", event)
    .set("X-Hub-Signature-256", signature)
    .send(body);
}

const prEvent = (action: string, sha = "sha1") => ({
  action,
  installation: { id: 55 },
  repository: { id: 900 },
  pull_request: { number: 42, head: { sha } },
  sender: { login: "alice" },
});

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  ({ workspace: { id: workspaceId } } = await createUser());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/webhooks/github", () => {
  it("rejects a bad signature without touching anything", async () => {
    await githubRepo();
    const res = await sendGithub("pull_request", prEvent("opened"), "wrong-secret");
    expect(res.status).toBe(401);
    expect(await prisma.reviewJob.count()).toBe(0);
  });

  it("answers GitHub's ping", async () => {
    const res = await sendGithub("ping", { zen: "Keep it simple" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("pong");
  });

  it("queues a webhook review when a pull request opens, once per head", async () => {
    await githubRepo();

    const first = await sendGithub("pull_request", prEvent("opened"));
    const redelivery = await sendGithub("pull_request", prEvent("opened"));

    expect(first.status).toBe(202);
    expect(first.body.outcome).toBe("queued");
    expect(redelivery.body.outcome).toBe("duplicate");
    expect(await prisma.reviewJob.findMany({ select: { number: true, headSha: true, trigger: true } })).toEqual([
      { number: 42, headSha: "sha1", trigger: "webhook" },
    ]);
  });

  it("stores the pull request's author with the queued job", async () => {
    await githubRepo();
    const event = prEvent("opened");
    await sendGithub("pull_request", { ...event, pull_request: { ...event.pull_request, user: { id: 4242 } } });

    expect(await prisma.reviewJob.findMany({ select: { authorId: true } })).toEqual([{ authorId: "4242" }]);
  });

  it("does not re-review a head that was already reviewed", async () => {
    const repo = await githubRepo();
    await prisma.reviewJob.create({
      data: { repositoryId: repo.id, number: 42, headSha: "sha1", trigger: "webhook", status: "completed" },
    });

    expect((await sendGithub("pull_request", prEvent("synchronize"))).body.outcome).toBe("duplicate");
    expect((await sendGithub("pull_request", prEvent("synchronize", "sha2"))).body.outcome).toBe("queued");
  });

  it("records whether the change opened or received commits, and who did it", async () => {
    await githubRepo();
    await sendGithub("pull_request", prEvent("opened"));
    await sendGithub("pull_request", prEvent("synchronize", "sha2"));

    const jobs = await prisma.reviewJob.findMany({ orderBy: { createdAt: "asc" }, select: { event: true, actor: true } });
    expect(jobs).toEqual([
      { event: "open", actor: "alice" },
      { event: "push", actor: "alice" },
    ]);
  });

  it("reviews a draft's head again once it is marked ready for review", async () => {
    const repo = await githubRepo();
    await prisma.reviewJob.create({
      data: { repositoryId: repo.id, number: 42, headSha: "sha1", trigger: "webhook", status: "skipped" },
    });

    const res = await sendGithub("pull_request", prEvent("ready_for_review"));
    expect(res.body.outcome).toBe("queued");
  });

  it("ignores repositories that are not enabled and events it does not handle", async () => {
    await githubRepo(workspaceId, false);
    expect((await sendGithub("pull_request", prEvent("opened"))).body.outcome).toBe("not_enabled");
    expect((await sendGithub("pull_request", prEvent("labeled"))).body.outcome).toBe("ignored");
    expect((await sendGithub("push", {})).body.outcome).toBe("ignored");
    expect(await prisma.reviewJob.count()).toBe(0);
  });

  it("cancels the queued reviews of a closed PR unless abort on close is off", async () => {
    const repo = await githubRepo();
    await sendGithub("pull_request", prEvent("opened"));

    const res = await sendGithub("pull_request", prEvent("closed"));
    expect(res.body).toEqual({ outcome: "closed", cancelled: 1 });
    expect(await prisma.reviewJob.findFirst({ select: { status: true, error: true } })).toEqual({
      status: "cancelled",
      error: "The pull or merge request was closed or merged",
    });

    await prisma.reviewJob.deleteMany();
    await prisma.repository.update({
      where: { id: repo.id },
      data: { followGlobal: false, settings: { triggers: { abortOnClose: false } } },
    });
    await sendGithub("pull_request", prEvent("opened"));
    expect((await sendGithub("pull_request", prEvent("closed"))).body).toEqual({ outcome: "closed", cancelled: 0 });
    expect((await prisma.reviewJob.findFirst())!.status).toBe("queued");
  });

  it("reviews a shared installation's PR once, for the earliest enabled repository", async () => {
    const first = await githubRepo();
    const other = await createUser("other@example.com");
    await githubRepo(other.workspace.id);

    await sendGithub("pull_request", prEvent("opened"));

    const jobs = await prisma.reviewJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.repositoryId).toBe(first.id);
  });

  const commentEvent = (association: string, body = "Looks odd.\n/sentryward review please") => ({
    action: "created",
    installation: { id: 55 },
    repository: { id: 900 },
    issue: { number: 42, pull_request: {} },
    comment: { body, author_association: association },
  });

  it("queues a review for /sentryward review from a collaborator at the current head", async () => {
    await githubRepo();
    vi.stubGlobal(
      "fetch",
      fetchStub([
        {
          method: "POST",
          url: /\/app\/installations\/55\/access_tokens$/,
          body: { token: "inst", expires_at: new Date(Date.now() + 3600_000).toISOString() },
        },
        { url: /\/repos\/acme\/web\/pulls\/42$/, body: { state: "open", title: "T", base: { sha: "basenow", ref: "main" }, head: { sha: "headnow" } } },
      ]).fetch,
    );

    const res = await sendGithub("issue_comment", commentEvent("COLLABORATOR"));

    expect(res.body.outcome).toBe("queued");
    expect(await prisma.reviewJob.findFirst()).toMatchObject({ trigger: "comment", headSha: "headnow" });
  });

  it("ignores the command from someone without push access, and comments without it", async () => {
    await githubRepo();
    expect((await sendGithub("issue_comment", commentEvent("NONE"))).body.outcome).toBe("not_allowed");
    expect((await sendGithub("issue_comment", commentEvent("OWNER", "nice work"))).body.outcome).toBe("ignored");
    expect(await prisma.reviewJob.count()).toBe(0);
  });

  it("detaches an uninstalled installation but keeps its review history", async () => {
    const repo = await githubRepo();
    await prisma.reviewJob.create({ data: { repositoryId: repo.id, number: 42, headSha: "sha1", trigger: "manual" } });

    const res = await sendGithub("installation", { action: "deleted", installation: { id: 55 } });

    expect(res.body).toEqual({ outcome: "uninstalled", connections: 1 });
    expect(await prisma.forgeConnection.findFirstOrThrow()).toMatchObject({ installationId: null });
    expect(await prisma.repository.count()).toBe(1);
    expect(await prisma.reviewJob.count()).toBe(1);
    expect((await sendGithub("pull_request", prEvent("opened"))).body.outcome).toBe("not_enabled");
  });

  it("disables the repositories removed from an installation", async () => {
    const repo = await githubRepo();
    const kept = await prisma.repository.create({
      data: {
        connectionId: repo.connectionId,
        provider: "github",
        host: "github.com",
        fullPath: "acme/api",
        externalId: "901",
        defaultBranch: "main",
        enabled: true,
      },
    });
    const jobOf = (repositoryId: string) =>
      prisma.reviewJob.create({ data: { repositoryId, number: 1, headSha: "h1", trigger: "webhook", status: "queued" } });
    const lostJob = await jobOf(repo.id);
    const keptJob = await jobOf(kept.id);

    const res = await sendGithub("installation_repositories", {
      action: "removed",
      installation: { id: 55 },
      repositories_removed: [{ id: 900 }],
    });

    expect(res.body).toEqual({ outcome: "repositories_removed", repositories: 1 });
    expect(
      await prisma.repository.findMany({ select: { id: true, enabled: true, accessLostAt: true }, orderBy: { fullPath: "asc" } }),
    ).toEqual([
      { id: kept.id, enabled: true, accessLostAt: null },
      { id: repo.id, enabled: false, accessLostAt: expect.any(Date) },
    ]);
    // Their in-flight reviews are cancelled with the reason, others left alone.
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: lostJob.id } })).toMatchObject({
      status: "cancelled",
      error: "Sentryward lost access to this repository",
    });
    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: keptJob.id } })).status).toBe("queued");
  });

  it("does not mark a repository the user disabled as having lost access", async () => {
    await githubRepo(workspaceId, false);

    const res = await sendGithub("installation_repositories", {
      action: "removed",
      installation: { id: 55 },
      repositories_removed: [{ id: 900 }],
    });

    expect(res.body).toEqual({ outcome: "repositories_removed", repositories: 0 });
    expect(await prisma.repository.findFirstOrThrow()).toMatchObject({ enabled: false, accessLostAt: null });
  });

  it("re-enables only the repositories that lost access when they are added back", async () => {
    const lost = await githubRepo(workspaceId, false);
    await prisma.repository.update({ where: { id: lost.id }, data: { accessLostAt: new Date() } });
    const userDisabled = await prisma.repository.create({
      data: {
        connectionId: lost.connectionId,
        provider: "github",
        host: "github.com",
        fullPath: "acme/api",
        externalId: "901",
        defaultBranch: "main",
        enabled: false,
      },
    });

    const res = await sendGithub("installation_repositories", {
      action: "added",
      installation: { id: 55 },
      repositories_added: [{ id: 900 }, { id: 901 }],
    });

    expect(res.body).toEqual({ outcome: "repositories_added", repositories: 1 });
    expect(
      await prisma.repository.findMany({ select: { id: true, enabled: true, accessLostAt: true }, orderBy: { fullPath: "asc" } }),
    ).toEqual([
      { id: userDisabled.id, enabled: false, accessLostAt: null },
      { id: lost.id, enabled: true, accessLostAt: null },
    ]);
  });
});

function sendGitlab(repoId: string, event: string, payload: unknown, token = "gl-secret") {
  return request(app)
    .post(`/api/webhooks/gitlab/${repoId}`)
    .set("Content-Type", "application/json")
    .set("X-Gitlab-Event", event)
    .set("X-Gitlab-Token", token)
    .send(JSON.stringify(payload));
}

const mrEvent = (action: string, extra: Record<string, unknown> = {}) => ({
  object_kind: "merge_request",
  object_attributes: { action, iid: 7, last_commit: { id: "glsha" }, ...extra },
});

describe("POST /api/webhooks/github/:repoId", () => {
  const sendRepo = (repoId: string, event: string, payload: unknown, secret = "gh-repo-secret") =>
    sendGithub(event, payload, secret, `/api/webhooks/github/${repoId}`);
  const repoPrEvent = (action: string) => ({ action, repository: { id: 901 }, pull_request: { number: 8, head: { sha: "ghsha" } } });

  it("rejects a wrong signature and an unknown repository alike", async () => {
    const repo = await githubTokenRepo();
    expect((await sendRepo(repo.id, "pull_request", repoPrEvent("opened"), "nope")).status).toBe(401);
    expect((await sendRepo("00000000-0000-4000-8000-000000000000", "pull_request", repoPrEvent("opened"))).status).toBe(401);
    expect(await prisma.reviewJob.count()).toBe(0);
  });

  it("rejects a hook whose stored secret can no longer be decrypted", async () => {
    const repo = await githubTokenRepo();
    await prisma.repository.update({
      where: { id: repo.id },
      data: { encryptedWebhookSecret: encryptWithOtherKey("gh-repo-secret") },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect((await sendRepo(repo.id, "pull_request", repoPrEvent("opened"))).status).toBe(401);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("acme/api"));
    expect(await prisma.reviewJob.count()).toBe(0);
    warn.mockRestore();
  });

  it("answers the ping GitHub sends when the hook is created", async () => {
    const repo = await githubTokenRepo();
    expect((await sendRepo(repo.id, "ping", { zen: "Hi" })).body.outcome).toBe("pong");
  });

  it("queues a review for a pull request without an installation", async () => {
    const repo = await githubTokenRepo();

    const res = await sendRepo(repo.id, "pull_request", repoPrEvent("opened"));

    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe("queued");
    expect(await prisma.reviewJob.findMany({ select: { repositoryId: true, number: true, headSha: true } })).toEqual([
      { repositoryId: repo.id, number: 8, headSha: "ghsha" },
    ]);
  });

  it("refuses a hook delivered under another provider's path or an unknown provider", async () => {
    const repo = await githubTokenRepo();
    const res = await request(app)
      .post(`/api/webhooks/gitlab/${repo.id}`)
      .set("Content-Type", "application/json")
      .set("X-Gitlab-Event", "Merge Request Hook")
      .set("X-Gitlab-Token", "gh-repo-secret")
      .send(JSON.stringify({ object_attributes: { action: "open", iid: 1, last_commit: { id: "x" } } }));
    expect(res.status).toBe(401);
    expect((await sendGithub("pull_request", repoPrEvent("opened"), "gh-repo-secret", `/api/webhooks/bitbucket/${repo.id}`)).status).toBe(404);
    expect(await prisma.reviewJob.count()).toBe(0);
  });

  it("ignores a disabled repository and unhandled events", async () => {
    const disabled = await githubTokenRepo(false);
    expect((await sendRepo(disabled.id, "pull_request", repoPrEvent("opened"))).body.outcome).toBe("not_enabled");
    await prisma.repository.update({ where: { id: disabled.id }, data: { enabled: true } });
    expect((await sendRepo(disabled.id, "pull_request", repoPrEvent("labeled"))).body.outcome).toBe("ignored");
    expect(await prisma.reviewJob.count()).toBe(0);
  });

  it("queues nothing while the forge refuses the connection's credentials", async () => {
    const repo = await githubTokenRepo();
    await prisma.forgeConnection.update({ where: { id: repo.connectionId }, data: { credentialsRejectedAt: new Date() } });

    const res = await sendRepo(repo.id, "pull_request", repoPrEvent("opened"));

    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe("reconnect_required");
    expect(await prisma.reviewJob.count()).toBe(0);
  });
});

describe("POST /api/webhooks/gitlab/:repoId", () => {
  it("rejects a wrong token and an unknown repository alike", async () => {
    const repo = await gitlabRepo();
    expect((await sendGitlab(repo.id, "Merge Request Hook", mrEvent("open"), "nope")).status).toBe(401);
    expect((await sendGitlab("00000000-0000-4000-8000-000000000000", "Merge Request Hook", mrEvent("open"))).status).toBe(401);
  });

  it("queues on open, and on update only when new commits arrived", async () => {
    const repo = await gitlabRepo();

    expect((await sendGitlab(repo.id, "Merge Request Hook", mrEvent("update"))).body.outcome).toBe("ignored");
    expect((await sendGitlab(repo.id, "Merge Request Hook", mrEvent("open"))).body.outcome).toBe("queued");
    expect(
      (await sendGitlab(repo.id, "Merge Request Hook", mrEvent("update", { oldrev: "x", last_commit: { id: "next" } }))).body
        .outcome,
    ).toBe("queued");
    expect(await prisma.reviewJob.count({ where: { status: { not: "superseded" } } })).toBe(1);
  });

  it("stores the merge request's author with the queued job", async () => {
    const repo = await gitlabRepo();
    await sendGitlab(repo.id, "Merge Request Hook", mrEvent("open", { author_id: 77 }));

    expect(await prisma.reviewJob.findMany({ select: { authorId: true } })).toEqual([{ authorId: "77" }]);
  });

  it("cancels queued reviews when the MR is merged or closed", async () => {
    const repo = await gitlabRepo();
    await sendGitlab(repo.id, "Merge Request Hook", mrEvent("open"));

    expect((await sendGitlab(repo.id, "Merge Request Hook", mrEvent("merge"))).body).toEqual({ outcome: "closed", cancelled: 1 });
    expect((await sendGitlab(repo.id, "Merge Request Hook", mrEvent("close"))).body).toEqual({ outcome: "closed", cancelled: 0 });
    expect((await prisma.reviewJob.findFirst())!.status).toBe("cancelled");
  });

  it("queues nothing while the forge refuses the connection's credentials, and resumes once cleared", async () => {
    const repo = await gitlabRepo();
    await prisma.forgeConnection.update({ where: { id: repo.connectionId }, data: { credentialsRejectedAt: new Date() } });

    expect((await sendGitlab(repo.id, "Merge Request Hook", mrEvent("open"))).body.outcome).toBe("reconnect_required");
    expect(await prisma.reviewJob.count()).toBe(0);

    await prisma.forgeConnection.update({ where: { id: repo.connectionId }, data: { credentialsRejectedAt: null } });
    expect((await sendGitlab(repo.id, "Merge Request Hook", mrEvent("open"))).body.outcome).toBe("queued");
  });

  it("records the event and actor, and treats leaving draft as opening", async () => {
    const repo = await gitlabRepo();
    const user = { id: 5, username: "bob" };

    await sendGitlab(repo.id, "Merge Request Hook", { ...mrEvent("open"), user });
    await sendGitlab(repo.id, "Merge Request Hook", {
      ...mrEvent("update", { oldrev: "x", last_commit: { id: "next" } }),
      user,
    });
    const ready = await sendGitlab(repo.id, "Merge Request Hook", {
      ...mrEvent("update", { last_commit: { id: "ready" } }),
      user,
      changes: { draft: { previous: true, current: false } },
    });
    expect(ready.body.outcome).toBe("queued");

    const jobs = await prisma.reviewJob.findMany({ orderBy: { createdAt: "asc" }, select: { event: true, actor: true } });
    expect(jobs).toEqual([
      { event: "open", actor: "bob" },
      { event: "push", actor: "bob" },
      { event: "open", actor: "bob" },
    ]);
  });

  const noteEvent = { object_kind: "note", user: { id: 5 }, object_attributes: { noteable_type: "MergeRequest", note: "/sentryward review" }, merge_request: { iid: 7, last_commit: { id: "glsha" } } };

  it("accepts the command from a developer and refuses a reporter", async () => {
    const repo = await gitlabRepo();
    let level = 30;
    vi.stubGlobal(
      "fetch",
      fetchStub([
        {
          url: /\/projects\/77\/members\/all\/5$/,
          get body() {
            return { access_level: level };
          },
        },
      ]).fetch,
    );

    expect((await sendGitlab(repo.id, "Note Hook", noteEvent)).body.outcome).toBe("queued");
    level = 20;
    await prisma.reviewJob.deleteMany();
    expect((await sendGitlab(repo.id, "Note Hook", noteEvent)).body.outcome).toBe("not_allowed");
  });
});

describe("replies on inline threads", () => {
  const FP = "0123456789abcdef";
  const installationToken = {
    method: "POST",
    url: /\/app\/installations\/55\/access_tokens$/,
    body: { token: "inst", expires_at: new Date(Date.now() + 3600_000).toISOString() },
  };
  const rootComment = (login = "sentryward-test[bot]", body = `**Bug**\n<!-- sentryward:fp=${FP} -->`) => ({
    url: /\/repos\/acme\/web\/pulls\/comments\/700$/,
    body: { id: 700, body, user: { login } },
  });
  const replyEvent = (body: string, extra: Record<string, unknown> = {}) => ({
    action: "created",
    installation: { id: 55 },
    repository: { id: 900 },
    pull_request: { number: 42, head: { sha: "sha1" } },
    comment: { id: 701, in_reply_to_id: 700, body, author_association: "MEMBER", user: { login: "alice" }, ...extra },
  });
  // A finding on the change, without which no note is looked at.
  const tracked = (repositoryId: string, number: number) =>
    prisma.finding.create({
      data: {
        repositoryId,
        number,
        fingerprint: FP,
        title: "Bug",
        file: "src/app.ts",
        startLine: 1,
        severity: "major",
        category: "bug",
        kind: "issue",
        changeTitle: "Change",
      },
    });

  it("records an ignore command on a GitHub finding thread", async () => {
    const repo = await githubRepo();
    await tracked(repo.id, 42);
    vi.stubGlobal("fetch", fetchStub([installationToken, rootComment()]).fetch);

    const res = await sendGithub("pull_request_review_comment", replyEvent("/sentryward ignore intentional legacy API"));

    expect(res.body.outcome).toBe("queued");
    expect(await prisma.threadReply.findFirst()).toMatchObject({
      repositoryId: repo.id,
      number: 42,
      fingerprint: FP,
      threadId: "700",
      commentId: "701",
      actor: "alice",
      kind: "ignore",
      ignoreReason: "intentional",
      ignoreNote: "legacy API",
      status: "queued",
    });
  });

  it("records a question, and a redelivery only once", async () => {
    await tracked((await githubRepo()).id, 42);
    vi.stubGlobal("fetch", fetchStub([installationToken, rootComment()]).fetch);

    expect((await sendGithub("pull_request_review_comment", replyEvent("Why is this a problem?"))).body.outcome).toBe("queued");
    expect((await sendGithub("pull_request_review_comment", replyEvent("Why is this a problem?"))).body.outcome).toBe("duplicate");
    expect(await prisma.threadReply.findMany()).toMatchObject([{ kind: "question", ignoreReason: null }]);
  });

  it("never answers the bot itself, nor a reply carrying its marker", async () => {
    await tracked((await githubRepo()).id, 42);
    const stub = fetchStub([installationToken, rootComment()]);
    vi.stubGlobal("fetch", stub.fetch);

    const own = replyEvent("Answer", { user: { login: "sentryward-test[bot]" } });
    expect((await sendGithub("pull_request_review_comment", own)).body.outcome).toBe("ignored");
    const marked = replyEvent("Answer\n<!-- sentryward:reply -->");
    expect((await sendGithub("pull_request_review_comment", marked)).body.outcome).toBe("ignored");
    expect(stub.calls).toHaveLength(0);
    expect(await prisma.threadReply.count()).toBe(0);
  });

  it("refuses people without push access and threads Sentryward did not start", async () => {
    await tracked((await githubRepo()).id, 42);
    vi.stubGlobal("fetch", fetchStub([installationToken, rootComment("bob")]).fetch);

    const outsider = replyEvent("/sentryward ignore false-positive", { author_association: "CONTRIBUTOR" });
    expect((await sendGithub("pull_request_review_comment", outsider)).body.outcome).toBe("not_allowed");
    expect((await sendGithub("pull_request_review_comment", replyEvent("Hm?"))).body.outcome).toBe("ignored");
    // A top-level review comment is not a reply.
    const topLevel = replyEvent("Hm?", { in_reply_to_id: undefined });
    expect((await sendGithub("pull_request_review_comment", topLevel)).body.outcome).toBe("ignored");
    expect(await prisma.threadReply.count()).toBe(0);
  });

  it("stops recording replies on a change past the hourly limit", async () => {
    const repo = await githubRepo();
    await tracked(repo.id, 42);
    vi.stubGlobal("fetch", fetchStub([installationToken, rootComment()]).fetch);
    await prisma.threadReply.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        repositoryId: repo.id,
        number: 42,
        fingerprint: FP,
        threadId: "700",
        commentId: `old-${i}`,
        actor: "alice",
        kind: "question" as const,
        body: "?",
      })),
    });

    expect((await sendGithub("pull_request_review_comment", replyEvent("One more?"))).body.outcome).toBe("rate_limited");
    // Old replies no longer count.
    await prisma.threadReply.updateMany({ data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    expect((await sendGithub("pull_request_review_comment", replyEvent("One more?"))).body.outcome).toBe("queued");
  });

  it("holds the hourly limit under concurrent deliveries", async () => {
    await tracked((await githubRepo()).id, 42);
    vi.stubGlobal("fetch", fetchStub([installationToken, rootComment()]).fetch);

    const outcomes = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        sendGithub("pull_request_review_comment", replyEvent("Why?", { id: 800 + i })).then((res) => res.body.outcome),
      ),
    );

    expect(outcomes.filter((o) => o === "queued")).toHaveLength(10);
    expect(outcomes.filter((o) => o === "rate_limited")).toHaveLength(5);
  });

  it("looks no further on a change Sentryward raised nothing on", async () => {
    await githubRepo();
    const stub = fetchStub([installationToken, rootComment()]);
    vi.stubGlobal("fetch", stub.fetch);

    expect((await sendGithub("pull_request_review_comment", replyEvent("Why?"))).body.outcome).toBe("ignored");
    expect(stub.calls).toHaveLength(0);
  });

  it("fails the delivery when the forge cannot be reached", async () => {
    await tracked((await githubRepo()).id, 42);
    vi.stubGlobal("fetch", fetchStub([installationToken, { ...rootComment(), status: 502 }]).fetch);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await sendGithub("pull_request_review_comment", replyEvent("Why?"))).status).toBe(503);
    expect(await prisma.threadReply.count()).toBe(0);
    error.mockRestore();
  });

  it("answers the person who connected a token, who shares the bot's login", async () => {
    const repo = await githubTokenRepo();
    await tracked(repo.id, 8);
    vi.stubGlobal(
      "fetch",
      fetchStub([{ url: /\/repos\/acme\/api\/pulls\/comments\/700$/, body: { id: 700, body: `<!-- sentryward:fp=${FP} -->`, user: { login: "dev" } } }]).fetch,
    );
    const event = {
      action: "created",
      repository: { id: 901 },
      pull_request: { number: 8, head: { sha: "ghsha" } },
      comment: { id: 701, in_reply_to_id: 700, body: "Why?", author_association: "OWNER", user: { login: "dev" } },
    };

    const res = await sendGithub("pull_request_review_comment", event, "gh-repo-secret", `/api/webhooks/github/${repo.id}`);

    expect(res.body.outcome).toBe("queued");
    // Its own answers still carry the marker.
    const own = { ...event, comment: { ...event.comment, id: 702, body: "Answer\n<!-- sentryward:reply -->" } };
    expect((await sendGithub("pull_request_review_comment", own, "gh-repo-secret", `/api/webhooks/github/${repo.id}`)).body.outcome).toBe("ignored");
  });

  const diffNote = (note: string, username = "alice") => ({
    object_kind: "note",
    user: { id: 5, username },
    object_attributes: { id: 9001, noteable_type: "MergeRequest", type: "DiffNote", discussion_id: "disc1", note },
    merge_request: { iid: 7, last_commit: { id: "glsha" } },
  });

  it("records replies on a GitLab diff thread from a developer only", async () => {
    const repo = await gitlabRepo();
    await tracked(repo.id, 7);
    let level = 30;
    vi.stubGlobal(
      "fetch",
      fetchStub([
        {
          url: /\/projects\/77\/members\/all\/5$/,
          get body() {
            return { access_level: level };
          },
        },
        {
          url: /\/projects\/team%2Fapp\/merge_requests\/7\/discussions\/disc1$/,
          body: {
            id: "disc1",
            notes: [
              { id: 9000, body: `**Bug**\n<!-- sentryward:fp=${FP} -->`, system: false, author: { username: "bot" } },
              { id: 9001, body: "/sentryward ignore false-positive", system: false, author: { username: "alice" } },
            ],
          },
        },
      ]).fetch,
    );

    expect((await sendGitlab(repo.id, "Note Hook", diffNote("/sentryward ignore false-positive"))).body.outcome).toBe("queued");
    expect(await prisma.threadReply.findFirst()).toMatchObject({
      number: 7,
      threadId: "disc1",
      commentId: "9001",
      kind: "ignore",
      ignoreReason: "false_positive",
    });
    // The bot's own notes, including the thread's first, are never replies.
    // They are told apart by marker: the connection posts as a person.
    expect((await sendGitlab(repo.id, "Note Hook", diffNote("Answer\n<!-- sentryward:reply -->", "bot"))).body.outcome).toBe("ignored");
    expect((await sendGitlab(repo.id, "Note Hook", diffNote(`**Bug**\n<!-- sentryward:fp=${FP} -->`, "bot"))).body.outcome).toBe("ignored");
    await prisma.threadReply.deleteMany();
    // The connected person's own reply is answered.
    expect((await sendGitlab(repo.id, "Note Hook", diffNote("Why?", "bot"))).body.outcome).toBe("queued");
    level = 20;
    await prisma.threadReply.deleteMany();
    expect((await sendGitlab(repo.id, "Note Hook", diffNote("Why?"))).body.outcome).toBe("not_allowed");
  });
});
