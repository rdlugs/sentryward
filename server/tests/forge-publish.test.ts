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
const gitlab = (routes: StubRoute[]) => {
  const stub = fetchStub(routes);
  return { ...stub, gl: new GitLabAdapter({ host: "gitlab.com", token: async () => "t", selfLogin: "sentryward-bot", fetch: stub.fetch }) };
};
const body = (call: { body?: string }) => JSON.parse(call.body ?? "{}");

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
