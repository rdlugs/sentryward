import type { ChangeSet, ForgeProvider, IssueContext } from "../core/models.ts";
import { toChangedFile } from "../diff/parse.ts";
import type { Generate, GenerateRequest, GenerateResponse } from "../llm/providers.ts";
import type { FullWalkthroughOutput, ModelFinding } from "../llm/schemas.ts";
import type { WalkthroughIssues } from "../llm/walkthrough.ts";

// A made-up change and a scripted model, so the dashboard can preview what a
// review posts by running the real pipeline and renderers without a model call.
// The findings are chosen so most settings visibly matter: categories (docs and
// maintainability are off by default), the severity floor and block level, the
// confidence floor, the evidence rule and committable suggestions.

const USERS_PATCH = [
  "@@ -0,0 +1,14 @@",
  '+import { Router } from "express";',
  '+import { formatDate } from "../lib/dates";',
  '+import { db } from "../db";',
  "+",
  "+export const users = Router();",
  "+",
  '+users.get("/users/:id", async (req, res) => {',
  "+  const id = req.params.id;",
  "+  const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`);",
  "+  const user = rows[0];",
  "+  res.json({ id: user.id, name: user.name });",
  "+});",
  "+",
  "+export default users;",
].join("\n");

const README_PATCH = [
  "@@ -1,3 +1,6 @@",
  " # Users service",
  " ",
  " Run the API locally with `npm run dev`.",
  "+",
  "+## Lookup",
  "+Fetch one user with `GET /users/:id`; it retruns their name.",
].join("\n");

export function sampleChange(provider: ForgeProvider): ChangeSet {
  return {
    forgeRef: {
      provider,
      host: provider === "github" ? "github.com" : "gitlab.com",
      project: "acme/users",
      number: 42,
      baseSha: "5d1c0a9e",
      startSha: "5d1c0a9e",
      headSha: "a1b2c3d4e5f6",
    },
    title: "Add user lookup endpoint",
    description: "Closes #12",
    baseRef: "main",
    headRef: "feature/user-lookup",
    isDraft: false,
    author: "ada",
    labels: [],
    files: [
      toChangedFile({ path: "src/api/users.ts", changeType: "added", patch: USERS_PATCH }),
      toChangedFile({ path: "README.md", changeType: "modified", patch: README_PATCH }),
    ],
  };
}

function finding(overrides: Partial<ModelFinding> & Pick<ModelFinding, "file" | "startLine" | "title" | "body">): ModelFinding {
  return {
    endLine: overrides.startLine,
    severity: "minor",
    category: "bug",
    kind: "potential_issue",
    effort: "quick_win",
    suggestion: null,
    impact: "",
    fixRationale: "",
    confidence: 0.9,
    evidence: "execution_path",
    evidenceNote: "",
    evidenceFiles: [],
    ruleId: null,
    claim: null,
    ...overrides,
  };
}

const SAMPLE_FINDINGS: ModelFinding[] = [
  finding({
    file: "src/api/users.ts",
    startLine: 9,
    severity: "critical",
    category: "security",
    title: "User id is interpolated into the SQL query",
    body: "`id` comes straight from the request path and is interpolated into the query. Pass it as a query parameter instead.",
    impact: "Anyone who can call the endpoint can read or change every row in the database.",
    fixRationale: "A bound parameter is sent separately from the SQL text, so the value can never change the query.",
    suggestion: '  const rows = await db.query("SELECT * FROM users WHERE id = $1", [id]);',
    confidence: 0.95,
    evidenceNote: "GET /users/1%20OR%201=1 returns every row.",
  }),
  finding({
    file: "src/api/users.ts",
    startLine: 10,
    endLine: 11,
    severity: "major",
    category: "bug",
    title: "Unknown ids crash the handler",
    body: "When no row matches, `user` is undefined and reading `user.id` throws. Return a 404 when no row is found.",
    impact: "Clients asking for a missing user get a 500 instead of a 404, and the error is logged as a crash.",
    confidence: 0.85,
    evidence: "contract",
    evidenceNote: "db.query resolves to an empty array when nothing matches.",
  }),
  finding({
    file: "src/api/users.ts",
    startLine: 7,
    severity: "major",
    category: "reliability",
    effort: "moderate",
    title: "The lookup has no rate limit",
    body: "Each request hits the database; an unauthenticated client can enumerate ids quickly.",
    confidence: 0.6,
    evidence: "unverified",
    evidenceNote: "Other routes may sit behind a shared limiter.",
  }),
  finding({
    file: "src/api/users.ts",
    startLine: 2,
    severity: "minor",
    category: "maintainability",
    kind: "nitpick",
    title: "formatDate is imported but never used",
    body: "Remove the import.",
    evidence: "static_tool",
    evidenceNote: "No reference to formatDate in the file.",
  }),
  finding({
    file: "README.md",
    startLine: 6,
    severity: "info",
    category: "docs",
    kind: "nitpick",
    title: 'Typo: "retruns"',
    body: 'Should read "returns".',
    suggestion: "Fetch one user with `GET /users/:id`; it returns their name.",
    confidence: 0.4,
    evidence: "unverified",
  }),
];

// What the forge would return for the sample change's issue lookups.
export function sampleIssues(provider: ForgeProvider): WalkthroughIssues {
  const base = provider === "github" ? "https://github.com/acme/users/issues" : "https://gitlab.com/acme/users/-/issues";
  const issue = (number: number, title: string, body: string): IssueContext => ({
    ref: `#${number}`,
    title,
    url: `${base}/${number}`,
    state: "open",
    body,
  });
  return {
    linked: [issue(12, "Look up a single user by id", "Add GET /users/:id returning the user's id and name, and 404 for an unknown id.")],
    candidates: [
      issue(31, "User profile endpoints", "Endpoints to read and update a user's profile."),
      issue(7, "Upgrade the CI runners", "Move CI to the new runner images."),
    ],
  };
}

const SAMPLE_WALKTHROUGH: FullWalkthroughOutput = {
  overview:
    "Adds a `GET /users/:id` endpoint that looks a user up by id and returns their id and name, and documents it in the README.",
  fileSummaries: [
    { path: "src/api/users.ts", summary: "New router with the user lookup handler." },
    { path: "README.md", summary: "Documents the lookup endpoint." },
  ],
  labels: ["api", "feature"],
  estimatedEffort: 2,
  blastRadius: "medium",
  sequenceDiagram: [
    "sequenceDiagram",
    "  participant Client",
    "  participant Router as Users router",
    "  participant DB",
    "  Client->>Router: GET /users/:id",
    "  Router->>DB: SELECT user by id",
    "  DB-->>Router: rows",
    "  Router-->>Client: 200 { id, name }",
  ].join("\n"),
  highLevelSummary: "**New Features**\n- Look up a single user with `GET /users/:id`.\n\n**Documentation**\n- The README describes the new lookup endpoint.",
  linkedIssues: [
    { ref: "#12", assessment: "partial", note: "The lookup is added, but an unknown id fails instead of returning 404." },
  ],
  relatedIssues: [{ ref: "#31", reason: "Profile endpoints build on this user lookup." }],
};

// Answers like a model would, by schema name; never touches the network.
export const sampleGenerate: Generate = async <T>(request: GenerateRequest<T>): Promise<GenerateResponse<T>> => {
  const object =
    request.schemaName === "walkthrough"
      ? SAMPLE_WALKTHROUGH
      : request.schemaName === "verification"
        ? { verdict: "confirmed", reason: "The failure path is in the diff." }
        : { findings: SAMPLE_FINDINGS };
  return { object: object as T, model: request.model, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
};

export const SAMPLE_NOW = new Date("2026-10-04T12:00:00Z");
