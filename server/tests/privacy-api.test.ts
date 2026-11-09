import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";
import { addMember, createTeam, createUser, inWorkspace } from "./helpers/users.ts";

let admin: Awaited<ReturnType<typeof createUser>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;
let teamId: string;

const OPEN = { allowedProviders: [], allowedHosts: [], localOnly: false, retentionDays: null };

beforeEach(async () => {
  await prisma.llmRequestLog.deleteMany();
  await prisma.instanceSettings.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  admin = await createUser("admin@example.com", "admin");
  owner = await createUser("owner@example.com");
  member = await createUser("member@example.com");
  const team = await createTeam(owner.user.id, "Acme");
  teamId = team.id;
  await addMember(teamId, member.user.id, "member");
});

afterAll(async () => {
  await prisma.instanceSettings.deleteMany();
  await prisma.$disconnect();
});

async function logEntry(workspaceId: string | null, overrides: Record<string, unknown> = {}) {
  return prisma.llmRequestLog.create({
    data: {
      workspaceId,
      workspaceName: "Acme",
      repository: "github.com/acme/web",
      changeNumber: 7,
      purpose: "review",
      provider: "anthropic",
      host: "api.anthropic.com",
      model: "anthropic/claude-sonnet-4-5",
      inputTokens: 1200,
      outputTokens: 300,
      outcome: "ok",
      ...overrides,
    },
  });
}

describe("instance settings", () => {
  it.each([
    ["get", "/api/admin/settings"],
    ["put", "/api/admin/settings"],
    ["get", "/api/admin/audit-log"],
    ["get", "/api/admin/audit-log/export"],
  ] as const)("%s %s is admin-only", async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
    expect((await request(app)[method](path).set("Cookie", member.cookie)).status).toBe(403);
    expect((await request(app)[method](path).set("Cookie", admin.cookie)).status).not.toBe(403);
  });

  it("starts open and stores what an admin saves", async () => {
    const empty = await request(app).get("/api/admin/settings").set("Cookie", admin.cookie);
    expect(empty.body.settings).toEqual({ ...OPEN, auditRetentionDays: null, allowDirectMemberAdd: false });
    expect(empty.body.env).toHaveProperty("reviewRetentionDays");

    const res = await request(app)
      .put("/api/admin/settings")
      .set("Cookie", admin.cookie)
      .send({
        allowedProviders: ["ollama", "anthropic", "ollama"],
        allowedHosts: ["https://Ollama.LAN:11434/v1", "*.example.com"],
        localOnly: true,
        retentionDays: 90,
        auditRetentionDays: 365,
      });

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      allowedProviders: ["ollama", "anthropic"],
      allowedHosts: ["ollama.lan:11434", "*.example.com"],
      localOnly: true,
      retentionDays: 90,
      auditRetentionDays: 365,
      allowDirectMemberAdd: false,
    });
  });

  it("stores the consent setting and preserves it when older clients omit it", async () => {
    const settings = { ...OPEN, auditRetentionDays: null };
    const enabled = await request(app).put("/api/admin/settings").set("Cookie", admin.cookie)
      .send({ ...settings, allowDirectMemberAdd: true });
    expect(enabled.body.settings.allowDirectMemberAdd).toBe(true);
    const older = await request(app).put("/api/admin/settings").set("Cookie", admin.cookie).send(settings);
    expect(older.body.settings.allowDirectMemberAdd).toBe(true);
    const disabled = await request(app).put("/api/admin/settings").set("Cookie", admin.cookie)
      .send({ ...settings, allowDirectMemberAdd: false });
    expect(disabled.body.settings.allowDirectMemberAdd).toBe(false);
    expect((await request(app).put("/api/admin/settings").set("Cookie", admin.cookie)
      .send({ ...settings, allowDirectMemberAdd: "true" })).status).toBe(400);
  });

  it("rejects invalid hosts and retention", async () => {
    const res = await request(app)
      .put("/api/admin/settings")
      .set("Cookie", admin.cookie)
      .send({ ...OPEN, allowedHosts: ["not a host"], retentionDays: 0, auditRetentionDays: null });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.errors)).toEqual(expect.arrayContaining(["allowedHosts", "retentionDays"]));
  });
});

describe("workspace privacy", () => {
  it("lets members read the policy and only admins change it", async () => {
    const read = await request(app).get("/api/privacy").set("Cookie", member.cookie).set(...inWorkspace(teamId));
    expect(read.status).toBe(200);
    expect(read.body.workspace).toEqual(OPEN);

    const write = await request(app)
      .put("/api/privacy")
      .set("Cookie", member.cookie)
      .set(...inWorkspace(teamId))
      .send(OPEN);
    expect(write.status).toBe(403);
  });

  it("saves a narrower policy and reports the effective one", async () => {
    await prisma.instanceSettings.create({ data: { id: 1, retentionDays: 90 } });

    const res = await request(app)
      .put("/api/privacy")
      .set("Cookie", owner.cookie)
      .set(...inWorkspace(teamId))
      .send({ allowedProviders: ["ollama"], allowedHosts: ["ollama"], localOnly: true, retentionDays: 30 });

    expect(res.status).toBe(200);
    expect(res.body.workspace).toEqual({ allowedProviders: ["ollama"], allowedHosts: ["ollama"], localOnly: true, retentionDays: 30 });
    expect(res.body.instance.retentionDays).toBe(90);
    expect(res.body.effective).toEqual({ localOnly: true, retentionDays: 30 });
  });

  it("refuses values wider than the instance allows", async () => {
    await prisma.instanceSettings.create({
      data: { id: 1, allowedProviders: ["ollama", "openai"], allowedHosts: ["*.lan"], retentionDays: 30 },
    });

    const res = await request(app)
      .put("/api/privacy")
      .set("Cookie", owner.cookie)
      .set(...inWorkspace(teamId))
      .send({ allowedProviders: ["anthropic"], allowedHosts: ["llm.example.com"], localOnly: false, retentionDays: 60 });

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual({
      allowedProviders: ["Not allowed on this instance: anthropic"],
      allowedHosts: ["Not allowed on this instance: llm.example.com"],
      retentionDays: ["Must be at most 30 days (the instance limit)"],
    });
    expect(await prisma.workspacePrivacy.count()).toBe(0);
  });

  it("names a one-day instance limit in the singular", async () => {
    await prisma.instanceSettings.create({ data: { id: 1, retentionDays: 1 } });

    const res = await request(app)
      .put("/api/privacy")
      .set("Cookie", owner.cookie)
      .set(...inWorkspace(teamId))
      .send({ ...OPEN, retentionDays: 5 });

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual({ retentionDays: ["Must be at most 1 day (the instance limit)"] });
  });

  it("works in a personal workspace", async () => {
    const res = await request(app)
      .put("/api/privacy")
      .set("Cookie", member.cookie)
      .send({ ...OPEN, localOnly: true });

    expect(res.status).toBe(200);
    expect(await prisma.workspacePrivacy.findUnique({ where: { workspaceId: member.workspace.id } })).toMatchObject({
      localOnly: true,
    });
  });
});

describe("audit log", () => {
  it("is for workspace admins and scoped to their workspace", async () => {
    await logEntry(teamId);
    await logEntry(owner.workspace.id, { workspaceName: "Dev" });

    const denied = await request(app).get("/api/privacy/audit-log").set("Cookie", member.cookie).set(...inWorkspace(teamId));
    expect(denied.status).toBe(403);

    const res = await request(app).get("/api/privacy/audit-log").set("Cookie", owner.cookie).set(...inWorkspace(teamId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, limit: 25 });
    expect(res.body.entries[0]).toMatchObject({
      workspaceName: "Acme",
      repository: "github.com/acme/web",
      provider: "anthropic",
      host: "api.anthropic.com",
      model: "anthropic/claude-sonnet-4-5",
      inputTokens: 1200,
      outputTokens: 300,
      outcome: "ok",
    });
  });

  it("lists every workspace for instance admins, newest first, with filters and paging", async () => {
    await logEntry(teamId, { createdAt: new Date("2026-01-01T00:00:00Z") });
    await logEntry(owner.workspace.id, {
      workspaceName: "Dev",
      provider: "ollama",
      host: "ollama:11434",
      model: "ollama/llama3",
      outcome: "failed",
      errorKind: "http_500",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    const all = await request(app).get("/api/admin/audit-log").set("Cookie", admin.cookie);
    expect(all.body.total).toBe(2);
    expect(all.body.entries.map((e: { workspaceName: string }) => e.workspaceName)).toEqual(["Dev", "Acme"]);

    const failed = await request(app).get("/api/admin/audit-log?outcome=failed").set("Cookie", admin.cookie);
    expect(failed.body.entries).toHaveLength(1);
    expect(failed.body.entries[0].errorKind).toBe("http_500");

    const one = await request(app).get(`/api/admin/audit-log?workspaceId=${teamId}`).set("Cookie", admin.cookie);
    expect(one.body.total).toBe(1);

    const searched = await request(app).get("/api/admin/audit-log?q=llama").set("Cookie", admin.cookie);
    expect(searched.body.total).toBe(1);

    const paged = await request(app).get("/api/admin/audit-log?limit=1&page=2").set("Cookie", admin.cookie);
    expect(paged.body.entries[0].workspaceName).toBe("Acme");
  });

  it("keeps entries when their workspace is deleted", async () => {
    await logEntry(teamId);
    await prisma.workspace.delete({ where: { id: teamId } });

    const res = await request(app).get("/api/admin/audit-log").set("Cookie", admin.cookie);
    expect(res.body.entries[0]).toMatchObject({ workspaceId: null, workspaceName: "Acme" });
  });

  it("exports CSV with escaped, formula-safe cells", async () => {
    await logEntry(teamId, { repository: "=cmd|calc", host: "a,b" });

    const res = await request(app).get("/api/privacy/audit-log/export").set("Cookie", owner.cookie).set(...inWorkspace(teamId));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="sentryward-audit-\d{4}-\d{2}-\d{2}\.csv"/);
    const [header, row] = res.text.trim().split("\r\n");
    expect(header).toBe(
      "time,workspace,repository,change,job_id,reply_id,user_id,purpose,provider,host,model," +
        "input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,latency_ms,outcome,error_kind",
    );
    expect(row).toContain(",'=cmd|calc,7,");
    expect(row).toContain(',"a,b",');
  });

  it("exports JSON", async () => {
    await logEntry(teamId);
    await logEntry(teamId, { model: "anthropic/claude-haiku-4-5" });

    const res = await request(app).get("/api/admin/audit-log/export?format=json").set("Cookie", admin.cookie);

    expect(res.headers["content-type"]).toContain("application/json");
    const rows = JSON.parse(res.text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveProperty("host", "api.anthropic.com");
  });
});
