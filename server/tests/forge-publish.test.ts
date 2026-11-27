import { describe, expect, it } from "vitest";
import { SUMMARY_MARKER, fingerprintMarker } from "../src/review/core/markers.ts";
import type { ForgeRef } from "../src/review/core/models.ts";
import { GitHubAdapter } from "../src/review/forge/github.ts";
import { GitLabAdapter } from "../src/review/forge/gitlab.ts";
import type { InlineComment } from "../src/review/forge/types.ts";
import { fetchStub, type StubRoute } from "./helpers/fetchStub.ts";

const ghRef: ForgeRef = {
  provider: "github",
  host: "github.com",
  project: "acme/web",
  number: 42,
  baseSha: "base",
  startSha: "base",
  headSha: "head",
};
const glRef: ForgeRef = { ...ghRef, provider: "gitlab", host: "gitlab.com", project: "team/app", startSha: "start" };

const comment = (fingerprint: string, extra: Partial<InlineComment> = {}): InlineComment => ({
  fingerprint,
  path: "src/a.ts",
  startLine: 11,
  endLine: 11,
  body: `Problem\n\n${fingerprintMarker(fingerprint)}`,
  ...extra,
});

const github = (routes: StubRoute[]) => {
  const stub = fetchStub(routes);
  return { ...stub, gh: new GitHubAdapter({ host: "github.com", token: async () => "t", selfLogin: "sentryward[bot]", fetch: stub.fetch }) };
};
// The token acts as a bot user (setApproval asks once) unless a test's own
// earlier /user route says otherwise.
const gitlab = (routes: StubRoute[]) => {
  const stub = fetchStub([...routes, { url: /\/api\/v4\/user$/, body: { username: "sentryward-bot", bot: true } }]);
  return { ...stub, gl: new GitLabAdapter({ host: "gitlab.com", token: async () => "t", selfLogin: "sentryward-bot", fetch: stub.fetch }) };
};
const body = (call: { body?: string }) => JSON.parse(call.body ?? "{}");
// The pull request as setApproval re-reads it just before and after approving.
const pullAt = (sha: string, base: { sha?: string; ref?: string } = {}, labels: string[] = []): StubRoute => ({
  url: /\/pulls\/42$/,
  body: { head: { sha }, base: { sha: base.sha ?? "base", ref: base.ref ?? "main" }, labels: labels.map((name) => ({ name })) },
});
// The merge request as GitLab's setApproval re-reads it around approving;
// matches glRef unless told otherwise.
const mrAt = (
  moved: { head_sha?: string; base_sha?: string; start_sha?: string; target_branch?: string; diff_refs?: null; labels?: string[] } = {},
): StubRoute => ({
  url: /\/merge_requests\/42$/,
  body: {
    labels: moved.labels ?? [],
    target_branch: moved.target_branch ?? "main",
    diff_refs:
      moved.diff_refs === null
        ? null
        : { head_sha: moved.head_sha ?? "head", base_sha: moved.base_sha ?? "base", start_sha: moved.start_sha ?? "start" },
  },
});

describe("GitHub publishing", () => {
  it("posts one COMMENT review at the head commit with right-side line anchors", async () => {
    const { gh, calls } = github([
      { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 7 } },
      {
        url: /\/pulls\/42\/reviews\/7\/comments/,
        body: [
          { id: 101, body: comment("aaaaaaaaaaaaaaaa").body, user: { login: "sentryward[bot]" } },
          { id: 102, body: comment("bbbbbbbbbbbbbbbb").body, user: { login: "sentryward[bot]" } },
        ],
      },
    ]);

    const result = await gh.postInlineComments(ghRef, [
      comment("aaaaaaaaaaaaaaaa"),
      comment("bbbbbbbbbbbbbbbb", { startLine: 11, endLine: 12 }),
    ]);

    expect(body(calls[0]!)).toEqual({
      commit_id: "head",
      event: "COMMENT",
      comments: [
        { path: "src/a.ts", line: 11, side: "RIGHT", body: comment("aaaaaaaaaaaaaaaa").body },
        { path: "src/a.ts", line: 12, side: "RIGHT", start_line: 11, start_side: "RIGHT", body: comment("bbbbbbbbbbbbbbbb").body },
      ],
    });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(result).toEqual({
      posted: [
        { fingerprint: "aaaaaaaaaaaaaaaa", forgeCommentId: "101" },
        { fingerprint: "bbbbbbbbbbbbbbbb", forgeCommentId: "102" },
      ],
      failed: [],
    });
  });

  it("falls back to one comment at a time when the batch is rejected", async () => {
    let n = 0;
    const { gh } = github([
      { method: "POST", url: /\/pulls\/42\/reviews$/, status: 422, body: { message: "Line could not be resolved" } },
      {
        method: "POST",
        url: /\/pulls\/42\/comments$/,
        get status() {
          return n++ === 0 ? 201 : 422;
        },
        body: { id: 201 },
      },
    ]);

    const result = await gh.postInlineComments(ghRef, [comment("aaaaaaaaaaaaaaaa"), comment("bbbbbbbbbbbbbbbb")]);

    expect(result.posted).toEqual([{ fingerprint: "aaaaaaaaaaaaaaaa", forgeCommentId: "201" }]);
    expect(result.failed.map((f) => f.fingerprint)).toEqual(["bbbbbbbbbbbbbbbb"]);
  });

  it("edits its own summary and ignores a lookalike from someone else", async () => {
    const { gh, calls } = github([
      {
        url: /\/issues\/42\/comments\?per_page=100$/,
        body: [
          { id: 1, body: `quoted ${SUMMARY_MARKER}`, user: { login: "mallory" } },
          { id: 2, body: `old ${SUMMARY_MARKER}`, user: { login: "sentryward[bot]" } },
        ],
      },
      { method: "PATCH", url: /\/issues\/comments\/2$/, body: { id: 2 } },
    ]);

    expect(await gh.upsertSummaryComment(ghRef, "new")).toBe("2");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH" });
    expect(body(calls.at(-1)!)).toEqual({ body: "new" });
  });

  it("creates the summary when none of its own exists", async () => {
    const { gh, calls } = github([
      { url: /\/issues\/42\/comments\?per_page=100$/, body: [] },
      { method: "POST", url: /\/issues\/42\/comments$/, body: { id: 9 } },
    ]);
    expect(await gh.upsertSummaryComment(ghRef, "hello")).toBe("9");
    expect(calls.at(-1)!.method).toBe("POST");
  });

  it("with create: false, edits an existing summary but never starts one", async () => {
    const none = github([{ url: /\/issues\/42\/comments\?per_page=100$/, body: [] }]);
    expect(await none.gh.upsertSummaryComment(ghRef, "hello", { create: false })).toBeNull();
    expect(none.calls.map((c) => c.method ?? "GET")).not.toContain("POST");

    const existing = github([
      { url: /\/issues\/42\/comments\?per_page=100$/, body: [{ id: 2, body: `old ${SUMMARY_MARKER}`, user: { login: "sentryward[bot]" } }] },
      { method: "PATCH", url: /\/issues\/comments\/2$/, body: { id: 2 } },
    ]);
    expect(await existing.gh.upsertSummaryComment(ghRef, "new", { create: false })).toBe("2");
  });

  it("reads fingerprints only from its own inline comments", async () => {
    const { gh } = github([
      {
        url: /\/pulls\/42\/comments\?per_page=100$/,
        body: [
          { id: 1, body: fingerprintMarker("aaaaaaaaaaaaaaaa"), user: { login: "sentryward[bot]" } },
          { id: 2, body: fingerprintMarker("bbbbbbbbbbbbbbbb"), user: { login: "mallory" } },
        ],
      },
    ]);
    expect(await gh.listPostedFingerprints(ghRef)).toEqual(new Set(["aaaaaaaaaaaaaaaa"]));
  });

  // Queries and mutations share one endpoint; the stub answers every call with
  // the thread page, which a mutation's caller never reads.
  const threadPage = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              // GraphQL drops the app's "[bot]" suffix.
              { id: "T1", isResolved: false, resolvedBy: null, comments: { nodes: [{ body: fingerprintMarker("aaaaaaaaaaaaaaaa"), author: { login: "sentryward" } }] } },
              { id: "T2", isResolved: true, resolvedBy: { login: "sentryward" }, comments: { nodes: [{ body: fingerprintMarker("bbbbbbbbbbbbbbbb"), author: { login: "sentryward" } }] } },
              { id: "T3", isResolved: false, resolvedBy: null, comments: { nodes: [{ body: fingerprintMarker("cccccccccccccccc"), author: { login: "mallory" } }] } },
              // Sentryward's thread, but a person resolved it.
              { id: "T4", isResolved: true, resolvedBy: { login: "alice" }, comments: { nodes: [{ body: fingerprintMarker("eeeeeeeeeeeeeeee"), author: { login: "sentryward" } }] } },
            ],
          },
        },
      },
    },
  };

  it("resolves only its own open threads, found by marker", async () => {
    const { gh, calls } = github([{ method: "POST", url: /^https:\/\/api\.github\.com\/graphql$/, body: threadPage }]);

    const result = await gh.setThreadsResolved(ghRef, ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"], true);

    expect(result).toEqual({ updated: ["aaaaaaaaaaaaaaaa"], failed: [] });
    expect(body(calls[0]!).variables).toEqual({ owner: "acme", name: "web", number: 42, after: null });
    expect(calls).toHaveLength(2);
    expect(body(calls[1]!)).toMatchObject({ variables: { id: "T1" } });
    expect(body(calls[1]!).query).toContain("resolveReviewThread");
  });

  it("reopens only a thread it resolved itself", async () => {
    const { gh, calls } = github([{ method: "POST", url: /\/graphql$/, body: threadPage }]);

    // T4 was resolved by a person, so it stays resolved and counts as settled.
    expect(await gh.setThreadsResolved(ghRef, ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "eeeeeeeeeeeeeeee"], false)).toEqual({
      updated: ["bbbbbbbbbbbbbbbb"],
      failed: [],
    });
    expect(calls).toHaveLength(2);
    expect(body(calls[1]!).query).toContain("unresolveReviewThread");
    expect(body(calls[1]!).variables).toEqual({ id: "T2" });
  });

  it("surfaces GraphQL errors sent with a 200", async () => {
    const { gh } = github([{ method: "POST", url: /\/graphql$/, body: { errors: [{ message: "Resource not accessible by integration" }] } }]);
    await expect(gh.setThreadsResolved(ghRef, ["aaaaaaaaaaaaaaaa"], true)).rejects.toThrow("Resource not accessible by integration");
  });

  it("uses the Enterprise GraphQL endpoint beside the REST API", async () => {
    const stub = fetchStub([{ method: "POST", url: /^https:\/\/git\.acme\.dev\/api\/graphql$/, body: threadPage }]);
    const ghe = new GitHubAdapter({ host: "git.acme.dev", token: async () => "t", selfLogin: "sentryward[bot]", fetch: stub.fetch });
    expect((await ghe.setThreadsResolved(ghRef, ["aaaaaaaaaaaaaaaa"], true)).updated).toEqual(["aaaaaaaaaaaaaaaa"]);
  });

  it("stops reading threads once every wanted one is found", async () => {
    const endless = structuredClone(threadPage);
    endless.data.repository.pullRequest.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "next" } as never;
    const { gh, calls } = github([{ method: "POST", url: /\/graphql$/, body: endless }]);

    expect((await gh.setThreadsResolved(ghRef, ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"], true)).updated).toEqual(["aaaaaaaaaaaaaaaa"]);
    // One page read, one mutation.
    expect(calls).toHaveLength(2);
  });

  it("keeps paging past a thousand threads until it finds the wanted one", async () => {
    let reads = 0;
    const fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
      const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { after: string | null } };
      if (!query.includes("reviewThreads")) return Response.json({ data: {} });
      reads++;
      const last = reads === 15;
      const nodes = last
        ? [{ id: "FAR", isResolved: false, resolvedBy: null, comments: { nodes: [{ body: fingerprintMarker("ffffffffffffffff"), author: { login: "sentryward" } }] } }]
        : [];
      const pageInfo = { hasNextPage: !last, endCursor: `c${reads}` };
      expect(variables.after).toBe(reads === 1 ? null : `c${reads - 1}`);
      return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } } });
    };
    const gh = new GitHubAdapter({ host: "github.com", token: async () => "t", selfLogin: "sentryward[bot]", fetch });

    expect(await gh.setThreadsResolved(ghRef, ["ffffffffffffffff"], true)).toEqual({ updated: ["ffffffffffffffff"], failed: [] });
    expect(reads).toBe(15);
  });

  it("keeps an unreached thread pending when the cursor stops moving", async () => {
    const stuck = structuredClone(threadPage);
    stuck.data.repository.pullRequest.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "same" } as never;
    const { gh } = github([{ method: "POST", url: /\/graphql$/, body: stuck }]);

    const result = await gh.setThreadsResolved(ghRef, ["aaaaaaaaaaaaaaaa", "ffffffffffffffff"], true);

    expect(result.updated).toEqual(["aaaaaaaaaaaaaaaa"]);
    expect(result.failed).toEqual([{ fingerprint: "ffffffffffffffff", error: "Review thread listing stopped early" }]);
  });

  it("sets the sentryward/review status on the head commit", async () => {
    const { gh, calls } = github([{ method: "POST", url: /\/statuses\/head$/, body: {} }]);
    await gh.setCommitStatus(ghRef, { state: "failure", description: "x".repeat(200), targetUrl: "http://app/r/1" });
    expect(body(calls[0]!)).toEqual({
      state: "failure",
      context: "sentryward/review",
      description: "x".repeat(140),
      target_url: "http://app/r/1",
    });
  });

  it("approves at the head commit, and skips when its own approval already covers the head", async () => {
    const reviews = (list: unknown[]) => ({ url: /\/pulls\/42\/reviews\?per_page=100$/, body: list });
    const fresh = github([reviews([]), pullAt("head"), { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 1 } }]);
    expect(await fresh.gh.setApproval(ghRef, { action: "approve", body: "ok" })).toEqual({ state: "approved" });
    expect(body(fresh.calls[2]!)).toEqual({ commit_id: "head", event: "APPROVE", body: "ok" });

    const current = github([
      reviews([
        { id: 2, state: "APPROVED", commit_id: "head", user: { login: "sentryward[bot]" } },
        { id: 3, state: "COMMENTED", commit_id: "head", user: { login: "sentryward[bot]" } },
      ]),
      pullAt("head"),
    ]);
    expect(await current.gh.setApproval(ghRef, { action: "approve", body: "ok" })).toEqual({ state: "unchanged" });

    // An approval of an older head, or someone else's, does not count.
    const stale = github([
      reviews([
        { id: 2, state: "APPROVED", commit_id: "old", user: { login: "sentryward[bot]" } },
        { id: 4, state: "APPROVED", commit_id: "head", user: { login: "alice" } },
      ]),
      pullAt("head"),
      { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 5 } },
    ]);
    expect(await stale.gh.setApproval(ghRef, { action: "approve", body: "ok" })).toEqual({ state: "approved" });
  });

  it("does not approve when the pull request moved on during the review", async () => {
    const moved = github([{ url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] }, pullAt("newer")]);
    expect(await moved.gh.setApproval(ghRef, { action: "approve", body: "ok" })).toMatchObject({ state: "refused" });
    expect(moved.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("dismisses its new approval when the pull request moved while it was posted", async () => {
    const { gh, calls } = github([
      { url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] },
      { ...pullAt("head"), times: 1 },
      pullAt("newer"),
      { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 9 } },
      { method: "PUT", url: /\/pulls\/42\/reviews\/9\/dismissals$/, body: {} },
    ]);
    expect(await gh.setApproval(ghRef, { action: "approve", body: "ok" })).toMatchObject({ state: "refused" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "GET", "PUT"]);
    expect(body(calls[4]!)).toMatchObject({ event: "DISMISS" });
  });

  it("does not approve when the base moved or the pull request was retargeted during the review", async () => {
    const noReviews = { url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] };
    const baseMoved = github([noReviews, pullAt("head", { sha: "newbase" })]);
    expect(await baseMoved.gh.setApproval(ghRef, { action: "approve", body: "ok", baseRef: "main" })).toMatchObject({
      state: "refused",
      note: expect.stringMatching(/rerun/),
    });
    expect(baseMoved.calls.some((c) => c.method === "POST")).toBe(false);

    const retargeted = github([noReviews, pullAt("head", { ref: "release" })]);
    expect(await retargeted.gh.setApproval(ghRef, { action: "approve", body: "ok", baseRef: "main" })).toMatchObject({ state: "refused" });
    expect(retargeted.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("withdraws its earlier approval, rather than reusing it, once the base has moved", async () => {
    const routes = (dismissal: StubRoute) => [
      {
        url: /\/pulls\/42\/reviews\?per_page=100$/,
        body: [
          { id: 2, state: "APPROVED", commit_id: "head", user: { login: "sentryward[bot]" } },
          { id: 3, state: "APPROVED", commit_id: "head", user: { login: "alice" } },
        ],
      },
      pullAt("head", { ref: "release" }),
      dismissal,
    ];
    const { gh, calls } = github(routes({ method: "PUT", url: /\/pulls\/42\/reviews\/2\/dismissals$/, body: {} }));
    expect(await gh.setApproval(ghRef, { action: "approve", body: "ok", baseRef: "main" })).toMatchObject({
      state: "withdrawn",
      note: expect.stringMatching(/rerun/),
    });
    // Only its own approval is dismissed, and nothing is posted.
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PUT"]);
    expect(body(calls[2]!)).toMatchObject({ event: "DISMISS" });

    const stands = github(routes({ method: "PUT", url: /\/pulls\/42\/reviews\/2\/dismissals$/, status: 403, body: { message: "Forbidden" } }));
    await expect(stands.gh.setApproval(ghRef, { action: "approve", body: "ok", baseRef: "main" })).rejects.toThrow(/still stands/);
  });

  it("dismisses its new approval when the base moved while it was posted", async () => {
    const { gh, calls } = github([
      { url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] },
      { ...pullAt("head"), times: 1 },
      pullAt("head", { sha: "newbase" }),
      { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 9 } },
      { method: "PUT", url: /\/pulls\/42\/reviews\/9\/dismissals$/, body: {} },
    ]);
    expect(await gh.setApproval(ghRef, { action: "approve", body: "ok" })).toMatchObject({ state: "refused" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "GET", "PUT"]);
  });

  it("also dismisses its earlier approvals when the base moved while the new one was posted", async () => {
    const { gh, calls } = github([
      {
        url: /\/pulls\/42\/reviews\?per_page=100$/,
        body: [
          { id: 2, state: "APPROVED", commit_id: "older", user: { login: "sentryward[bot]" } },
          { id: 3, state: "APPROVED", commit_id: "older", user: { login: "alice" } },
        ],
      },
      { ...pullAt("head"), times: 1 },
      pullAt("head", { sha: "newbase" }),
      { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 9 } },
      { method: "PUT", url: /\/pulls\/42\/reviews\/(9|2)\/dismissals$/, body: {} },
    ]);
    expect(await gh.setApproval(ghRef, { action: "approve", body: "ok", baseRef: "main" })).toMatchObject({
      state: "withdrawn",
      note: expect.stringMatching(/rerun/),
    });
    // The new approval and its own earlier one; never someone else's.
    const dismissed = calls.filter((c) => c.method === "PUT").map((c) => c.url.match(/reviews\/(\d+)\//)![1]);
    expect(dismissed).toEqual(["9", "2"]);
  });

  it("dismisses its new approval when the pull request cannot be re-read after posting", async () => {
    const routes = (dismissal: StubRoute) => [
      { url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] },
      { ...pullAt("head"), times: 1 },
      { url: /\/pulls\/42$/, status: 404, body: { message: "Not Found" } },
      { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 9 } },
      dismissal,
    ];
    const withdrawn = github(routes({ method: "PUT", url: /\/pulls\/42\/reviews\/9\/dismissals$/, body: {} }));
    await expect(withdrawn.gh.setApproval(ghRef, { action: "approve", body: "ok" })).rejects.toThrow(/approval was withdrawn/);
    expect(withdrawn.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "GET", "PUT"]);

    const stands = github(routes({ method: "PUT", url: /\/pulls\/42\/reviews\/9\/dismissals$/, status: 404, body: { message: "Not Found" } }));
    await expect(stands.gh.setApproval(ghRef, { action: "approve", body: "ok" })).rejects.toThrow(/still stands/);
  });

  it("keeps an approval of the given commit when withdrawing without history", async () => {
    const reviews = (commit: string) => ({
      url: /\/pulls\/42\/reviews\?per_page=100$/,
      body: [{ id: 2, state: "APPROVED", commit_id: commit, user: { login: "sentryward[bot]" } }],
    });
    const current = github([reviews("head")]);
    expect(await current.gh.setApproval(ghRef, { action: "withdraw", body: "x", keepAt: "head" })).toEqual({ state: "unchanged" });
    expect(current.calls).toHaveLength(1);

    const stale = github([reviews("old"), { method: "PUT", url: /\/pulls\/42\/reviews\/2\/dismissals$/, body: {} }]);
    expect(await stale.gh.setApproval(ghRef, { action: "withdraw", body: "x", keepAt: "head" })).toEqual({ state: "withdrawn" });
  });

  it("does not approve, and withdraws its earlier approval, when a hold label is on the pull request", async () => {
    const hold = { action: "approve" as const, body: "ok", holdLabels: ["do-not-merge"] };
    const fresh = github([{ url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] }, pullAt("head", {}, ["bug", "do-not-merge"])]);
    expect(await fresh.gh.setApproval(ghRef, hold)).toEqual({ state: "unchanged", heldLabel: "do-not-merge" });
    expect(fresh.calls.some((c) => c.method === "POST")).toBe(false);

    const earlier = github([
      { url: /\/pulls\/42\/reviews\?per_page=100$/, body: [{ id: 2, state: "APPROVED", commit_id: "head", user: { login: "sentryward[bot]" } }] },
      pullAt("head", {}, ["do-not-merge"]),
      { method: "PUT", url: /\/pulls\/42\/reviews\/2\/dismissals$/, body: {} },
    ]);
    expect(await earlier.gh.setApproval(ghRef, hold)).toEqual({ state: "withdrawn", heldLabel: "do-not-merge" });
    expect(earlier.calls.map((c) => c.method)).toEqual(["GET", "GET", "PUT"]);

    // Without a label policy the labels are not consulted.
    const free = github([{ url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] }, pullAt("head", {}, ["do-not-merge"]), { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 1 } }]);
    expect(await free.gh.setApproval(ghRef, { action: "approve", body: "ok" })).toEqual({ state: "approved" });
  });

  it("dismisses its new approval when a hold label was added while it was posted", async () => {
    const { gh, calls } = github([
      { url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] },
      { ...pullAt("head"), times: 1 },
      pullAt("head", {}, ["do-not-merge"]),
      { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 9 } },
      { method: "PUT", url: /\/pulls\/42\/reviews\/9\/dismissals$/, body: {} },
    ]);
    expect(await gh.setApproval(ghRef, { action: "approve", body: "ok", holdLabels: ["do-not-merge"] })).toEqual({
      state: "withdrawn",
      heldLabel: "do-not-merge",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "GET", "PUT"]);
  });

  it("refuses every decision when it does not know its own login", async () => {
    const stub = fetchStub([]);
    const anonymous = new GitHubAdapter({ host: "github.com", token: async () => "t", fetch: stub.fetch });
    for (const action of ["approve", "request_changes", "withdraw"] as const) {
      expect(await anonymous.setApproval(ghRef, { action, body: "x" })).toMatchObject({ state: "refused" });
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses every decision on a token connection, which acts as a person", async () => {
    const stub = fetchStub([]);
    const person = new GitHubAdapter({ host: "github.com", token: async () => "t", selfLogin: "alice", repoSource: "user", fetch: stub.fetch });
    for (const action of ["approve", "request_changes", "withdraw"] as const) {
      expect(await person.setApproval(ghRef, { action, body: "x" })).toMatchObject({
        state: "refused",
        note: expect.stringMatching(/GitHub App/),
      });
    }
    // Not even a read: alice's own approvals are never dismissed.
    expect(stub.calls).toHaveLength(0);
  });

  it("requests changes once, until it is withdrawn", async () => {
    const reviews = (list: unknown[]) => ({ url: /\/pulls\/42\/reviews\?per_page=100$/, body: list });
    const first = github([
      reviews([{ id: 2, state: "APPROVED", commit_id: "old", user: { login: "sentryward[bot]" } }]),
      { method: "POST", url: /\/pulls\/42\/reviews$/, body: { id: 3 } },
    ]);
    expect(await first.gh.setApproval(ghRef, { action: "request_changes", body: "fix" })).toEqual({ state: "changes_requested" });
    expect(body(first.calls[1]!)).toMatchObject({ event: "REQUEST_CHANGES", body: "fix" });

    const again = github([reviews([{ id: 3, state: "CHANGES_REQUESTED", commit_id: "old", user: { login: "sentryward[bot]" } }])]);
    expect(await again.gh.setApproval(ghRef, { action: "request_changes", body: "fix" })).toEqual({ state: "unchanged" });
  });

  it("dismisses only its own standing reviews when withdrawing", async () => {
    const { gh, calls } = github([
      {
        url: /\/pulls\/42\/reviews\?per_page=100$/,
        body: [
          { id: 2, state: "APPROVED", commit_id: "old", user: { login: "sentryward[bot]" } },
          { id: 3, state: "DISMISSED", commit_id: "old", user: { login: "sentryward[bot]" } },
          { id: 4, state: "APPROVED", commit_id: "head", user: { login: "alice" } },
        ],
      },
      { method: "PUT", url: /\/pulls\/42\/reviews\/2\/dismissals$/, body: {} },
    ]);
    expect(await gh.setApproval(ghRef, { action: "withdraw", body: "blocked" })).toEqual({ state: "withdrawn" });
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual([expect.stringMatching(/reviews\/2\/dismissals$/)]);
    expect(body(calls[1]!)).toEqual({ message: "blocked", event: "DISMISS" });

    const none = github([{ url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] }]);
    expect(await none.gh.setApproval(ghRef, { action: "withdraw", body: "blocked" })).toEqual({ state: "unchanged" });
  });

  it("reports a pull request opened by its own account as refused, other failures as errors", async () => {
    const own = github([
      { url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] },
      pullAt("head"),
      // GitHub's real shape: the reason is only in `errors`.
      {
        method: "POST",
        url: /\/pulls\/42\/reviews$/,
        status: 422,
        body: { message: "Unprocessable Entity", errors: ["Review Can not approve your own pull request"] },
      },
    ]);
    expect(await own.gh.setApproval(ghRef, { action: "approve", body: "ok" })).toMatchObject({ state: "refused" });

    const broken = github([
      { url: /\/pulls\/42\/reviews\?per_page=100$/, body: [] },
      pullAt("head"),
      { method: "POST", url: /\/pulls\/42\/reviews$/, status: 403, body: { message: "Resource not accessible by integration" } },
    ]);
    await expect(broken.gh.setApproval(ghRef, { action: "approve", body: "ok" })).rejects.toThrow(/403/);
  });

  it("replaces the estimate labels, ignoring one the PR does not carry", async () => {
    const { gh, calls } = github([
      { method: "DELETE", url: /\/issues\/42\/labels\/Large%20blast%20radius$/, status: 404, body: { message: "Label does not exist" } },
      { method: "POST", url: /\/issues\/42\/labels$/, body: [] },
    ]);
    await gh.setLabels(ghRef, ["Small blast radius"], ["Large blast radius"]);
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "POST"]);
    expect(body(calls[1]!)).toEqual({ labels: ["Small blast radius"] });
  });

  it("rewrites the description from its current text, and skips an unchanged one", async () => {
    const { gh, calls } = github([
      { url: /\/pulls\/42$/, body: { body: "Author text" } },
      { method: "PATCH", url: /\/pulls\/42$/, body: {} },
    ]);
    await gh.updateDescription(ghRef, (text) => `${text}\n\nmore`);
    expect(body(calls[1]!)).toEqual({ body: "Author text\n\nmore" });

    await gh.updateDescription(ghRef, (text) => text);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
});

describe("GitLab publishing", () => {
  it("opens one discussion per finding with a full text position", async () => {
    const { gl, calls } = gitlab([
      { method: "POST", url: /\/merge_requests\/42\/discussions$/, body: { id: "d1", notes: [] } },
    ]);

    const result = await gl.postInlineComments(glRef, [
      comment("aaaaaaaaaaaaaaaa", { previousPath: "src/old.ts" }),
      comment("bbbbbbbbbbbbbbbb", { startLine: 13, endLine: 13, oldLine: 11 }),
    ]);

    expect(body(calls[0]!).position).toEqual({
      position_type: "text",
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      new_path: "src/a.ts",
      old_path: "src/old.ts",
      new_line: 11,
    });
    expect(body(calls[1]!).position).toMatchObject({ new_line: 13, old_line: 11, old_path: "src/a.ts" });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(result.posted).toEqual([
      { fingerprint: "aaaaaaaaaaaaaaaa", forgeCommentId: "d1" },
      { fingerprint: "bbbbbbbbbbbbbbbb", forgeCommentId: "d1" },
    ]);
  });

  it("records a rejected position as a failure and carries on", async () => {
    let n = 0;
    const { gl } = gitlab([
      {
        method: "POST",
        url: /\/discussions$/,
        get status() {
          return n++ === 0 ? 400 : 201;
        },
        body: { id: "d2", notes: [], message: "line_code can't be blank" },
      },
    ]);

    const result = await gl.postInlineComments(glRef, [comment("aaaaaaaaaaaaaaaa"), comment("bbbbbbbbbbbbbbbb")]);

    expect(result.failed.map((f) => f.fingerprint)).toEqual(["aaaaaaaaaaaaaaaa"]);
    expect(result.posted).toEqual([{ fingerprint: "bbbbbbbbbbbbbbbb", forgeCommentId: "d2" }]);
  });

  it("edits its own summary note, skipping system notes and other authors", async () => {
    const { gl, calls } = gitlab([
      {
        url: /\/merge_requests\/42\/notes\?per_page=100&sort=asc$/,
        body: [
          { id: 1, body: SUMMARY_MARKER, system: true, author: { username: "sentryward-bot" } },
          { id: 2, body: SUMMARY_MARKER, system: false, author: { username: "mallory" } },
          { id: 3, body: SUMMARY_MARKER, system: false, author: { username: "sentryward-bot" } },
        ],
      },
      { method: "PUT", url: /\/notes\/3$/, body: { id: 3 } },
    ]);
    expect(await gl.upsertSummaryComment(glRef, "new")).toBe("3");
    expect(body(calls.at(-1)!)).toEqual({ body: "new" });
  });

  it("with create: false, never starts a summary note", async () => {
    const { gl, calls } = gitlab([{ url: /\/merge_requests\/42\/notes\?per_page=100&sort=asc$/, body: [] }]);
    expect(await gl.upsertSummaryComment(glRef, "hello", { create: false })).toBeNull();
    expect(calls.map((c) => c.method ?? "GET")).not.toContain("POST");
  });

  it("resolves and reopens only its own diff discussions", async () => {
    const note = (fp: string, username: string, resolved?: boolean, resolver = "sentryward-bot") => ({
      id: 1,
      body: fingerprintMarker(fp),
      system: false,
      author: { username },
      ...(resolved === undefined ? {} : { resolvable: true, resolved, resolved_by: resolved ? { username: resolver } : null }),
    });
    const { gl, calls } = gitlab([
      {
        url: /\/merge_requests\/42\/discussions\?per_page=100$/,
        body: [
          { id: "d1", notes: [note("aaaaaaaaaaaaaaaa", "sentryward-bot", false)] },
          { id: "d2", notes: [note("bbbbbbbbbbbbbbbb", "sentryward-bot", true)] },
          { id: "d3", notes: [note("cccccccccccccccc", "mallory", false)] },
          { id: "d4", notes: [note("dddddddddddddddd", "sentryward-bot")] },
          // Sentryward's discussion, but a person resolved it.
          { id: "d5", notes: [note("eeeeeeeeeeeeeeee", "sentryward-bot", true, "alice")] },
        ],
      },
      { method: "PUT", url: /\/discussions\/d[0-9]\?resolved=(true|false)$/, body: {} },
    ]);
    const prints = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc", "dddddddddddddddd", "eeeeeeeeeeeeeeee"];

    expect(await gl.setThreadsResolved(glRef, prints, true)).toEqual({ updated: ["aaaaaaaaaaaaaaaa"], failed: [] });
    expect(calls.at(-1)).toMatchObject({ method: "PUT" });
    expect(calls.at(-1)!.url).toMatch(/\/discussions\/d1\?resolved=true$/);

    expect(await gl.setThreadsResolved(glRef, prints, false)).toEqual({ updated: ["bbbbbbbbbbbbbbbb"], failed: [] });
    expect(calls.at(-1)!.url).toMatch(/\/discussions\/d2\?resolved=false$/);
  });

  it("keeps paging past the old thirty-page limit", async () => {
    let reads = 0;
    const fetch = async (url: string | URL | Request) => {
      if (String(url).includes("?resolved=")) return Response.json({});
      reads++;
      const last = reads === 35;
      const discussions = last
        ? [{ id: "far", notes: [{ id: 1, body: fingerprintMarker("ffffffffffffffff"), system: false, author: { username: "sentryward-bot" }, resolvable: true, resolved: false }] }]
        : [];
      return Response.json(discussions, { headers: last ? {} : { "x-next-page": String(reads + 1) } });
    };
    const gl = new GitLabAdapter({ host: "gitlab.com", token: async () => "t", selfLogin: "sentryward-bot", fetch });

    expect(await gl.setThreadsResolved(glRef, ["ffffffffffffffff"], true)).toEqual({ updated: ["ffffffffffffffff"], failed: [] });
    expect(reads).toBe(35);
  });

  it("stops reading discussions once every wanted thread is found", async () => {
    let reads = 0;
    const fetch = async (url: string | URL | Request) => {
      if (String(url).includes("?resolved=")) return Response.json({});
      reads++;
      const discussions = [{ id: "d1", notes: [{ id: 1, body: fingerprintMarker("aaaaaaaaaaaaaaaa"), system: false, author: { username: "sentryward-bot" }, resolvable: true, resolved: false }] }];
      return Response.json(discussions, { headers: { "x-next-page": String(reads + 1) } });
    };
    const gl = new GitLabAdapter({ host: "gitlab.com", token: async () => "t", selfLogin: "sentryward-bot", fetch });

    expect(await gl.setThreadsResolved(glRef, ["aaaaaaaaaaaaaaaa"], true)).toEqual({ updated: ["aaaaaaaaaaaaaaaa"], failed: [] });
    expect(reads).toBe(1);
  });

  it("keeps the page cap when only listing posted fingerprints", async () => {
    let reads = 0;
    const fetch = async () => {
      reads++;
      return Response.json([], { headers: { "x-next-page": String(reads + 1) } });
    };
    const gl = new GitLabAdapter({ host: "gitlab.com", token: async () => "t", selfLogin: "sentryward-bot", fetch });

    expect(await gl.listPostedFingerprints(glRef)).toEqual(new Set());
    expect(reads).toBe(30);
  });

  it("keeps an unreached discussion pending when the next page stops moving", async () => {
    const { gl } = gitlab([
      {
        url: /\/merge_requests\/42\/discussions\?per_page=100(&page=\d+)?$/,
        headers: { "x-next-page": "2" },
        body: [
          {
            id: "d1",
            notes: [{ id: 1, body: fingerprintMarker("aaaaaaaaaaaaaaaa"), system: false, author: { username: "sentryward-bot" }, resolvable: true, resolved: true }],
          },
        ],
      },
    ]);

    // Already resolved, so settled; the unseen one stays pending.
    expect(await gl.setThreadsResolved(glRef, ["aaaaaaaaaaaaaaaa", "ffffffffffffffff"], true)).toEqual({
      updated: [],
      failed: [{ fingerprint: "ffffffffffffffff", error: "Discussion listing stopped early" }],
    });
  });

  it("maps states onto GitLab's commit status names", async () => {
    const { gl, calls } = gitlab([{ method: "POST", url: /\/projects\/team%2Fapp\/statuses\/head$/, body: {} }]);
    await gl.setCommitStatus(glRef, { state: "error", description: "Review incomplete" });
    await gl.setCommitStatus(glRef, { state: "pending", description: "Review in progress" });
    expect(calls.map((c) => body(c).state)).toEqual(["failed", "running"]);
    expect(body(calls[0]!).name).toBe("sentryward/review");
  });

  it("approves at the head sha unless it already approved, and withdraws only its own approval", async () => {
    const approvals = (users: string[]) => ({
      url: /\/merge_requests\/42\/approvals$/,
      body: { approved_by: users.map((username) => ({ user: { username } })) },
    });
    const fresh = gitlab([approvals(["alice"]), mrAt(), { method: "POST", url: /\/merge_requests\/42\/approve$/, body: {} }]);
    expect(await fresh.gl.setApproval(glRef, { action: "approve", body: "ok", baseRef: "main" })).toEqual({ state: "approved" });
    // The first read asks whether the token acts as a bot.
    expect(fresh.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "POST", "GET"]);
    expect(body(fresh.calls[3]!)).toEqual({ sha: "head" });

    const done = gitlab([approvals(["sentryward-bot"]), mrAt()]);
    expect(await done.gl.setApproval(glRef, { action: "approve", body: "ok" })).toEqual({ state: "unchanged" });

    const withdraw = gitlab([approvals(["sentryward-bot"]), { method: "POST", url: /\/merge_requests\/42\/unapprove$/, body: {} }]);
    expect(await withdraw.gl.setApproval(glRef, { action: "withdraw", body: "blocked" })).toEqual({ state: "withdrawn" });

    // No "request changes" on GitLab: it only withdraws, and leaves others' approvals.
    const others = gitlab([approvals(["alice"])]);
    expect(await others.gl.setApproval(glRef, { action: "request_changes", body: "fix" })).toEqual({ state: "unchanged" });
    expect(others.calls).toHaveLength(2);
  });

  it("does not approve, or reuse its approval, once the merge request was retargeted or its diff refs moved", async () => {
    const approvals = (users: string[]) => ({
      url: /\/merge_requests\/42\/approvals$/,
      body: { approved_by: users.map((username) => ({ user: { username } })) },
    });
    const unapprove = { method: "POST", url: /\/merge_requests\/42\/unapprove$/, body: {} };

    for (const moved of [mrAt({ target_branch: "release" }), mrAt({ base_sha: "newbase" }), mrAt({ start_sha: "newstart" }), mrAt({ diff_refs: null })]) {
      const fresh = gitlab([approvals([]), moved]);
      expect(await fresh.gl.setApproval(glRef, { action: "approve", body: "ok", baseRef: "main" })).toMatchObject({
        state: "refused",
        note: expect.stringMatching(/rerun/),
      });
      expect(fresh.calls.some((c) => c.method === "POST")).toBe(false);
    }

    // Its earlier approval no longer covers the target, so it is withdrawn.
    const stale = gitlab([approvals(["sentryward-bot"]), mrAt({ target_branch: "release" }), unapprove]);
    expect(await stale.gl.setApproval(glRef, { action: "approve", body: "ok", baseRef: "main" })).toMatchObject({ state: "withdrawn" });
    expect(stale.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "POST"]);

    const stands = gitlab([
      approvals(["sentryward-bot"]),
      mrAt({ target_branch: "release" }),
      { method: "POST", url: /\/merge_requests\/42\/unapprove$/, status: 403, body: { message: "403 Forbidden" } },
    ]);
    await expect(stands.gl.setApproval(glRef, { action: "approve", body: "ok", baseRef: "main" })).rejects.toThrow(/still stands/);

    // A newer head leaves the decision to the review that push queued.
    const pushed = gitlab([approvals(["sentryward-bot"]), mrAt({ head_sha: "newer" })]);
    expect(await pushed.gl.setApproval(glRef, { action: "approve", body: "ok", baseRef: "main" })).toMatchObject({
      state: "refused",
      note: expect.stringMatching(/next review/),
    });
    expect(pushed.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("withdraws its new approval when the merge request moved while it was posted, or cannot be re-read", async () => {
    const routes = (after: StubRoute, unapprove: StubRoute = { method: "POST", url: /\/merge_requests\/42\/unapprove$/, body: {} }) => [
      { url: /\/merge_requests\/42\/approvals$/, body: { approved_by: [] } },
      { ...mrAt(), times: 1 },
      after,
      { method: "POST", url: /\/merge_requests\/42\/approve$/, body: {} },
      unapprove,
    ];
    const retargeted = gitlab(routes(mrAt({ target_branch: "release" })));
    expect(await retargeted.gl.setApproval(glRef, { action: "approve", body: "ok", baseRef: "main" })).toMatchObject({ state: "refused" });
    expect(retargeted.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "POST", "GET", "POST"]);
    expect(retargeted.calls[5]!.url).toMatch(/\/unapprove$/);

    const unreadable = gitlab(routes({ url: /\/merge_requests\/42$/, status: 404, body: { message: "404 Not Found" } }));
    await expect(unreadable.gl.setApproval(glRef, { action: "approve", body: "ok", baseRef: "main" })).rejects.toThrow(/approval was withdrawn/);

    const stands = gitlab(
      routes(mrAt({ target_branch: "release" }), { method: "POST", url: /\/merge_requests\/42\/unapprove$/, status: 403, body: { message: "403 Forbidden" } }),
    );
    await expect(stands.gl.setApproval(glRef, { action: "approve", body: "ok", baseRef: "main" })).rejects.toThrow(/still stands/);
  });

  it("refuses only when GitLab says the account cannot approve, and reports other failures", async () => {
    const ineligible = gitlab([{ url: /\/merge_requests\/42\/approvals$/, body: { approved_by: [], user_can_approve: false } }, mrAt()]);
    expect(await ineligible.gl.setApproval(glRef, { action: "approve", body: "ok" })).toMatchObject({ state: "refused" });
    expect(ineligible.calls.some((c) => c.method === "POST")).toBe(false);

    // A 401 from the approve call itself may be a revoked token: an error, not a note.
    const unauthorized = gitlab([
      { url: /\/merge_requests\/42\/approvals$/, body: { approved_by: [], user_can_approve: true } },
      mrAt(),
      { method: "POST", url: /\/merge_requests\/42\/approve$/, status: 401, body: { message: "401 Unauthorized" } },
    ]);
    await expect(unauthorized.gl.setApproval(glRef, { action: "approve", body: "ok" })).rejects.toThrow(/401/);
  });

  it("does not approve, and unapproves, when a hold label is on the merge request", async () => {
    const hold = { action: "approve" as const, body: "ok", holdLabels: ["do-not-merge"] };
    const fresh = gitlab([
      { url: /\/merge_requests\/42\/approvals$/, body: { approved_by: [], user_can_approve: true } },
      mrAt({ labels: ["do-not-merge"] }),
    ]);
    expect(await fresh.gl.setApproval(glRef, hold)).toEqual({ state: "unchanged", heldLabel: "do-not-merge" });
    expect(fresh.calls.some((c) => c.method === "POST")).toBe(false);

    const earlier = gitlab([
      { url: /\/merge_requests\/42\/approvals$/, body: { approved_by: [{ user: { username: "sentryward-bot" } }], user_can_approve: true } },
      mrAt({ labels: ["do-not-merge"] }),
      { method: "POST", url: /\/merge_requests\/42\/unapprove$/, body: {} },
    ]);
    expect(await earlier.gl.setApproval(glRef, hold)).toEqual({ state: "withdrawn", heldLabel: "do-not-merge" });
    expect(earlier.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([expect.stringMatching(/\/unapprove$/)]);
  });

  it("unapproves when a hold label was added while it approved", async () => {
    const { gl, calls } = gitlab([
      { url: /\/merge_requests\/42\/approvals$/, body: { approved_by: [], user_can_approve: true } },
      { ...mrAt(), times: 1 },
      mrAt({ labels: ["do-not-merge"] }),
      { method: "POST", url: /\/merge_requests\/42\/approve$/, body: {} },
      { method: "POST", url: /\/merge_requests\/42\/unapprove$/, body: {} },
    ]);
    expect(await gl.setApproval(glRef, { action: "approve", body: "ok", holdLabels: ["do-not-merge"] })).toEqual({
      state: "withdrawn",
      heldLabel: "do-not-merge",
    });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url.replace(/^.*\/merge_requests\/42/, ""))).toEqual(["/approve", "/unapprove"]);
  });

  it("refuses every decision when it does not know its own username", async () => {
    const stub = fetchStub([]);
    const anonymous = new GitLabAdapter({ host: "gitlab.com", token: async () => "t", fetch: stub.fetch });
    expect(await anonymous.setApproval(glRef, { action: "approve", body: "ok" })).toMatchObject({ state: "refused" });
    expect(await anonymous.setApproval(glRef, { action: "withdraw", body: "x" })).toMatchObject({ state: "refused" });
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses every decision when the connection acts as a person, so it never removes their approval", async () => {
    const { gl, calls } = gitlab([{ url: /\/api\/v4\/user$/, body: { username: "sentryward-bot", bot: false } }]);
    for (const action of ["approve", "request_changes", "withdraw"] as const) {
      expect(await gl.setApproval(glRef, { action, body: "x" })).toMatchObject({
        state: "refused",
        note: expect.stringMatching(/access token or a service account/),
      });
    }
    // Asked once per adapter; no approvals read, nothing unapproved.
    expect(calls.map((c) => c.url)).toEqual(["https://gitlab.com/api/v4/user"]);
  });

  it("adds and removes labels in one update", async () => {
    const { gl, calls } = gitlab([{ method: "PUT", url: /\/merge_requests\/42$/, body: {} }]);
    await gl.setLabels(glRef, ["1-5 Minutes"], ["5-10 Minutes", "40+ Minutes"]);
    expect(body(calls[0]!)).toEqual({ add_labels: "1-5 Minutes", remove_labels: "5-10 Minutes,40+ Minutes" });
  });

  it("writes the description through the merge request", async () => {
    const { gl, calls } = gitlab([
      { url: /\/merge_requests\/42$/, body: { description: null } },
      { method: "PUT", url: /\/merge_requests\/42$/, body: {} },
    ]);
    await gl.updateDescription(glRef, (text) => `${text}summary`);
    expect(body(calls[1]!)).toEqual({ description: "summary" });
  });
});
