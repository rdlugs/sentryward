import request from "supertest";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import { decrypt, encrypt } from "../src/lib/crypto.ts";
import { prisma } from "../src/lib/prisma.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { encryptWithOtherKey } from "./helpers/foreignKey.ts";
import { gitlabAccessToken, ReconnectRequiredError } from "../src/services/gitlabOAuth.ts";
import { addMember, createTeam, createUser, inWorkspace } from "./helpers/users.ts";

let cookie: string;
let userId: string;
let workspaceId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  ({ cookie, user: { id: userId }, workspace: { id: workspaceId } } = await createUser());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/connections/gitlab", () => {
  it("validates the token, stores it encrypted and never returns it", async () => {
    const { fetch, calls } = fetchStub([{ url: /gitlab\.acme\.com\/api\/v4\/user$/, body: { username: "dev" } }]);
    vi.stubGlobal("fetch", fetch);

    const res = await request(app)
      .post("/api/connections/gitlab")
      .set("Cookie", cookie)
      .send({ host: "https://gitlab.acme.com/", token: "glpat-secret" });

    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({ provider: "gitlab", host: "gitlab.acme.com", accountLogin: "dev" });
    expect(JSON.stringify(res.body)).not.toContain("glpat-secret");
    expect(calls[0]!.headers["private-token"]).toBe("glpat-secret");

    const stored = await prisma.forgeConnection.findFirstOrThrow({ where: { workspaceId } });
    expect(stored.encryptedToken).not.toContain("glpat-secret");
    expect(decrypt(stored.encryptedToken!)).toBe("glpat-secret");
  });

  it("updates the token when the same account reconnects", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/user$/, body: { username: "dev" } }]).fetch);

    await request(app).post("/api/connections/gitlab").set("Cookie", cookie).send({ token: "one" });
    const res = await request(app).post("/api/connections/gitlab").set("Cookie", cookie).send({ token: "two" });

    expect(res.status).toBe(200);
    const stored = await prisma.forgeConnection.findMany({ where: { workspaceId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.host).toBe("gitlab.com");
    expect(decrypt(stored[0]!.encryptedToken!)).toBe("two");
  });

  it("resumes a connection whose token was refused, keeping its repositories and reviews", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/user$/, body: { username: "dev" } }]).fetch);
    await request(app).post("/api/connections/gitlab").set("Cookie", cookie).send({ token: "one" });
    const { id } = await prisma.forgeConnection.findFirstOrThrow({ where: { workspaceId } });
    const connection = await prisma.forgeConnection.update({ where: { id }, data: { credentialsRejectedAt: new Date() } });
    const repo = await prisma.repository.create({
      data: { connectionId: connection.id, provider: "gitlab", host: "gitlab.com", fullPath: "dev/app", externalId: "1", defaultBranch: "main", enabled: true },
    });
    await prisma.reviewJob.create({ data: { repositoryId: repo.id, number: 1, headSha: "a", trigger: "webhook", status: "failed" } });

    const res = await request(app).post("/api/connections/gitlab").set("Cookie", cookie).send({ token: "two" });

    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ id: connection.id, credentialsRejectedAt: null });
    expect(await prisma.repository.count({ where: { connectionId: connection.id, enabled: true } })).toBe(1);
    expect(await prisma.reviewJob.count({ where: { repositoryId: repo.id } })).toBe(1);
  });

  it("rejects a token GitLab refuses", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/user$/, status: 401, body: { message: "401 Unauthorized" } }]).fetch);

    const res = await request(app).post("/api/connections/gitlab").set("Cookie", cookie).send({ token: "bad" });

    expect(res.status).toBe(400);
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("returns field errors for a bad host and missing token", async () => {
    const res = await request(app)
      .post("/api/connections/gitlab")
      .set("Cookie", cookie)
      .send({ host: "gitlab.com/group" });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.errors)).toEqual(expect.arrayContaining(["host", "token"]));
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/api/connections/gitlab").send({ token: "x" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/connections/github", () => {
  it("validates an Enterprise Server token against /api/v3 and stores it encrypted", async () => {
    const { fetch, calls } = fetchStub([{ url: /ghe\.acme\.com\/api\/v3\/user$/, body: { login: "dev" } }]);
    vi.stubGlobal("fetch", fetch);

    const res = await request(app)
      .post("/api/connections/github")
      .set("Cookie", cookie)
      .send({ host: "https://ghe.acme.com/", token: "ghp-secret" });

    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({ provider: "github", kind: "token", host: "ghe.acme.com", accountLogin: "dev" });
    expect(JSON.stringify(res.body)).not.toContain("ghp-secret");
    expect(calls[0]!.headers.authorization).toBe("Bearer ghp-secret");

    const stored = await prisma.forgeConnection.findFirstOrThrow({ where: { workspaceId } });
    expect(decrypt(stored.encryptedToken!)).toBe("ghp-secret");
  });

  it("updates the token when the same account reconnects", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/user$/, body: { login: "dev" } }]).fetch);

    const send = (token: string) =>
      request(app).post("/api/connections/github").set("Cookie", cookie).send({ host: "ghe.acme.com", token });
    await send("one");
    const res = await send("two");

    expect(res.status).toBe(200);
    const stored = await prisma.forgeConnection.findMany({ where: { workspaceId } });
    expect(stored).toHaveLength(1);
    expect(decrypt(stored[0]!.encryptedToken!)).toBe("two");
  });

  it("rejects a token GitHub refuses", async () => {
    vi.stubGlobal("fetch", fetchStub([{ url: /\/user$/, status: 401, body: { message: "Bad credentials" } }]).fetch);

    const res = await request(app)
      .post("/api/connections/github")
      .set("Cookie", cookie)
      .send({ host: "ghe.acme.com", token: "bad" });

    expect(res.status).toBe(400);
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("sends github.com to the GitHub App and requires a host", async () => {
    const dotcom = await request(app)
      .post("/api/connections/github")
      .set("Cookie", cookie)
      .send({ host: "github.com", token: "x" });
    const missing = await request(app).post("/api/connections/github").set("Cookie", cookie).send({ token: "x" });

    expect(dotcom.status).toBe(400);
    expect(Object.keys(dotcom.body.errors)).toEqual(["host"]);
    expect(missing.status).toBe(400);
    expect(Object.keys(missing.body.errors)).toContain("host");
  });
});

describe("POST /api/connections/:provider", () => {
  it("404s for a provider Sentryward does not know", async () => {
    const res = await request(app).post("/api/connections/bitbucket").set("Cookie", cookie).send({ token: "x" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/connections", () => {
  it("lists only the caller's connections without secrets", async () => {
    const other = await createUser("other@example.com");
    await prisma.forgeConnection.createMany({
      data: [
        { workspaceId, createdById: userId, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "me", encryptedToken: "v1.x" },
        { workspaceId: other.workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "them" },
      ],
    });

    const mine = await prisma.forgeConnection.findFirstOrThrow({ where: { workspaceId } });
    const repo = { connectionId: mine.id, provider: "gitlab", host: "gitlab.com", defaultBranch: "main" } as const;
    await prisma.repository.createMany({
      data: [
        { ...repo, externalId: "1", fullPath: "me/on", enabled: true },
        { ...repo, externalId: "2", fullPath: "me/off", enabled: false },
      ],
    });

    const res = await request(app).get("/api/connections").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.availableApps).toEqual(["gitlab", "github"]);
    expect(res.body.oauthHosts).toEqual({ gitlab: "gitlab.acme.com" });
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.connections[0]).toMatchObject({
      accountLogin: "me",
      createdBy: { name: "Dev", email: "dev@example.com" },
      repositoryCount: 1,
    });
    expect(res.body.connections[0].encryptedToken).toBeUndefined();
  });
});

describe("PUT /api/connections/order", () => {
  const connection = (accountLogin: string, extra: { workspaceId?: string; createdAt?: Date } = {}) =>
    prisma.forgeConnection.create({
      data: { workspaceId, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin, ...extra },
    });
  const logins = async () =>
    (await request(app).get("/api/connections").set("Cookie", cookie)).body.connections.map(
      (c: { accountLogin: string }) => c.accountLogin,
    );
  const reorder = (ids: string[]) => request(app).put("/api/connections/order").set("Cookie", cookie).send({ ids });

  it("saves the order the list returns, with later connections after it", async () => {
    const a = await connection("a", { createdAt: new Date("2026-01-01") });
    const b = await connection("b", { createdAt: new Date("2026-02-01") });
    const c = await connection("c", { createdAt: new Date("2026-03-01") });
    expect(await logins()).toEqual(["a", "b", "c"]);

    expect((await reorder([c.id, a.id, b.id])).status).toBe(204);
    expect(await logins()).toEqual(["c", "a", "b"]);

    await connection("d", { createdAt: new Date("2026-04-01") });
    expect(await logins()).toEqual(["c", "a", "b", "d"]);
  });

  it("409s unless the ids are exactly the workspace's connections", async () => {
    const other = await createUser("other@example.com");
    const a = await connection("a");
    const b = await connection("b");
    const theirs = await connection("them", { workspaceId: other.workspace.id });

    expect((await reorder([a.id])).status).toBe(409);
    expect((await reorder([a.id, b.id, theirs.id])).status).toBe(409);
    expect((await reorder([a.id, theirs.id])).status).toBe(409);
    const stored = await prisma.forgeConnection.findMany({ select: { position: true } });
    expect(stored.every((row) => row.position === null)).toBe(true);
  });

  it("400s on a repeated id", async () => {
    const a = await connection("a");
    expect((await reorder([a.id, a.id])).status).toBe(400);
  });

  it("refuses workspace members who are not admins", async () => {
    const owner = await createUser("owner@example.com");
    const team = await createTeam(owner.user.id, "Acme");
    await addMember(team.id, userId, "member");
    const a = await connection("a", { workspaceId: team.id });

    const res = await request(app)
      .put("/api/connections/order")
      .set("Cookie", cookie)
      .set(...inWorkspace(team.id))
      .send({ ids: [a.id] });

    expect(res.status).toBe(403);
    expect((await prisma.forgeConnection.findUniqueOrThrow({ where: { id: a.id } })).position).toBeNull();
  });
});

describe("GET /api/connections/:id/status", () => {
  const gitlabConnection = (owner = workspaceId) =>
    prisma.forgeConnection.create({
      data: {
        workspaceId: owner,
        provider: "gitlab",
        host: "gitlab.com",
        kind: "token",
        accountLogin: "me",
        encryptedToken: encrypt("glpat-x"),
      },
    });

  const statusFor = async (id: string) =>
    (await request(app).get(`/api/connections/${id}/status`).set("Cookie", cookie)).body.status;

  it("reports a token the forge accepts as active", async () => {
    const connection = await gitlabConnection();
    vi.stubGlobal("fetch", fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, body: { username: "me" } }]).fetch);

    expect(await statusFor(connection.id)).toBe("active");
  });

  it("reports a refused token as revoked", async () => {
    const connection = await gitlabConnection();
    vi.stubGlobal("fetch", fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, status: 401 }]).fetch);

    expect(await statusFor(connection.id)).toBe("revoked");
  });

  it("reports a token this server can no longer decrypt as revoked", async () => {
    const connection = await gitlabConnection();
    await prisma.forgeConnection.update({
      where: { id: connection.id },
      data: { encryptedToken: encryptWithOtherKey("glpat-x") },
    });
    vi.stubGlobal("fetch", fetchStub([]).fetch);

    expect(await statusFor(connection.id)).toBe("revoked");
  });

  it("reports a failing forge as unreachable", async () => {
    const connection = await gitlabConnection();
    vi.stubGlobal("fetch", fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, status: 500 }]).fetch);

    expect(await statusFor(connection.id)).toBe("unreachable");
  });

  const rejectedAt = async (id: string) =>
    (await prisma.forgeConnection.findUniqueOrThrow({ where: { id } })).credentialsRejectedAt;

  it("remembers a refused token, and clears it once the forge accepts it again", async () => {
    const connection = await gitlabConnection();
    vi.stubGlobal("fetch", fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, status: 401 }]).fetch);
    await statusFor(connection.id);
    const flagged = await rejectedAt(connection.id);
    expect(flagged).toBeInstanceOf(Date);

    // A second refusal keeps the first time it was seen.
    await statusFor(connection.id);
    expect(await rejectedAt(connection.id)).toEqual(flagged);

    // An unreachable forge proves nothing either way.
    vi.stubGlobal("fetch", fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, status: 500 }]).fetch);
    await statusFor(connection.id);
    expect(await rejectedAt(connection.id)).toEqual(flagged);

    vi.stubGlobal("fetch", fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, body: { username: "me" } }]).fetch);
    expect(await statusFor(connection.id)).toBe("active");
    expect(await rejectedAt(connection.id)).toBeNull();
  });

  it("treats a rate-limited check as unreachable and does not flag the connection", async () => {
    const connection = await gitlabConnection();
    vi.stubGlobal(
      "fetch",
      fetchStub([{ url: /gitlab\.com\/api\/v4\/user$/, status: 403, headers: { "x-ratelimit-remaining": "0" } }]).fetch,
    );

    expect(await statusFor(connection.id)).toBe("unreachable");
    expect(await rejectedAt(connection.id)).toBeNull();
  });

  it("never flags a GitHub App connection, which an uninstall detaches instead", async () => {
    const connection = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", installationId: "55", accountLogin: "acme" },
    });
    vi.stubGlobal("fetch", fetchStub([{ url: /api\.github\.com\/app\/installations\/55$/, status: 404 }]).fetch);

    expect(await statusFor(connection.id)).toBe("revoked");
    expect(await rejectedAt(connection.id)).toBeNull();
  });

  it("reports an uninstalled GitHub App as revoked", async () => {
    const connection = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", installationId: "55", accountLogin: "acme" },
    });
    vi.stubGlobal("fetch", fetchStub([{ url: /api\.github\.com\/app\/installations\/55$/, status: 404 }]).fetch);

    expect(await statusFor(connection.id)).toBe("revoked");
  });

  it("reports an app connection detached by the uninstall webhook as revoked", async () => {
    const connection = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", accountLogin: "acme" },
    });
    vi.stubGlobal("fetch", fetchStub([]).fetch);

    expect(await statusFor(connection.id)).toBe("revoked");
  });

  it("404s on someone else's connection and requires authentication", async () => {
    const other = await createUser("other@example.com");
    const theirs = await gitlabConnection(other.workspace.id);

    expect((await request(app).get(`/api/connections/${theirs.id}/status`).set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).get(`/api/connections/${theirs.id}/status`)).status).toBe(401);
  });
});

describe("GET /api/connections/:id", () => {
  it("returns the connection with its enabled repositories and recent reviews", async () => {
    const connection = await prisma.forgeConnection.create({
      data: {
        workspaceId,
        provider: "gitlab",
        host: "gitlab.com",
        kind: "token",
        accountLogin: "me",
        encryptedToken: encrypt("glpat-x"),
      },
    });
    const repo = (fullPath: string, extra = {}) =>
      prisma.repository.create({
        data: {
          connectionId: connection.id,
          provider: "gitlab",
          host: "gitlab.com",
          fullPath,
          externalId: fullPath,
          defaultBranch: "main",
          ...extra,
        },
      });
    const hooked = await repo("acme/api", { enabled: true, webhookId: "9" });
    await repo("acme/web", { enabled: true });
    await repo("acme/old");
    for (let number = 1; number <= 6; number++) {
      await prisma.reviewJob.create({
        data: {
          repositoryId: hooked.id,
          number,
          headSha: "h",
          trigger: "manual",
          createdAt: new Date(Date.UTC(2026, 0, number)),
        },
      });
    }

    const res = await request(app).get(`/api/connections/${connection.id}`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ id: connection.id, accountLogin: "me", installationId: null });
    expect(res.body.connection.encryptedToken).toBeUndefined();
    expect(res.body.repositories).toEqual([
      {
        id: hooked.id,
        fullPath: "acme/api",
        defaultBranch: "main",
        webUrl: "https://gitlab.com/acme/api",
        webhook: { active: true },
      },
      expect.objectContaining({ fullPath: "acme/web", webhook: { active: false } }),
    ]);
    expect(res.body.repositories[0].webhookId).toBeUndefined();
    expect(res.body.reviews.total).toBe(6);
    expect(res.body.reviews.recent.map((review: { number: number }) => review.number)).toEqual([6, 5, 4, 3, 2]);
    expect(res.body.reviews.recent[0].repository).toEqual({ fullPath: "acme/api", provider: "gitlab" });
  });

  it("404s on someone else's connection and requires authentication", async () => {
    const other = await createUser("other@example.com");
    const theirs = await prisma.forgeConnection.create({
      data: { workspaceId: other.workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "them" },
    });

    expect((await request(app).get(`/api/connections/${theirs.id}`).set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).get(`/api/connections/${theirs.id}`)).status).toBe(401);
  });
});

describe("a GitHub App connection detached by an uninstall", () => {
  it("409s with a reinstall hint instead of failing on the forge routes", async () => {
    const connection = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", accountLogin: "acme" },
    });
    const repo = await prisma.repository.create({
      data: {
        connectionId: connection.id,
        provider: "github",
        host: "github.com",
        fullPath: "acme/web",
        externalId: "900",
        defaultBranch: "main",
        enabled: true,
      },
    });
    vi.stubGlobal("fetch", fetchStub([]).fetch);

    const responses = [
      await request(app).get(`/api/repos/available?connectionId=${connection.id}`).set("Cookie", cookie),
      await request(app).get(`/api/repos/${repo.id}/changes`).set("Cookie", cookie),
      await request(app).post("/api/reviews").set("Cookie", cookie).send({ repoId: repo.id, number: 7 }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/no longer installed/);
    }
  });
});

describe("DELETE /api/connections/:id", () => {
  it("deletes the caller's connection and 404s on someone else's", async () => {
    const other = await createUser("other@example.com");
    const mine = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "me" },
    });
    const theirs = await prisma.forgeConnection.create({
      data: { workspaceId: other.workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "them" },
    });

    expect((await request(app).delete(`/api/connections/${theirs.id}`).set("Cookie", cookie)).status).toBe(404);
    expect((await request(app).delete(`/api/connections/${mine.id}`).set("Cookie", cookie)).status).toBe(204);
    expect(await prisma.forgeConnection.count()).toBe(1);
  });
});

describe("GitHub App installation", () => {
  const state = (sub: string, purpose = "github-install", stateWorkspace = workspaceId) =>
    jwt.sign({ sub, purpose, workspaceId: stateWorkspace }, env.JWT_SECRET, { expiresIn: "10m" });

  // `visible` is what /installation/repositories returns once the connection
  // is saved and its repositories are reconciled.
  const githubRoutes = (installationIds: number[], { login = "acme", visible = [] as number[] } = {}) => [
    { method: "POST", url: /github\.com\/login\/oauth\/access_token$/, body: { access_token: "user-tok" } },
    { url: /api\.github\.com\/user\/installations/, body: { installations: installationIds.map((id) => ({ id })) } },
    { url: /api\.github\.com\/app\/installations\/55$/, body: { id: 55, account: { id: 1, login } } },
    {
      method: "POST",
      url: /\/app\/installations\/55\/access_tokens$/,
      body: { token: "inst", expires_at: new Date(Date.now() + 3600_000).toISOString() },
    },
    {
      url: /api\.github\.com\/installation\/repositories/,
      body: {
        repositories: visible.map((id) => ({
          id,
          full_name: `acme/r${id}`,
          default_branch: "main",
          private: false,
          html_url: `https://github.com/acme/r${id}`,
        })),
      },
    },
  ];

  const callback = () =>
    request(app)
      .get(`/api/connections/github/callback?installation_id=55&setup_action=install&code=c&state=${state(userId)}`)
      .set("Cookie", cookie);

  const githubAppRepo = (connectionId: string, externalId: string, data: { enabled: boolean; accessLostAt?: Date }) =>
    prisma.repository.create({
      data: {
        connectionId,
        provider: "github",
        host: "github.com",
        fullPath: `acme/r${externalId}`,
        externalId,
        defaultBranch: "main",
        ...data,
      },
    });

  it("redirects to the app's install page with a signed state", async () => {
    const res = await request(app).get("/api/connections/github/install").set("Cookie", cookie);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location!);
    expect(location.origin + location.pathname).toBe("https://github.com/apps/sentryward-test/installations/new");
    expect(jwt.verify(location.searchParams.get("state")!, env.JWT_SECRET)).toMatchObject({ sub: userId, workspaceId });
  });

  it("saves the installation when the OAuth user can access it", async () => {
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    const res = await request(app)
      .get(`/api/connections/github/callback?installation_id=55&setup_action=install&code=c&state=${state(userId)}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/repositories?tab=installation&connected=github`);
    expect(await prisma.forgeConnection.findFirst({ where: { workspaceId } })).toMatchObject({
      provider: "github",
      kind: "github_app",
      installationId: "55",
      accountLogin: "acme",
    });
  });

  it("reattaches the connection an uninstall detached, with its repositories", async () => {
    const detached = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", accountLogin: "acme" },
    });
    await prisma.repository.create({
      data: {
        connectionId: detached.id,
        provider: "github",
        host: "github.com",
        fullPath: "acme/web",
        externalId: "900",
        defaultBranch: "main",
        enabled: true,
      },
    });
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55], { visible: [900] })).fetch);

    await request(app)
      .get(`/api/connections/github/callback?installation_id=55&setup_action=install&code=c&state=${state(userId)}`)
      .set("Cookie", cookie);

    expect(await prisma.forgeConnection.findMany({ select: { id: true, installationId: true } })).toEqual([
      { id: detached.id, installationId: "55" },
    ]);
    expect(await prisma.repository.count({ where: { connectionId: detached.id } })).toBe(1);
  });

  it("records the account id so a later reinstall can find the connection", async () => {
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    await callback();

    expect(await prisma.forgeConnection.findFirstOrThrow()).toMatchObject({ accountId: "1", installationId: "55" });
  });

  it("replaces a stale installation of the same account even if the uninstall webhook never arrived", async () => {
    const stale = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", installationId: "44", accountLogin: "acme" },
    });
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    await callback();

    expect(await prisma.forgeConnection.findMany({ select: { id: true, installationId: true, accountId: true } })).toEqual([
      { id: stale.id, installationId: "55", accountId: "1" },
    ]);
  });

  it("reattaches by account id after the account was renamed", async () => {
    const detached = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", accountLogin: "acme", accountId: "1" },
    });
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55], { login: "acme-inc" })).fetch);

    await callback();

    expect(await prisma.forgeConnection.findMany({ select: { id: true, installationId: true, accountLogin: true } })).toEqual([
      { id: detached.id, installationId: "55", accountLogin: "acme-inc" },
    ]);
  });

  it("brings back only the repositories the app lost access to and can reach again", async () => {
    const detached = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", accountLogin: "acme", accountId: "1" },
    });
    const regained = await githubAppRepo(detached.id, "900", { enabled: false, accessLostAt: new Date() });
    const stillLost = await githubAppRepo(detached.id, "901", { enabled: false, accessLostAt: new Date() });
    const userDisabled = await githubAppRepo(detached.id, "902", { enabled: false });
    const unreachable = await githubAppRepo(detached.id, "903", { enabled: true });
    const inFlight = await prisma.reviewJob.create({
      data: { repositoryId: unreachable.id, number: 1, headSha: "h1", trigger: "webhook", status: "running" },
    });
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55], { visible: [900, 902] })).fetch);

    await callback();

    const repos = await prisma.repository.findMany({ select: { id: true, enabled: true, accessLostAt: true } });
    const byId = new Map(repos.map((repo) => [repo.id, repo]));
    expect(byId.get(regained.id)).toMatchObject({ enabled: true, accessLostAt: null });
    expect(byId.get(stillLost.id)).toMatchObject({ enabled: false, accessLostAt: expect.any(Date) });
    expect(byId.get(userDisabled.id)).toMatchObject({ enabled: false, accessLostAt: null });
    expect(byId.get(unreachable.id)).toMatchObject({ enabled: false, accessLostAt: expect.any(Date) });
    expect(await prisma.reviewJob.findUniqueOrThrow({ where: { id: inFlight.id } })).toMatchObject({
      status: "cancelled",
      error: "Sentryward lost access to this repository",
    });
  });

  it("refuses the callback when the user is no longer an admin of the workspace in the state", async () => {
    const team = await createTeam(userId, "Acme");
    await prisma.membership.updateMany({ where: { workspaceId: team.id }, data: { role: "member" } });
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    const res = await request(app)
      .get(`/api/connections/github/callback?installation_id=55&code=c&state=${state(userId, "github-install", team.id)}`)
      .set("Cookie", cookie);

    expect(res.headers.location).toContain("error=github_install_failed");
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("stores the installation in the workspace it was started for", async () => {
    const team = await createTeam(userId, "Acme");
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    await request(app)
      .get(`/api/connections/github/callback?installation_id=55&code=c&state=${state(userId, "github-install", team.id)}`)
      .set("Cookie", cookie);

    expect(await prisma.forgeConnection.findFirstOrThrow()).toMatchObject({ workspaceId: team.id, createdById: userId });
  });

  it("refuses an installation the OAuth user cannot see", async () => {
    vi.stubGlobal("fetch", fetchStub(githubRoutes([1, 2])).fetch);

    const res = await request(app)
      .get(`/api/connections/github/callback?installation_id=55&code=c&state=${state(userId)}`)
      .set("Cookie", cookie);

    expect(res.headers.location).toContain("error=github_install_forbidden");
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("refuses a state issued to another user", async () => {
    const other = await createUser("other@example.com");
    vi.stubGlobal("fetch", fetchStub(githubRoutes([55])).fetch);

    const res = await request(app)
      .get(`/api/connections/github/callback?installation_id=55&code=c&state=${state(other.user.id)}`)
      .set("Cookie", cookie);

    expect(res.headers.location).toContain("error=github_install_failed");
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("reports an installation awaiting org approval", async () => {
    const res = await request(app)
      .get(`/api/connections/github/callback?setup_action=request&state=${state(userId)}`)
      .set("Cookie", cookie);

    expect(res.headers.location).toContain("error=github_pending_approval");
  });
});

describe("GitLab OAuth", () => {
  const TOKEN_URL = /gitlab\.acme\.com\/oauth\/token$/;
  const tokenRoute = (access = "oauth-access", refresh = "oauth-refresh") => ({
    method: "POST",
    url: TOKEN_URL,
    body: { access_token: access, refresh_token: refresh, expires_in: 7200, token_type: "Bearer" },
  });
  const userRoute = { url: /gitlab\.acme\.com\/api\/v4\/user$/, body: { username: "dev" } };

  const start = async (query = "") => {
    const res = await request(app).get(`/api/connections/gitlab/oauth/start${query}`).set("Cookie", cookie);
    return { res, state: res.status === 302 ? new URL(res.headers.location!).searchParams.get("state")! : "" };
  };
  const callback = (query: string, as = cookie) =>
    request(app).get(`/api/connections/gitlab/oauth/callback?${query}`).set("Cookie", as);

  const oauthConnection = (expiresAt: Date | null, refresh = "old-refresh") =>
    prisma.forgeConnection.create({
      data: {
        workspaceId,
        provider: "gitlab",
        host: "gitlab.acme.com",
        kind: "oauth",
        accountLogin: "dev",
        encryptedToken: encrypt("old-access"),
        encryptedRefreshToken: encrypt(refresh),
        tokenExpiresAt: expiresAt,
      },
    });

  describe("start", () => {
    it("redirects to the instance's authorize page with a single-use state and PKCE", async () => {
      const { res, state } = await start();

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location!);
      expect(location.origin + location.pathname).toBe("https://gitlab.acme.com/oauth/authorize");
      expect(Object.fromEntries(location.searchParams)).toMatchObject({
        client_id: "gitlab-client-id",
        redirect_uri: `${env.CLIENT_ORIGIN}/api/connections/gitlab/oauth/callback`,
        response_type: "code",
        scope: "api",
        code_challenge_method: "S256",
      });
      expect(location.searchParams.get("code_challenge")).toBeTruthy();
      expect(await prisma.oAuthState.findUniqueOrThrow({ where: { id: state } })).toMatchObject({
        userId,
        workspaceId,
        host: "gitlab.acme.com",
      });
    });

    it("refuses workspace members who are not admins", async () => {
      const other = await createUser("owner@example.com");
      const team = await createTeam(other.user.id, "Acme");
      await addMember(team.id, userId, "member");

      const { res } = await start(`?workspace=${team.id}`);

      expect(res.status).toBe(403);
      expect(await prisma.oAuthState.count()).toBe(0);
    });

    it("503s when no OAuth app is configured", async () => {
      const clientId = env.GITLAB_OAUTH_CLIENT_ID;
      env.GITLAB_OAUTH_CLIENT_ID = undefined;
      try {
        expect((await start()).res.status).toBe(503);
      } finally {
        env.GITLAB_OAUTH_CLIENT_ID = clientId;
      }
    });
  });

  describe("callback", () => {
    it("exchanges the code and stores an OAuth connection with encrypted tokens", async () => {
      const { state } = await start();
      const { fetch, calls } = fetchStub([tokenRoute(), userRoute]);
      vi.stubGlobal("fetch", fetch);

      const res = await callback(`code=abc&state=${state}`);

      expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/repositories?tab=installation&connected=gitlab`);
      const exchange = new URLSearchParams(calls[0]!.body);
      expect(Object.fromEntries(exchange)).toMatchObject({
        grant_type: "authorization_code",
        code: "abc",
        client_secret: "gitlab-client-secret",
      });
      expect(exchange.get("code_verifier")).toBeTruthy();
      expect(calls[1]!.headers.authorization).toBe("Bearer oauth-access");

      const stored = await prisma.forgeConnection.findFirstOrThrow({ where: { workspaceId } });
      expect(stored).toMatchObject({ provider: "gitlab", kind: "oauth", host: "gitlab.acme.com", accountLogin: "dev" });
      expect(stored.encryptedToken).not.toContain("oauth-access");
      expect(decrypt(stored.encryptedToken!)).toBe("oauth-access");
      expect(decrypt(stored.encryptedRefreshToken!)).toBe("oauth-refresh");
      expect(stored.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7000 * 1000);
    });

    it("updates the same connection when the account connects again", async () => {
      vi.stubGlobal("fetch", fetchStub([tokenRoute("second"), userRoute]).fetch);
      await oauthConnection(new Date());

      await callback(`code=abc&state=${(await start()).state}`);

      const stored = await prisma.forgeConnection.findMany({ where: { workspaceId } });
      expect(stored).toHaveLength(1);
      expect(decrypt(stored[0]!.encryptedToken!)).toBe("second");
    });

    it("clears a refused-credentials flag when the account signs in again", async () => {
      vi.stubGlobal("fetch", fetchStub([tokenRoute("second"), userRoute]).fetch);
      const connection = await oauthConnection(new Date());
      await prisma.forgeConnection.update({ where: { id: connection.id }, data: { credentialsRejectedAt: new Date() } });

      await callback(`code=abc&state=${(await start()).state}`);

      expect((await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connection.id } })).credentialsRejectedAt).toBeNull();
    });

    it("rejects a missing, unknown or reused state", async () => {
      vi.stubGlobal("fetch", fetchStub([tokenRoute(), userRoute]).fetch);
      const { state } = await start();

      expect((await callback("code=abc")).headers.location).toContain("error=gitlab_oauth_failed");
      expect((await callback("code=abc&state=forged")).headers.location).toContain("error=gitlab_oauth_failed");
      expect((await callback(`code=abc&state=${state}`)).headers.location).toContain("connected=gitlab");
      expect((await callback(`code=abc&state=${state}`)).headers.location).toContain("error=gitlab_oauth_failed");
      expect(await prisma.forgeConnection.count()).toBe(1);
    });

    it("rejects an expired state and one issued to another user", async () => {
      vi.stubGlobal("fetch", fetchStub([tokenRoute(), userRoute]).fetch);
      const expired = await start();
      await prisma.oAuthState.update({ where: { id: expired.state }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const theirs = await start();
      const other = await createUser("other@example.com");

      expect((await callback(`code=abc&state=${expired.state}`)).headers.location).toContain("error=gitlab_oauth_failed");
      expect((await callback(`code=abc&state=${theirs.state}`, other.cookie)).headers.location).toContain(
        "error=gitlab_oauth_failed",
      );
      expect(await prisma.forgeConnection.count()).toBe(0);
    });

    it("reports a cancelled authorization and uses up the state", async () => {
      const { state } = await start();
      vi.stubGlobal("fetch", fetchStub([]).fetch);

      const res = await callback(`error=access_denied&state=${state}`);

      expect(res.headers.location).toContain("error=gitlab_oauth_denied");
      expect(await prisma.oAuthState.count()).toBe(0);
    });

    it("refuses a code GitLab will not exchange", async () => {
      const { state } = await start();
      vi.stubGlobal("fetch", fetchStub([{ method: "POST", url: TOKEN_URL, status: 400, body: { error: "invalid_grant" } }]).fetch);

      expect((await callback(`code=abc&state=${state}`)).headers.location).toContain("error=gitlab_oauth_failed");
      expect(await prisma.forgeConnection.count()).toBe(0);
    });
  });

  describe("access token refresh", () => {
    it("uses the stored token while it is fresh", async () => {
      const connection = await oauthConnection(new Date(Date.now() + 60 * 60 * 1000));
      const { fetch, calls } = fetchStub([]);
      vi.stubGlobal("fetch", fetch);

      expect(await gitlabAccessToken(connection.id)).toBe("old-access");
      expect(calls).toHaveLength(0);
    });

    it("refreshes an expiring token before a forge call and stores the rotated tokens", async () => {
      const connection = await oauthConnection(new Date(Date.now() + 30 * 1000));
      const { fetch, calls } = fetchStub([tokenRoute("new-access", "new-refresh"), userRoute]);
      vi.stubGlobal("fetch", fetch);

      const status = await request(app).get(`/api/connections/${connection.id}/status`).set("Cookie", cookie);

      expect(status.body.status).toBe("active");
      expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
      });
      expect(calls[1]!.headers.authorization).toBe("Bearer new-access");
      const stored = await prisma.forgeConnection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(decrypt(stored.encryptedToken!)).toBe("new-access");
      expect(decrypt(stored.encryptedRefreshToken!)).toBe("new-refresh");
      expect(stored.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
    });

    it("refreshes once when two callers find the token expired at the same time", async () => {
      const connection = await oauthConnection(new Date(Date.now() - 1000));
      const { fetch, calls } = fetchStub([tokenRoute("new-access", "new-refresh")]);
      vi.stubGlobal("fetch", fetch);

      const tokens = await Promise.all([gitlabAccessToken(connection.id), gitlabAccessToken(connection.id)]);

      expect(tokens).toEqual(["new-access", "new-access"]);
      expect(calls.filter((call) => TOKEN_URL.test(call.url))).toHaveLength(1);
    });

    it("asks to reconnect when GitLab refuses the refresh", async () => {
      const connection = await oauthConnection(new Date(Date.now() - 1000));
      vi.stubGlobal(
        "fetch",
        fetchStub([{ method: "POST", url: TOKEN_URL, status: 400, body: { error: "invalid_grant" } }]).fetch,
      );

      await expect(gitlabAccessToken(connection.id)).rejects.toBeInstanceOf(ReconnectRequiredError);
      const status = await request(app).get(`/api/connections/${connection.id}/status`).set("Cookie", cookie);
      expect(status.body.status).toBe("revoked");
    });

    it("reports a GitLab outage during refresh as unreachable, not revoked", async () => {
      const connection = await oauthConnection(new Date(Date.now() - 1000));
      vi.stubGlobal("fetch", fetchStub([{ method: "POST", url: TOKEN_URL, status: 503 }]).fetch);

      const status = await request(app).get(`/api/connections/${connection.id}/status`).set("Cookie", cookie);
      expect(status.body.status).toBe("unreachable");
    });
  });
});
