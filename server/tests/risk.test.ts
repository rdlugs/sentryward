import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { ConfigOverride } from "../src/review/config/schema.ts";
import type { ContextSource } from "../src/review/context/gather.ts";
import { MAX_RISKY_AREAS, diffAreas, floorBlastRadius, riskyAreas, withReach } from "../src/review/context/risk.ts";
import { runReview } from "../src/review/pipeline.ts";
import { walkthroughMarkdown } from "../src/review/render/markdown.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { WALKTHROUGH, fakeModel } from "./helpers/model.ts";

const config = (override: ConfigOverride = {}) => resolveConfig({ trigger: override }).config;
const now = () => new Date("2026-10-04T12:00:00Z");

const ROUTE_PATCH = [
  "@@ -3,3 +3,3 @@",
  " ",
  '-router.get("/users", requireAuth, list);',
  '+router.get("/users", list);',
  "+// requireAuth moved to the gateway",
].join("\n");

const files = () =>
  makeChangeSet([
    { path: "src/routes/users.ts", changeType: "modified", patch: ROUTE_PATCH },
    {
      path: "src/services/jobs.ts",
      changeType: "modified",
      patch: ["@@ -1,2 +1,3 @@", " export async function finish(id) {", "+  await db.reviewJob.update({ where: { id } });", "+  cache.delete(id);"].join("\n"),
    },
    { path: "prisma/schema.prisma", changeType: "modified", patch: "@@ -1,1 +1,2 @@\n model A {\n+  b Int" },
    { path: "src/util/strings.ts", changeType: "modified", patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+map.delete(key);" },
  ]).files;

describe("riskyAreas", () => {
  it("finds removed auth checks, database writes, schema changes and routes in the diff", () => {
    expect(riskyAreas(files())).toEqual([
      { kind: "auth", path: "src/routes/users.ts", reason: "removes an authorization check", removesCheck: true },
      { kind: "api", path: "src/routes/users.ts", reason: "changes an API route" },
      { kind: "database", path: "src/services/jobs.ts", reason: "changes a database write" },
      { kind: "database", path: "prisma/schema.prisma", reason: "changes the database schema" },
    ]);
  });

  it("caps the list it shows but not the diff's own areas", () => {
    const many = makeChangeSet(
      Array.from({ length: 12 }, (_, index) => ({
        path: `src/routes/r${index}.ts`,
        changeType: "modified" as const,
        patch: '@@ -1,1 +1,2 @@\n export {};\n+app.get("/r", list);',
      })),
    ).files;
    expect(riskyAreas(many)).toHaveLength(MAX_RISKY_AREAS);
    expect(diffAreas(many)).toHaveLength(12);
  });

  it("adds handlers and auth modules reached only through callers", () => {
    const reach = [
      { path: "bin/cli.ts", chain: ["main"], hops: 1 },
      { path: "src/routes/serve.ts", chain: ["main", "run"], hops: 2 },
      { path: "src/middleware/auth.ts", chain: ["main"], hops: 1 },
    ];
    expect(riskyAreas([], reach)).toEqual([
      { kind: "api", path: "src/routes/serve.ts", reason: "calls run, 2 hops from the change", via: "main -> run" },
      { kind: "auth", path: "src/middleware/auth.ts", reason: "calls main, directly from the change", via: "main" },
    ]);
  });

  it("leaves out tests, whether changed or reached", () => {
    const changed = makeChangeSet([
      { path: "server/tests/repos.routes.test.ts", changeType: "modified", patch: "@@ -1,1 +1,2 @@\n a\n+await prisma.user.create({ data });" },
    ]).files;
    const reach = [{ path: "server/tests/repos.routes.test.ts", chain: ["format"], hops: 1 }];
    expect(riskyAreas(changed, reach)).toEqual([]);
  });

  it("takes only database clients' create, update and delete for database writes", () => {
    const lines = (...added: string[]) =>
      makeChangeSet([{ path: "src/x.ts", changeType: "modified", patch: ["@@ -1,1 +1,2 @@", " a", ...added.map((line) => `+${line}`)].join("\n") }]).files;
    expect(riskyAreas(lines('el.classList.remove("open");', "this.cache.delete(key);", "req.session.save();"))).toEqual([]);
    expect(riskyAreas(lines("await prisma.user.create({ data });"))).toEqual([
      { kind: "database", path: "src/x.ts", reason: "changes a database write" },
    ]);
    expect(riskyAreas(lines("await this.db.order.update({ where });"))).toHaveLength(1);
  });

  it("only counts an auth check as removed when its name leaves the file's changes", () => {
    const patch = (...lines: string[]) => makeChangeSet([{ path: "src/routes/x.ts", changeType: "modified", patch: ["@@ -1,2 +1,1 @@", ...lines].join("\n") }]).files;
    const merged = patch('-router.get("/a", requireAuth, a);', '-router.get("/b", requireAuth, b);', "+router.use(requireAuth);");
    expect(riskyAreas(merged)[0]).toEqual({ kind: "auth", path: "src/routes/x.ts", reason: "changes authorization code" });
    const swapped = patch('-router.get("/a", requireAuth, a);', '+router.get("/a", a);', "+const admin = isAdmin(user);");
    expect(riskyAreas(swapped)[0]).toMatchObject({ kind: "auth", removesCheck: true });
  });

  it("adds reached areas after the diff's own", () => {
    const diff = [{ kind: "database" as const, path: "src/a.ts", reason: "changes a database write" }];
    expect(withReach(diff, [{ path: "src/routes/r.ts", chain: ["a", "b"], hops: 2 }]).map((area) => area.path)).toEqual([
      "src/a.ts",
      "src/routes/r.ts",
    ]);
  });

  it("only ever raises the blast radius: medium for any area, large for a removed check", () => {
    expect(floorBlastRadius("small", [])).toBe("small");
    expect(floorBlastRadius(undefined, [])).toBeUndefined();
    expect(floorBlastRadius("small", [{ kind: "api", path: "a", reason: "r" }])).toBe("medium");
    expect(floorBlastRadius("small", [{ kind: "database", path: "a", reason: "r" }])).toBe("medium");
    expect(floorBlastRadius("small", [{ kind: "api", path: "a", reason: "r", via: "main" }])).toBe("medium");
    expect(floorBlastRadius("medium", [{ kind: "auth", path: "a", reason: "r", removesCheck: true }])).toBe("large");
    expect(floorBlastRadius("large", [{ kind: "database", path: "a", reason: "r" }])).toBe("large");
  });

  it("does not take a renamed guard or an auth message for a removed check", () => {
    const patch = (...lines: string[]) =>
      makeChangeSet([{ path: "src/server.ts", changeType: "modified", patch: ["@@ -1,1 +1,1 @@", ...lines].join("\n") }]).files;
    const renamed = riskyAreas(patch("-app.use(requireAuth);", "+app.use(requireAuthenticated);"));
    expect(renamed).toEqual([{ kind: "auth", path: "src/server.ts", reason: "changes authorization code" }]);
    expect(riskyAreas(patch('-  throw new HttpError(401, "Authorization required");', '+  throw new HttpError(401, "Sign in first");'))).toEqual([]);
  });

  it("takes route definitions for API routes, not HTTP client calls", () => {
    const line = (text: string) => riskyAreas(makeChangeSet([{ path: "src/x.ts", changeType: "modified", patch: `@@ -1,1 +1,2 @@\n a\n+${text}` }]).files);
    expect(line('const reviews = await api.get("/api/reviews");')).toEqual([]);
    expect(line('await axios.post("/users", body);')).toEqual([]);
    expect(line('const proxy = app.get("trust proxy");')).toEqual([]);
    expect(line('router.post("/users", create);')).toEqual([{ kind: "api", path: "src/x.ts", reason: "changes an API route" }]);
    expect(line('users.get("/users/:id", show);')).toHaveLength(1);
  });
});

describe("risky areas in the walkthrough", () => {
  it("tells the walkthrough, raises its blast radius and renders next to it", async () => {
    const { generate, requests } = fakeModel({ code_review: { findings: [] }, walkthrough: WALKTHROUGH });
    const changeSet = makeChangeSet([{ path: "src/routes/users.ts", changeType: "modified", patch: ROUTE_PATCH }]);

    const result = await runReview({ changeSet, config: config({ review: { fileContext: false } }) }, { generate, now });

    const prompt = requests.find((request) => request.schemaName === "walkthrough")!.prompt;
    expect(prompt).toContain("Sensitive areas the diff touches");
    expect(prompt).toContain("- authorization: src/routes/users.ts removes an authorization check");
    expect(result.walkthrough!.blastRadius).toBe("large");
    expect(result.walkthrough!.riskyAreas).toHaveLength(2);

    const markdown = walkthroughMarkdown(result);
    expect(markdown).toContain("💥 Blast radius: large");
    expect(markdown).toContain("<summary>⚠️ Risky areas (2)</summary>");
    expect(markdown).toContain("| authorization | `src/routes/users.ts` | removes an authorization check |");
    expect(walkthroughMarkdown(result, { blastRadius: false })).not.toContain("Risky areas");

    const { riskyAreas: _areas, ...stored } = result.walkthrough!;
    expect(walkthroughMarkdown({ ...result, walkthrough: stored })).not.toContain("Risky areas");
  });

  it("keeps the areas out of the result when the blast radius is hidden, still raising it", async () => {
    const { generate } = fakeModel({ code_review: { findings: [] }, walkthrough: WALKTHROUGH });
    const changeSet = makeChangeSet([{ path: "src/routes/users.ts", changeType: "modified", patch: ROUTE_PATCH }]);

    const result = await runReview(
      { changeSet, config: config({ review: { fileContext: false }, output: { walkthroughBlastRadius: false } }) },
      { generate, now },
    );

    expect(result.walkthrough!.riskyAreas).toBeUndefined();
    expect(result.walkthrough!.blastRadius).toBe("large");
  });

  it("includes routes the change reaches through traced callers", async () => {
    const { generate } = fakeModel({ code_review: { findings: [] }, walkthrough: WALKTHROUGH });
    const app = ["export function main(input: string) {", "  return input;", "}", ""].join("\n");
    const cli = ["export function runCli(args: string[]) {", "  return main(args[0]);", "}", ""].join("\n");
    const serve = ['router.post("/run", (req, res) => {', "  res.json(runCli(req.body));", "});", ""].join("\n");
    const sources: Record<string, string> = { "src/app.ts": app, "bin/cli.ts": cli, "src/routes/serve.ts": serve };
    const callers: Record<string, string[]> = { main: ["bin/cli.ts"], runCli: ["src/routes/serve.ts"] };
    const context: ContextSource = {
      readFile: async (path) => sources[path] ?? null,
      searchCode: async (term) => callers[term] ?? [],
    };
    // The forge names the enclosing function in the hunk header.
    const patch = ["@@ -2,2 +2,2 @@ export function main(input: string) {", "-  return input.trim();", "+  return input;", " }"].join("\n");
    const changeSet = makeChangeSet([{ path: "src/app.ts", changeType: "modified", patch }]);

    const result = await runReview({ changeSet, config: config() }, { generate, now, context });

    expect(result.walkthrough!.riskyAreas).toEqual([
      { kind: "api", path: "src/routes/serve.ts", reason: "calls runCli, 2 hops from the change", via: "main -> runCli" },
    ]);
    // Reached, not changed: worth a look, but most helpers reach some route.
    expect(result.walkthrough!.blastRadius).toBe("medium");
  });
});
