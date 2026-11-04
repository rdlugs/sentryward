import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import { prisma } from "../src/lib/prisma.ts";
import { AUTH_COOKIE } from "../src/lib/jwt.ts";
import { createInvite } from "../src/services/invites.ts";
import { createUser } from "./helpers/users.ts";
import { verifyPassword } from "../src/lib/password.ts";

// Wrap the real hashing in a spy so a test can assert that login always pays the
// argon2 cost, even for an email with no account (see #208).
vi.mock("../src/lib/password.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/password.ts")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const validUser = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  password: "supersecret123",
  confirmPassword: "supersecret123",
};

function authCookie(res: request.Response) {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  return cookies.find((c) => c.startsWith(`${AUTH_COOKIE}=`));
}

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/auth/register", () => {
  it("creates a user, sets an httpOnly cookie and never returns the hash", async () => {
    const res = await request(app).post("/api/auth/register").send(validUser);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: validUser.name, email: validUser.email });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(authCookie(res)).toMatch(/HttpOnly/i);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: validUser.email } });
    expect(stored.passwordHash).not.toBe(validUser.password);
  });

  it("rejects a duplicate email case-insensitively", async () => {
    await request(app).post("/api/auth/register").send(validUser);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, email: "ADA@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.errors).toEqual({ email: ["An account with this email already exists"] });
  });

  it("returns 409 when a concurrent registration claims the same email", async () => {
    const [a, b] = await Promise.all([
      request(app).post("/api/auth/register").send(validUser),
      request(app).post("/api/auth/register").send(validUser),
    ]);

    // Both requests pass the up-front email check, so exactly one wins the
    // unique index; the loser must be a 409, not a 500.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(a.body.user?.email ?? b.body.user?.email).toBe(validUser.email);
    // Same field error as the up-front check, so the form shows it on the email field.
    const loser = a.status === 409 ? a : b;
    expect(loser.body.errors).toEqual({ email: ["An account with this email already exists"] });
  });

  it("returns field errors for invalid input", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "", email: "nope", password: "short", confirmPassword: "different" });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.errors)).toEqual(
      expect.arrayContaining(["name", "email", "password"]),
    );
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await request(app).post("/api/auth/register").send(validUser);
  });

  it("logs in with correct credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: validUser.email, password: validUser.password });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(validUser.email);
    expect(authCookie(res)).toBeDefined();
  });

  it("rejects a wrong password with a generic message", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: validUser.email, password: "wrongpassword" });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password");
  });

  it("rejects an unknown email with the same generic message", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "whatever123" });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password");
  });

  it("still hashes a password when the email has no account", async () => {
    vi.mocked(verifyPassword).mockClear();

    await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "whatever123" });

    // Skipping argon2 for an unknown email is a timing oracle for which
    // addresses have accounts.
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/auth/me and POST /api/auth/logout", () => {
  it("returns 401 without a cookie", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns the current user with a valid cookie, and logout clears it", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send(validUser);

    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(validUser.email);

    const logoutRes = await agent.post("/api/auth/logout");
    expect(logoutRes.status).toBe(204);

    const afterLogout = await agent.get("/api/auth/me");
    expect(afterLogout.status).toBe(401);
  });

  it("rejects a tampered token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", `${AUTH_COOKIE}=not.a.valid.token`);
    expect(res.status).toBe(401);
  });
});

describe("registration modes and invites", () => {
  const originalMode = env.REGISTRATION_MODE;

  beforeEach(async () => {
    await prisma.invite.deleteMany();
  });

  afterEach(() => {
    env.REGISTRATION_MODE = originalMode;
  });

  async function inviteToken(email?: string) {
    const { user } = await createUser("admin@example.com", "admin");
    const { link } = await createInvite({ email, invitedById: user.id, inviterName: user.name });
    return link.split("/invite/")[1]!;
  }

  it("makes the first account an admin, even when registration is closed", async () => {
    env.REGISTRATION_MODE = "closed";

    const res = await request(app).post("/api/auth/register").send(validUser);

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("admin");
  });

  it("makes later accounts members in open mode", async () => {
    await createUser("admin@example.com", "admin");

    const res = await request(app).post("/api/auth/register").send(validUser);

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("member");
  });

  it("refuses new accounts when registration is closed", async () => {
    env.REGISTRATION_MODE = "closed";
    await createUser("admin@example.com", "admin");

    const res = await request(app).post("/api/auth/register").send(validUser);

    expect(res.status).toBe(403);
    expect(await prisma.user.count({ where: { email: validUser.email } })).toBe(0);
  });

  it("requires a valid invite in invite mode, and spends it once", async () => {
    env.REGISTRATION_MODE = "invite";
    const token = await inviteToken();

    const without = await request(app).post("/api/auth/register").send(validUser);
    expect(without.status).toBe(403);

    const bogus = await request(app).post("/api/auth/register").send({ ...validUser, inviteToken: "nope" });
    expect(bogus.status).toBe(400);

    const ok = await request(app).post("/api/auth/register").send({ ...validUser, inviteToken: token });
    expect(ok.status).toBe(201);

    const reused = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, email: "grace@example.com", inviteToken: token });
    expect(reused.status).toBe(400);
  });

  it("rejects an invite meant for another email without spending it", async () => {
    env.REGISTRATION_MODE = "invite";
    const token = await inviteToken("grace@example.com");

    const res = await request(app).post("/api/auth/register").send({ ...validUser, inviteToken: token });

    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeDefined();
    expect(await prisma.invite.count({ where: { acceptedAt: null } })).toBe(1);
  });

  it("rejects an expired invite", async () => {
    env.REGISTRATION_MODE = "invite";
    const token = await inviteToken();
    await prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post("/api/auth/register").send({ ...validUser, inviteToken: token });

    expect(res.status).toBe(400);
  });

  it("reports the mode and shows a valid invite", async () => {
    env.REGISTRATION_MODE = "invite";
    const token = await inviteToken("grace@example.com");

    const mode = await request(app).get("/api/auth/registration");
    expect(mode.body).toEqual({ mode: "invite", firstUser: false, mailConfigured: false });

    const shown = await request(app).get(`/api/auth/invites/${token}`);
    expect(shown.status).toBe(200);
    expect(shown.body.invite).toMatchObject({ email: "grace@example.com", invitedBy: { name: "Dev" } });

    const missing = await request(app).get("/api/auth/invites/unknown");
    expect(missing.status).toBe(404);
  });
});
