import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { GitHubAdapter, quoteCodeSearchTerm } from "../src/review/forge/github.ts";
import { GitHubApp, githubApiBase } from "../src/review/forge/githubApp.ts";
import { GitLabAdapter } from "../src/review/forge/gitlab.ts";
import { ForgeError } from "../src/review/forge/http.ts";
import { fetchStub } from "./helpers/fetchStub.ts";

const PATCH = "@@ -1,2 +1,3 @@\n a\n+b\n c";

describe("GitHubAdapter", () => {
  const adapter = (routes: Parameters<typeof fetchStub>[0]) => {
    const stub = fetchStub(routes);
    return {
      ...stub,
      adapter: new GitHubAdapter({ host: "github.com", token: async () => "tok", fetch: stub.fetch }),
    };
  };

  it("builds a ChangeSet from a pull request and its paginated files", async () => {
    const { adapter: gh, calls } = adapter([
      {
        url: /\/repos\/acme\/web\/pulls\/42$/,
        body: {
          title: "Add b",
          body: null,
          draft: true,
          html_url: "https://github.com/acme/web/pull/42",
          user: { login: "octo", id: 583231 },
          base: { sha: "base1", ref: "main" },
          head: { sha: "head1", ref: "feature" },
        },
      },
      {
        url: /\/pulls\/42\/files\?per_page=100$/,
        body: [{ filename: "src/a.ts", status: "modified", patch: PATCH, changes: 1 }],
        headers: {
          link: '<https://api.github.com/repos/acme/web/pulls/42/files?per_page=100&page=2>; rel="next"',
        },
      },
      {
        url: /\/pulls\/42\/files\?per_page=100&page=2$/,
        body: [
          { filename: "img.png", status: "added", changes: 0 },
          { filename: "huge.json", status: "modified", changes: 90000 },
          { filename: "new.ts", previous_filename: "old.ts", status: "renamed", changes: 0 },
        ],
      },
    ]);

    const change = await gh.getChange("acme/web", 42);

    expect(change.forgeRef).toMatchObject({
      provider: "github",
      project: "acme/web",
      number: 42,
      baseSha: "base1",
      startSha: "base1",
      headSha: "head1",
    });
    expect(change).toMatchObject({ title: "Add b", description: "", isDraft: true, headRef: "feature" });
    // The id, not the login, is what personal notifications match on.
    expect(change).toMatchObject({ author: "octo", authorId: "583231" });
    expect(change.files.map((f) => [f.path, f.changeType, f.patchUnavailable])).toEqual([
      ["src/a.ts", "modified", false],
      ["img.png", "added", false],
      ["huge.json", "modified", true],
      ["new.ts", "renamed", false],
    ]);
    expect(change.files[0]!.hunks[0]!.addedLines).toEqual([2]);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
  });

  it("returns null for a file missing at a ref", async () => {
    const { adapter: gh } = adapter([
      { url: /\/contents\/\.sentryward\.yaml\?ref=base1$/, status: 404, body: { message: "Not Found" } },
    ]);
    expect(await gh.getFileAtRef("acme/web", ".sentryward.yaml", "base1")).toBeNull();
  });

  it("reads raw file content at a ref", async () => {
    const { adapter: gh, calls } = adapter([
      { url: /\/contents\/dir\/a%20b\.ts\?ref=main$/, body: "export {}" },
    ]);
    expect(await gh.getFileAtRef("acme/web", "dir/a b.ts", "main")).toBe("export {}");
    expect(calls[0]!.headers.accept).toBe("application/vnd.github.raw+json");
  });

  it("lists a directory at a ref, marking subdirectories", async () => {
    const { adapter: gh, calls } = adapter([
      {
        url: /\/repos\/acme\/web\/contents\/src\/a%20b\?ref=head1$/,
        body: [
          { name: "users", type: "dir" },
          { name: "users.test.ts", type: "file" },
        ],
      },
      { url: /\/repos\/acme\/web\/contents\?ref=head1$/, body: [{ name: "README.md", type: "file" }] },
    ]);
    expect(await gh.listDirAtRef("acme/web", "src/a b", "head1")).toEqual({
      entries: ["users/", "users.test.ts"],
      truncated: false,
    });
    expect(await gh.listDirAtRef("acme/web", "", "head1")).toEqual({ entries: ["README.md"], truncated: false });
    expect(calls).toHaveLength(2);
  });

  it("marks symlinks, and a directory at the contents endpoint's cap as truncated", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}.json`, type: "file" }));
    const { adapter: gh } = adapter([
      { url: /\/contents\/pkgs\?ref=head1$/, body: [{ name: "shared", type: "symlink" }] },
      { url: /\/contents\/fixtures\?ref=head1$/, body: full },
    ]);
    expect(await gh.listDirAtRef("acme/web", "pkgs", "head1")).toEqual({ entries: ["shared@"], truncated: false });
    const listing = await gh.listDirAtRef("acme/web", "fixtures", "head1");
    expect(listing?.entries).toHaveLength(1000);
    expect(listing?.truncated).toBe(true);
  });

  it("returns null when listing a file or a missing directory", async () => {
    const { adapter: gh } = adapter([
      { url: /\/contents\/src\/a\.ts\?ref=head1$/, body: { name: "a.ts", type: "file" } },
      { url: /\/contents\/gone\?ref=head1$/, status: 404, body: { message: "Not Found" } },
    ]);
    expect(await gh.listDirAtRef("acme/web", "src/a.ts", "head1")).toBeNull();
    expect(await gh.listDirAtRef("acme/web", "gone", "head1")).toBeNull();
  });

  it("surfaces forge failures with their status", async () => {
    const { adapter: gh } = adapter([
      { url: /\/pulls\/1$/, status: 403, body: { message: "Resource not accessible" } },
    ]);
    await expect(gh.getChange("acme/web", 1)).rejects.toMatchObject({
      constructor: ForgeError,
      status: 403,
      rateLimited: false,
    });
  });

  it("marks a 403 for an exhausted rate limit, which is not a refused token", async () => {
    const { adapter: gh } = adapter([
      { url: /\/pulls\/1$/, status: 403, headers: { "x-ratelimit-remaining": "0" }, body: { message: "Forbidden" } },
      { url: /\/pulls\/2$/, status: 403, headers: { "retry-after": "60" }, body: { message: "Forbidden" } },
      { url: /\/pulls\/3$/, status: 403, body: { message: "You have exceeded a secondary rate limit." } },
    ]);
    for (const number of [1, 2, 3]) {
      await expect(gh.getChange("acme/web", number)).rejects.toMatchObject({ status: 403, rateLimited: true });
    }
  });

  it("reads a pull request's head and base without its files", async () => {
    const { adapter: gh, calls } = adapter([
      { url: /\/pulls\/42$/, body: { title: "t", state: "open", base: { sha: "b", ref: "main" }, head: { sha: "h", ref: "f" } } },
    ]);
    expect(await gh.getChangeHead("acme/web", 42)).toEqual({ headSha: "h", baseSha: "b", title: "t", state: "open", isDraft: false });
    expect(calls).toHaveLength(1);
  });

  it("refuses a pagination link to another host", async () => {
    const { adapter: gh, calls } = adapter([
      { url: /\/pulls\/42$/, body: { title: "t", body: null, base: { sha: "b", ref: "main" }, head: { sha: "h", ref: "f" } } },
      {
        url: /api\.github\.com\/repos\/acme\/web\/pulls\/42\/files/,
        body: [{ filename: "a.ts", status: "modified", patch: PATCH, changes: 1 }],
        headers: { link: '<http://169.254.169.254/latest/meta-data?page=2>; rel="next"' },
      },
      { url: /169\.254\.169\.254/, body: [] },
    ]);
    await expect(gh.getChange("acme/web", 42)).rejects.toThrow(/another host \(http:\/\/169\.254\.169\.254\)/);
    expect(calls.some((call) => call.url.includes("169.254.169.254"))).toBe(false);
  });

  it("follows a redirect on the same host, with the token", async () => {
    const { adapter: gh, calls } = adapter([
      {
        url: /\/repos\/acme\/web\/contents\/a\.ts\?ref=main$/,
        status: 301,
        body: "",
        headers: { location: "https://api.github.com/repositories/7/contents/a.ts?ref=main" },
      },
      { url: /\/repositories\/7\/contents\/a\.ts\?ref=main$/, body: "export {}" },
    ]);
    expect(await gh.getFileAtRef("acme/web", "a.ts", "main")).toBe("export {}");
    expect(calls[1]!.headers.authorization).toBe(calls[0]!.headers.authorization);
  });

  it("refuses a redirect to another host", async () => {
    const { adapter: gh, calls } = adapter([
      {
        url: /\/contents\/a\.ts\?ref=main$/,
        status: 302,
        body: "",
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      },
      { url: /169\.254\.169\.254/, body: "secret" },
    ]);
    await expect(gh.getFileAtRef("acme/web", "a.ts", "main")).rejects.toMatchObject({
      constructor: ForgeError,
      status: 502,
    });
    expect(calls).toHaveLength(1);
  });

  it("lists installation repositories", async () => {
    const { adapter: gh } = adapter([
      {
        url: /\/installation\/repositories/,
        body: {
          repositories: [
            { id: 9, full_name: "acme/web", default_branch: "main", private: true, html_url: "u" },
          ],
        },
      },
    ]);
    expect(await gh.listRepos()).toEqual([
      { externalId: "9", fullPath: "acme/web", defaultBranch: "main", private: true, webUrl: "u" },
    ]);
  });

  it("lists the user's repositories for a token connection", async () => {
    const stub = fetchStub([
      {
        url: /\/user\/repos\?per_page=100&affiliation=/,
        body: [{ id: 9, full_name: "acme/web", default_branch: "main", private: false, html_url: "u" }],
      },
    ]);
    const gh = new GitHubAdapter({ host: "ghe.acme.com", token: async () => "tok", repoSource: "user", fetch: stub.fetch });

    expect(await gh.listRepos()).toEqual([
      { externalId: "9", fullPath: "acme/web", defaultBranch: "main", private: false, webUrl: "u" },
    ]);
    expect(stub.calls[0]!.url).toMatch(/^https:\/\/ghe\.acme\.com\/api\/v3\/user\/repos/);
  });

  it("lists open pull requests, most recently updated first", async () => {
    const pull = (number: number, draft = false) => ({
      number,
      title: `PR ${number}`,
      draft,
      state: "open",
      html_url: `https://github.com/acme/web/pull/${number}`,
      updated_at: "2026-10-01T00:00:00Z",
      user: { login: "dev" },
      base: { sha: "b", ref: "main" },
      head: { sha: `h${number}`, ref: `feature-${number}` },
    });
    const { adapter: gh, calls } = adapter([
      {
        url: /\/repos\/acme\/web\/pulls\?state=open&sort=updated&direction=desc&per_page=100$/,
        body: [pull(3)],
        headers: { link: '<https://api.github.com/repos/acme/web/pulls?state=open&page=2>; rel="next"' },
      },
      { url: /\/repos\/acme\/web\/pulls\?state=open&page=2$/, body: [pull(2, true)] },
    ]);

    expect(await gh.listOpenChanges("acme/web")).toEqual([
      {
        number: 3,
        title: "PR 3",
        author: "dev",
        isDraft: false,
        headSha: "h3",
        sourceBranch: "feature-3",
        targetBranch: "main",
        webUrl: "https://github.com/acme/web/pull/3",
        updatedAt: "2026-10-01T00:00:00Z",
      },
      expect.objectContaining({ number: 2, isDraft: true }),
    ]);
    expect(calls).toHaveLength(2);
  });

  it("finds a repository hook by callback URL, creates one and tolerates deleting one that is gone", async () => {
    const repo = { externalId: "9", fullPath: "acme/web" };
    const { adapter: gh, calls } = adapter([
      {
        url: /\/repos\/acme\/web\/hooks\?per_page=100$/,
        body: [{ id: 70, config: { url: "https://elsewhere.example.com/hook" } }],
        headers: { link: '<https://api.github.com/repos/acme/web/hooks?per_page=100&page=2>; rel="next"' },
      },
      {
        url: /\/repos\/acme\/web\/hooks\?per_page=100&page=2$/,
        body: [{ id: 77, config: { url: "https://sentryward.example.com/hook" } }],
      },
      { method: "POST", url: /\/repos\/acme\/web\/hooks$/, body: { id: 78 } },
      { method: "DELETE", url: /\/repos\/acme\/web\/hooks\/78$/, status: 404, body: { message: "Not Found" } },
    ]);

    expect(await gh.findHook(repo, "https://sentryward.example.com/hook")).toBe("77");
    expect(await gh.createHook(repo, "https://sentryward.example.com/hook", "s3cret")).toBe("78");
    expect(JSON.parse(calls[2]!.body!)).toMatchObject({
      events: ["pull_request", "issue_comment", "pull_request_review_comment"],
      config: { url: "https://sentryward.example.com/hook", secret: "s3cret", content_type: "json" },
    });
    await expect(gh.deleteHook(repo, "78")).resolves.toBeUndefined();
  });

  it("reads a thread's root comment and replies in the thread", async () => {
    const stub = fetchStub([
      { url: /\/repos\/acme\/web\/pulls\/comments\/700$/, body: { id: 700, body: "x\n<!-- sentryward:fp=0123456789abcdef -->", user: { login: "bot[bot]" } } },
      { url: /\/repos\/acme\/web\/pulls\/comments\/404$/, status: 404, body: { message: "Not Found" } },
      { method: "POST", url: /\/repos\/acme\/web\/pulls\/42\/comments\/700\/replies$/, body: { id: 702 } },
    ]);
    const gh = new GitHubAdapter({ host: "github.com", token: async () => "tok", fetch: stub.fetch, selfLogin: "bot[bot]" });
    const target = { project: "acme/web", number: 42 };

    expect(await gh.getThreadRoot(target, "700")).toEqual({ ownedBySelf: true, fingerprint: "0123456789abcdef" });
    expect(await gh.getThreadRoot(target, "404")).toBeNull();
    expect(await gh.replyToThread(target, "700", "Because.")).toBe("702");
    expect(JSON.parse(stub.calls.at(-1)!.body!)).toEqual({ body: "Because." });
    expect(gh.isSelfLogin("bot[bot]")).toBe(true);
    expect(gh.isSelfLogin("alice")).toBe(false);
  });

  describe("getChangeDetails", () => {
    const PULL = /\/repos\/acme\/web\/pulls\/7$/;
    const user = (login: string) => ({ login, avatar_url: `https://a/${login}.png`, html_url: `https://github.com/${login}` });
    const pull = (over: Record<string, unknown>) => ({
      number: 7, title: "T", body: null, html_url: "u", state: "open", draft: false,
      base: { sha: "b", ref: "main" }, head: { sha: "h", ref: "f" },
      user: user("dev"), created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-02T10:00:00Z", ...over,
    });

    it("names the author and dates of an open pull request", async () => {
      const { adapter: gh } = adapter([{ url: PULL, body: pull({ draft: true }) }]);
      expect(await gh.getChangeDetails("acme/web", 7)).toEqual({
        state: "open",
        isDraft: true,
        sourceBranch: "f",
        targetBranch: "main",
        author: { login: "dev", avatarUrl: "https://a/dev.png", webUrl: "https://github.com/dev" },
        createdAt: "2026-11-01T10:00:00Z",
        updatedAt: "2026-11-02T10:00:00Z",
      });
    });

    it("says who merged it, and when, without a separate close", async () => {
      const { adapter: gh } = adapter([
        { url: PULL, body: pull({ state: "closed", merged: true, merged_at: "2026-11-03T00:00:00Z", closed_at: "2026-11-03T00:00:00Z", merged_by: user("lead") }) },
      ]);
      const details = await gh.getChangeDetails("acme/web", 7);
      expect(details).toMatchObject({ state: "merged", mergedAt: "2026-11-03T00:00:00Z", mergedBy: { login: "lead" } });
      expect(details).not.toHaveProperty("closedAt");
    });

    it("names a fork's source branch with its owner", async () => {
      const { adapter: gh } = adapter([
        {
          url: PULL,
          body: pull({
            base: { sha: "b", ref: "main", repo: { full_name: "acme/web" } },
            head: { sha: "h", ref: "fix", label: "someone:fix", repo: { full_name: "someone/web" } },
          }),
        },
      ]);
      expect(await gh.getChangeDetails("acme/web", 7)).toMatchObject({ sourceBranch: "someone:fix", targetBranch: "main" });
    });

    it("keeps a same-repository branch's plain name", async () => {
      const { adapter: gh } = adapter([
        {
          url: PULL,
          body: pull({
            base: { sha: "b", ref: "main", repo: { full_name: "acme/web" } },
            head: { sha: "h", ref: "fix", label: "acme:fix", repo: { full_name: "acme/web" } },
          }),
        },
      ]);
      expect(await gh.getChangeDetails("acme/web", 7)).toMatchObject({ sourceBranch: "fix" });
    });

    it("dates a pull request closed without merging", async () => {
      const { adapter: gh } = adapter([{ url: PULL, body: pull({ state: "closed", merged: false, closed_at: "2026-11-04T00:00:00Z" }) }]);
      expect(await gh.getChangeDetails("acme/web", 7)).toMatchObject({ state: "closed", closedAt: "2026-11-04T00:00:00Z" });
    });
  });

  describe("getDiff", () => {
    const COMPARE = /\/repos\/acme\/web\/compare\/b1\.\.\.h1$/;

    it("maps the compared files with their patches, as a PR's files are", async () => {
      const { adapter: gh } = adapter([
        {
          url: COMPARE,
          body: {
            status: "diverged",
            files: [
              { filename: "src/a.ts", status: "modified", changes: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
              { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", changes: 0 },
              { filename: "logo.png", status: "added", changes: 0 },
              { filename: "big.ts", status: "modified", changes: 9000 },
            ],
          },
        },
      ]);
      const files = await gh.getDiff("acme/web", "b1", "h1");
      expect(files?.map(({ path, previousPath, changeType, patchUnavailable, hunks }) => ({ path, previousPath, changeType, patchUnavailable, hunks: hunks.length }))).toEqual([
        { path: "src/a.ts", previousPath: undefined, changeType: "modified", patchUnavailable: false, hunks: 1 },
        { path: "src/new.ts", previousPath: "src/old.ts", changeType: "renamed", patchUnavailable: false, hunks: 0 },
        { path: "logo.png", previousPath: undefined, changeType: "added", patchUnavailable: false, hunks: 0 },
        { path: "big.ts", previousPath: undefined, changeType: "modified", patchUnavailable: true, hunks: 0 },
      ]);
    });

    it.each([404, 422])("returns null when GitHub answers %i", async (status) => {
      const { adapter: gh } = adapter([{ url: COMPARE, status, body: { message: "No common ancestor" } }]);
      expect(await gh.getDiff("acme/web", "b1", "h1")).toBeNull();
    });

    it("surfaces other failures", async () => {
      const { adapter: gh } = adapter([{ url: COMPARE, status: 502, body: { message: "Bad Gateway" } }]);
      await expect(gh.getDiff("acme/web", "b1", "h1")).rejects.toBeInstanceOf(ForgeError);
    });
  });

  describe("getToolAnnotations", () => {
    const ref = {
      provider: "github" as const,
      host: "github.com",
      project: "acme/web",
      number: 42,
      baseSha: "base1",
      startSha: "base1",
      headSha: "head1",
      webUrl: "https://github.com/acme/web/pull/42",
    };

    it("reads annotations of finished check runs and names running ones", async () => {
      const { adapter: gh, calls } = adapter([
        {
          url: /\/repos\/acme\/web\/commits\/head1\/check-runs\?per_page=100$/,
          body: {
            check_runs: [
              { id: 1, name: "lint", status: "completed", output: { annotations_count: 2 } },
              { id: 2, name: "test", status: "completed", output: { annotations_count: 0 } },
              { id: 3, name: "CodeQL", status: "in_progress", output: { annotations_count: 0 } },
            ],
          },
        },
        {
          url: /\/check-runs\/1\/annotations\?per_page=100$/,
          body: [
            { path: "src/a.ts", start_line: 3, end_line: 3, annotation_level: "failure", title: "no-undef", message: "'x' is not defined." },
            { path: "src/b.ts", start_line: 0, end_line: 0, annotation_level: "notice", title: null, message: "file-level" },
          ],
        },
      ]);
      const results = await gh.getToolAnnotations(ref);
      expect(results.annotations).toEqual([
        {
          tool: "lint",
          file: "src/a.ts",
          startLine: 3,
          endLine: 3,
          severity: "major",
          category: "bug",
          title: "no-undef",
          message: "'x' is not defined.",
        },
      ]);
      expect(results.warnings).toEqual(["Checks still running when the review started were left out: CodeQL"]);
      // No annotations are requested for runs that have none.
      expect(calls.map((call) => call.url).filter((url) => url.includes("/annotations"))).toHaveLength(1);
    });

    it("throws a forbidden answer for the caller to report", async () => {
      const { adapter: gh } = adapter([
        { url: /\/check-runs\?per_page=100$/, status: 403, body: { message: "Resource not accessible by integration" } },
      ]);
      await expect(gh.getToolAnnotations(ref)).rejects.toMatchObject({ constructor: ForgeError, status: 403 });
    });
  });

  describe("compareCommits", () => {
    const COMPARE = /\/repos\/acme\/web\/compare\/h1\.\.\.h2$/;

    it("lists the files changed since an ancestor, with a rename's old path", async () => {
      const { adapter: gh } = adapter([
        {
          url: COMPARE,
          body: {
            status: "ahead",
            files: [{ filename: "src/a.ts" }, { filename: "src/new.ts", previous_filename: "src/old.ts" }],
          },
        },
      ]);
      expect(await gh.compareCommits("acme/web", "h1", "h2")).toEqual(["src/a.ts", "src/new.ts", "src/old.ts"]);
    });

    it("returns an empty list for identical commits", async () => {
      const { adapter: gh } = adapter([{ url: COMPARE, body: { status: "identical", files: [] } }]);
      expect(await gh.compareCommits("acme/web", "h1", "h2")).toEqual([]);
    });

    it.each(["diverged", "behind"])("returns null when the history is %s", async (status) => {
      const { adapter: gh } = adapter([{ url: COMPARE, body: { status, files: [{ filename: "src/a.ts" }] } }]);
      expect(await gh.compareCommits("acme/web", "h1", "h2")).toBeNull();
    });

    it("returns null when a commit is gone", async () => {
      const { adapter: gh } = adapter([{ url: COMPARE, status: 404, body: { message: "Not Found" } }]);
      expect(await gh.compareCommits("acme/web", "h1", "h2")).toBeNull();
    });

    it("returns null when the file list may be cut short", async () => {
      const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.ts` }));
      const { adapter: gh } = adapter([{ url: COMPARE, body: { status: "ahead", files } }]);
      expect(await gh.compareCommits("acme/web", "h1", "h2")).toBeNull();
    });

    it("surfaces other failures", async () => {
      const { adapter: gh } = adapter([{ url: COMPARE, status: 502, body: { message: "Bad Gateway" } }]);
      await expect(gh.compareCommits("acme/web", "h1", "h2")).rejects.toBeInstanceOf(ForgeError);
    });
  });

  describe("searchCode", () => {
    const query = (url: string) => new URL(url).searchParams.get("q");

    it("quotes the term so its qualifiers cannot widen the search beyond the reviewed repository", async () => {
      const { adapter: gh, calls } = adapter([
        { url: /\/search\/code\?q=/, body: { items: [{ path: "src/a.ts" }, { path: "src/a.ts" }] } },
      ]);
      expect(await gh.searchCode("acme/web", "foo repo:other/repo user:attacker", "main")).toEqual(["src/a.ts"]);
      expect(query(calls[0]!.url)).toBe('"foo repo:other/repo user:attacker" repo:acme/web');
    });

    it("keeps qualifiers in any case or after any punctuation inside the quotes", async () => {
      const terms = ["foo REPO:other/x", "foo (repo:other/x)", "foo -repo:acme/web", "foo owner:evil", "foo,org:evil"];
      const { adapter: gh, calls } = adapter([{ url: /\/search\/code\?q=/, body: { items: [] } }]);
      for (const term of terms) await gh.searchCode("acme/web", term, "main");
      expect(calls.map((call) => query(call.url))).toEqual(terms.map((term) => `"${term}" repo:acme/web`));
    });

    it("drops quotes and backslashes the term could use to close the phrase", async () => {
      const { adapter: gh, calls } = adapter([{ url: /\/search\/code\?q=/, body: { items: [] } }]);
      await gh.searchCode("acme/web", 'foo" repo:other/x "bar\\', "main");
      expect(query(calls[0]!.url)).toBe('"foo repo:other/x bar" repo:acme/web');
    });

    it("searches code-like text with colons as written", async () => {
      const { adapter: gh, calls } = adapter([{ url: /\/search\/code\?q=/, body: { items: [] } }]);
      await gh.searchCode("acme/web", "type:module", "main");
      await gh.searchCode("acme/web", "user:id lookup", "main");
      expect(calls.map((call) => query(call.url))).toEqual(['"type:module" repo:acme/web', '"user:id lookup" repo:acme/web']);
    });

    it("finds nothing for a term with nothing left to search, without asking GitHub", async () => {
      const { adapter: gh, calls } = adapter([]);
      expect(await gh.searchCode("acme/web", '""', "main")).toEqual([]);
      expect(await gh.searchCode("acme/web", "  \\ ", "main")).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  describe("quoteCodeSearchTerm", () => {
    it("wraps the term in quotes, collapsing whitespace", () => {
      expect(quoteCodeSearchTerm("read_file")).toBe('"read_file"');
      expect(quoteCodeSearchTerm("  lookup \t repo:evil/org ")).toBe('"lookup repo:evil/org"');
    });

    it("returns null when only quotes, backslashes or whitespace remain", () => {
      expect(quoteCodeSearchTerm('" \\ "')).toBeNull();
    });
  });
});

describe("GitHubApp", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const make = (routes: Parameters<typeof fetchStub>[0]) => {
    const stub = fetchStub(routes);
    const app = new GitHubApp({
      appId: "123",
      privateKey: pem,
      clientId: "cid",
      clientSecret: "secret",
      webOrigin: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      fetch: stub.fetch,
    });
    return { app, ...stub };
  };

  it("signs an RS256 app JWT issued by the app id", () => {
    const { app } = make([]);
    const payload = jwt.verify(app.appJwt(), publicKey, { algorithms: ["RS256"] });
    expect(payload).toMatchObject({ iss: "123" });
  });

  it("caches installation tokens until they near expiry", async () => {
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { app, calls } = make([
      {
        method: "POST",
        url: /\/app\/installations\/7\/access_tokens$/,
        body: { token: "inst-tok", expires_at: expires },
      },
    ]);

    expect(await app.installationToken("7")).toBe("inst-tok");
    expect(await app.installationToken("7")).toBe("inst-tok");
    expect(calls).toHaveLength(1);
  });

  it("refreshes a token about to expire", async () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    const { app, calls } = make([
      {
        method: "POST",
        url: /access_tokens$/,
        body: { token: "inst-tok", expires_at: soon },
      },
    ]);

    await app.installationToken("7");
    await app.installationToken("7");
    expect(calls).toHaveLength(2);
  });

  it("accepts an installation only when the OAuth user can see it", async () => {
    const routes = [
      { method: "POST", url: /\/login\/oauth\/access_token$/, body: { access_token: "user-tok" } },
      { url: /\/user\/installations/, body: { installations: [{ id: 7 }, { id: 8 }] } },
    ];
    expect(await make(routes).app.userHasInstallation("code", "7")).toBe(true);
    expect(await make(routes).app.userHasInstallation("code", "99")).toBe(false);
  });

  it("rejects a bad OAuth code", async () => {
    const { app } = make([
      { method: "POST", url: /\/login\/oauth\/access_token$/, body: { error: "bad_verification_code" } },
    ]);
    expect(await app.userHasInstallation("nope", "7")).toBe(false);
  });

  it("uses /api/v3 for GitHub Enterprise Server", () => {
    expect(githubApiBase("github.com")).toBe("https://api.github.com");
    expect(githubApiBase("ghe.acme.com")).toBe("https://ghe.acme.com/api/v3");
  });
});

describe("GitLabAdapter", () => {
  const adapter = (routes: Parameters<typeof fetchStub>[0], host = "gitlab.acme.com") => {
    const stub = fetchStub(routes);
    return { ...stub, adapter: new GitLabAdapter({ host, token: async () => "glpat", fetch: stub.fetch }) };
  };

  it("finds a project hook by callback URL across pages", async () => {
    const repo = { externalId: "9", fullPath: "acme/web" };
    const { adapter: gl, calls } = adapter([
      {
        url: /\/projects\/9\/hooks\?per_page=100$/,
        body: [{ id: 70, url: "https://elsewhere.example.com/hook" }],
        headers: { "x-next-page": "2" },
      },
      {
        url: /\/projects\/9\/hooks\?per_page=100&page=2$/,
        body: [{ id: 77, url: "https://sentryward.example.com/hook" }],
      },
      { method: "POST", url: /\/projects\/9\/hooks$/, body: { id: 78 } },
      { method: "DELETE", url: /\/projects\/9\/hooks\/78$/, status: 404, body: { message: "Not Found" } },
    ]);

    expect(await gl.findHook(repo, "https://sentryward.example.com/hook")).toBe("77");
    expect(await gl.createHook(repo, "https://sentryward.example.com/hook", "s3cret")).toBe("78");
    expect(JSON.parse(calls[2]!.body!)).toMatchObject({ url: "https://sentryward.example.com/hook", token: "s3cret" });
    await expect(gl.deleteHook(repo, "78")).resolves.toBeUndefined();
  });

  it("reads a merge request's head and base, falling back to its target branch", async () => {
    let refs: unknown = { base_sha: "b", start_sha: "s", head_sha: "h" };
    const { adapter: gl } = adapter([
      {
        url: /\/merge_requests\/7$/,
        get body() {
          return { iid: 7, title: "t", state: "opened", sha: "h", target_branch: "main", diff_refs: refs };
        },
      },
    ]);
    expect(await gl.getChangeHead("team/app", 7)).toMatchObject({ headSha: "h", baseSha: "b", state: "open" });
    // Just opened: GitLab has not computed the diff yet.
    refs = null;
    expect(await gl.getChangeHead("team/app", 7)).toMatchObject({ headSha: "h", baseSha: "main" });
  });

  it("lists open merge requests by iid", async () => {
    const { adapter: gl, calls } = adapter([
      {
        url: /\/projects\/team%2Fapp\/merge_requests\?state=opened&order_by=updated_at&sort=desc&per_page=100$/,
        body: [
          {
            iid: 7,
            title: "Draft: thing",
            work_in_progress: true,
            sha: "h7",
            state: "opened",
            web_url: "https://gitlab.acme.com/team/app/-/merge_requests/7",
            updated_at: "2026-10-01T00:00:00Z",
            author: { username: "dev" },
            source_branch: "feature",
            target_branch: "main",
          },
        ],
        headers: { "x-next-page": "" },
      },
    ]);

    expect(await gl.listOpenChanges("team/app")).toEqual([
      {
        number: 7,
        title: "Draft: thing",
        author: "dev",
        isDraft: true,
        headSha: "h7",
        sourceBranch: "feature",
        targetBranch: "main",
        webUrl: "https://gitlab.acme.com/team/app/-/merge_requests/7",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("builds a ChangeSet with GitLab's diff refs and follows x-next-page", async () => {
    const { adapter: gl, calls } = adapter([
      {
        url: /\/projects\/team%2Fapp\/merge_requests\/7$/,
        body: {
          title: "Draft: thing",
          description: "Closes #1",
          draft: true,
          web_url: "https://gitlab.acme.com/team/app/-/merge_requests/7",
          author: { username: "ada", id: 31 },
          source_branch: "feature",
          target_branch: "main",
          diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" },
        },
      },
      {
        url: /\/merge_requests\/7\/diffs\?per_page=100$/,
        headers: { "x-next-page": "2" },
        body: [
          {
            old_path: "a.ts",
            new_path: "a.ts",
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            diff: PATCH,
          },
        ],
      },
      {
        url: /\/merge_requests\/7\/diffs\?per_page=100&page=2$/,
        headers: { "x-next-page": "" },
        body: [
          {
            old_path: "gone.ts",
            new_path: "gone.ts",
            new_file: false,
            renamed_file: false,
            deleted_file: true,
            diff: "@@ -1 +0,0 @@\n-x",
          },
          {
            old_path: "big.sql",
            new_path: "big.sql",
            new_file: true,
            renamed_file: false,
            deleted_file: false,
            diff: "",
            too_large: true,
          },
        ],
      },
    ]);

    const change = await gl.getChange("team/app", 7);

    expect(change.forgeRef).toMatchObject({ baseSha: "b", startSha: "s", headSha: "h", host: "gitlab.acme.com" });
    expect(change).toMatchObject({ isDraft: true, description: "Closes #1", baseRef: "main", author: "ada", authorId: "31" });
    expect(change.files.map((f) => [f.path, f.changeType, f.patchUnavailable])).toEqual([
      ["a.ts", "modified", false],
      ["gone.ts", "deleted", false],
      ["big.sql", "added", true],
    ]);
    expect(calls[0]!.url.startsWith("https://gitlab.acme.com/api/v4/")).toBe(true);
    expect(calls[0]!.headers["private-token"]).toBe("glpat");
  });

  const MR_7 = {
    url: /\/projects\/team%2Fapp\/merge_requests\/7$/,
    body: {
      title: "t",
      description: null,
      web_url: "u",
      source_branch: "f",
      target_branch: "m",
      diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" },
    },
  };

  it("falls back to /changes when /diffs is missing (GitLab < 15.7)", async () => {
    const { adapter: gl, calls } = adapter([
      MR_7,
      { url: /\/merge_requests\/7\/diffs\?per_page=100$/, status: 404, body: { message: "404 Not Found" } },
      {
        url: /\/merge_requests\/7\/changes$/,
        body: {
          changes: [
            { old_path: "a.ts", new_path: "a.ts", new_file: false, renamed_file: false, deleted_file: false, diff: PATCH },
            {
              old_path: "big.sql",
              new_path: "big.sql",
              new_file: true,
              renamed_file: false,
              deleted_file: false,
              diff: "",
              too_large: true,
            },
          ],
        },
      },
    ]);

    const change = await gl.getChange("team/app", 7);

    expect(change.files.map((f) => [f.path, f.changeType, f.patchUnavailable])).toEqual([
      ["a.ts", "modified", false],
      ["big.sql", "added", true],
    ]);
    expect(calls.map((c) => c.url.replace(/^.*\/merge_requests\/7/, ""))).toEqual(["", "/diffs?per_page=100", "/changes"]);
  });

  it("does not fall back on non-404 diff errors", async () => {
    const { adapter: gl, calls } = adapter([
      MR_7,
      { url: /\/merge_requests\/7\/diffs\?per_page=100$/, status: 500, body: { message: "boom" } },
    ]);

    await expect(gl.getChange("team/app", 7)).rejects.toThrow(/failed \(500\)/);
    expect(calls.some((c) => c.url.endsWith("/changes"))).toBe(false);
  });

  it("refuses a merge request with no diff yet", async () => {
    const { adapter: gl } = adapter([
      {
        url: /\/merge_requests\/7$/,
        body: { title: "t", description: null, web_url: "u", source_branch: "f", target_branch: "m", diff_refs: null },
      },
    ]);
    await expect(gl.getChange("team/app", 7)).rejects.toThrow(/no diff/);
  });

  it("keeps a plain-http host's scheme", async () => {
    const { adapter: gl, calls } = adapter([{ url: /\/user$/, body: { username: "dev" } }], "http://gl.local:8080");
    expect(await gl.currentAccount()).toEqual({ login: "dev" });
    expect(calls[0]!.url).toBe("http://gl.local:8080/api/v4/user");
  });

  it("returns null for a file missing at a ref", async () => {
    const { adapter: gl, calls } = adapter([
      { url: /\/repository\/files\/config%2F\.sentryward\.yaml\/raw\?ref=b$/, status: 404, body: {} },
    ]);
    expect(await gl.getFileAtRef("team/app", "config/.sentryward.yaml", "b")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("lists a directory's tree at a ref, marking subdirectories", async () => {
    const { adapter: gl, calls } = adapter([
      {
        url: /\/repository\/tree\?path=src%2Fusers&ref=h1&per_page=100$/,
        body: [
          { name: "models", type: "tree", mode: "040000" },
          { name: "index.ts", type: "blob", mode: "100644" },
          { name: "shared", type: "blob", mode: "120000" },
        ],
      },
      { url: /\/repository\/tree\?ref=h1&per_page=100$/, body: [{ name: "src", type: "tree", mode: "040000" }] },
    ]);
    expect(await gl.listDirAtRef("team/app", "src/users", "h1")).toEqual({
      entries: ["models/", "index.ts", "shared@"],
      truncated: false,
    });
    expect(await gl.listDirAtRef("team/app", "", "h1")).toEqual({ entries: ["src/"], truncated: false });
    expect(calls).toHaveLength(2);
  });

  it("fetches one page of a directory and marks it truncated when there are more", async () => {
    const { adapter: gl, calls } = adapter([
      {
        url: /\/repository\/tree\?path=tests&ref=h1&per_page=100$/,
        headers: { "x-next-page": "2" },
        body: [{ name: "a.test.ts", type: "blob", mode: "100644" }],
      },
    ]);
    expect(await gl.listDirAtRef("team/app", "tests", "h1")).toEqual({ entries: ["a.test.ts"], truncated: true });
    expect(calls).toHaveLength(1);
  });

  it("returns null when listing a file or a missing directory", async () => {
    const { adapter: gl } = adapter([
      { url: /\/repository\/tree\?path=src%2Fa\.ts&/, body: [] },
      { url: /\/repository\/tree\?path=gone&/, status: 404, body: { message: "404 Tree Not Found" } },
    ]);
    expect(await gl.listDirAtRef("team/app", "src/a.ts", "h1")).toBeNull();
    expect(await gl.listDirAtRef("team/app", "gone", "h1")).toBeNull();
  });

  describe("getChangeDetails", () => {
    const MR = /\/projects\/team%2Fapp\/merge_requests\/7$/;
    const user = (username: string) => ({ username, name: username.toUpperCase(), avatar_url: `https://a/${username}.png`, web_url: `https://gl/${username}` });
    const mr = (over: Record<string, unknown>) => ({
      iid: 7, title: "T", description: null, web_url: "u", state: "opened", sha: "h",
      source_branch: "f", target_branch: "main", diff_refs: null,
      author: user("dev"), created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-02T10:00:00Z", ...over,
    });

    it("names the author and dates of an open merge request", async () => {
      const { adapter: gl } = adapter([{ url: MR, body: mr({}) }]);
      expect(await gl.getChangeDetails("team/app", 7)).toEqual({
        state: "open",
        isDraft: false,
        sourceBranch: "f",
        targetBranch: "main",
        author: { login: "dev", name: "DEV", avatarUrl: "https://a/dev.png", webUrl: "https://gl/dev" },
        createdAt: "2026-11-01T10:00:00Z",
        updatedAt: "2026-11-02T10:00:00Z",
      });
    });

    it("prefers merge_user over the deprecated merged_by", async () => {
      const { adapter: gl } = adapter([
        { url: MR, body: mr({ state: "merged", merged_at: "2026-11-03T00:00:00Z", merge_user: user("lead"), merged_by: user("old") }) },
      ]);
      expect(await gl.getChangeDetails("team/app", 7)).toMatchObject({ state: "merged", mergedAt: "2026-11-03T00:00:00Z", mergedBy: { login: "lead" } });
    });

    it("falls back to merged_by on older instances", async () => {
      const { adapter: gl } = adapter([{ url: MR, body: mr({ state: "merged", merged_at: "2026-11-03T00:00:00Z", merged_by: user("old") }) }]);
      expect(await gl.getChangeDetails("team/app", 7)).toMatchObject({ mergedBy: { login: "old" } });
    });

    it("says who closed it, and when", async () => {
      const { adapter: gl } = adapter([{ url: MR, body: mr({ state: "closed", closed_at: "2026-11-04T00:00:00Z", closed_by: user("lead") }) }]);
      expect(await gl.getChangeDetails("team/app", 7)).toMatchObject({ state: "closed", closedAt: "2026-11-04T00:00:00Z", closedBy: { login: "lead" } });
    });
  });

  describe("getDiff", () => {
    const COMPARE = /\/repository\/compare\?from=b1&to=h1$/;

    it("maps the compared diffs with their patches, as an MR's diffs are", async () => {
      const { adapter: gl } = adapter([
        {
          url: COMPARE,
          body: {
            diffs: [
              { old_path: "a.ts", new_path: "a.ts", new_file: false, renamed_file: false, deleted_file: false, diff: "@@ -1 +1 @@\n-a\n+b\n" },
              { old_path: "gone.ts", new_path: "gone.ts", new_file: false, renamed_file: false, deleted_file: true, diff: "@@ -1 +0,0 @@\n-x\n" },
              { old_path: "huge.ts", new_path: "huge.ts", new_file: true, renamed_file: false, deleted_file: false, diff: "", too_large: true },
            ],
          },
        },
      ]);
      const files = await gl.getDiff("team/app", "b1", "h1");
      expect(files?.map(({ path, changeType, patchUnavailable, hunks }) => ({ path, changeType, patchUnavailable, hunks: hunks.length }))).toEqual([
        { path: "a.ts", changeType: "modified", patchUnavailable: false, hunks: 1 },
        { path: "gone.ts", changeType: "deleted", patchUnavailable: false, hunks: 1 },
        { path: "huge.ts", changeType: "added", patchUnavailable: true, hunks: 0 },
      ]);
    });

    it.each([400, 404])("returns null when GitLab answers %i", async (status) => {
      const { adapter: gl } = adapter([{ url: COMPARE, status, body: { message: "Could not find ref" } }]);
      expect(await gl.getDiff("team/app", "b1", "h1")).toBeNull();
    });

    it("returns null when GitLab timed out computing the diff", async () => {
      const { adapter: gl } = adapter([{ url: COMPARE, body: { diffs: [], compare_timeout: true } }]);
      expect(await gl.getDiff("team/app", "b1", "h1")).toBeNull();
    });
  });

  describe("getToolAnnotations", () => {
    const ref = {
      provider: "gitlab" as const,
      host: "gitlab.acme.com",
      project: "team/app",
      number: 7,
      baseSha: "b",
      startSha: "b",
      headSha: "h7",
      webUrl: "https://gitlab.acme.com/team/app/-/merge_requests/7",
    };

    it("reads Code Quality and SAST reports from the head pipeline", async () => {
      const { adapter: gl } = adapter([
        {
          url: /\/merge_requests\/7\/pipelines\?per_page=20$/,
          body: [
            { id: 99, sha: "h7" },
            { id: 98, sha: "old" },
          ],
        },
        {
          url: /\/pipelines\/99\/jobs\?per_page=100$/,
          body: [
            { id: 1, name: "code_quality", status: "success", artifacts: [{ file_type: "archive" }, { file_type: "codequality" }] },
            { id: 2, name: "semgrep-sast", status: "success", artifacts: [{ file_type: "sast" }] },
            { id: 3, name: "test", status: "success", artifacts: [] },
          ],
        },
        {
          url: /\/jobs\/1\/artifacts\/gl-code-quality-report\.json$/,
          body: [
            {
              description: "Unused variable 'c'.",
              check_name: "no-unused-vars",
              severity: "minor",
              engine_name: "eslint",
              location: { path: "src/a.ts", lines: { begin: 4 } },
            },
          ],
        },
        { url: /\/jobs\/2\/artifacts\/gl-sast-report\.json$/, status: 404, body: { message: "404 Not Found" } },
      ]);
      const results = await gl.getToolAnnotations(ref);
      expect(results.annotations).toEqual([
        {
          tool: "eslint",
          file: "src/a.ts",
          startLine: 4,
          endLine: 4,
          severity: "minor",
          category: "maintainability",
          ruleId: "no-unused-vars",
          title: "Unused variable 'c'.",
          message: "Unused variable 'c'.",
        },
      ]);
      expect(results.warnings).toEqual([
        'The sast report of job "semgrep-sast" could not be downloaded; list gl-sast-report.json under artifacts:paths as well as artifacts:reports',
      ]);
    });

    it("finds nothing without a pipeline for the head commit", async () => {
      const { adapter: gl, calls } = adapter([{ url: /\/merge_requests\/7\/pipelines/, body: [{ id: 98, sha: "old" }] }]);
      expect(await gl.getToolAnnotations(ref)).toEqual({ annotations: [], warnings: [] });
      expect(calls).toHaveLength(1);
    });
  });

  describe("compareCommits", () => {
    const MERGE_BASE = /\/repository\/merge_base\?refs\[\]=h1&refs\[\]=h2$/;
    const COMPARE = /\/repository\/compare\?from=h1&to=h2$/;

    it("lists the files changed since an ancestor, old and new paths", async () => {
      const { adapter: gl } = adapter([
        { url: MERGE_BASE, body: { id: "h1" } },
        {
          url: COMPARE,
          body: {
            diffs: [
              { old_path: "src/a.ts", new_path: "src/a.ts" },
              { old_path: "src/old.ts", new_path: "src/new.ts" },
            ],
          },
        },
      ]);
      expect(await gl.compareCommits("team/app", "h1", "h2")).toEqual(["src/a.ts", "src/new.ts", "src/old.ts"]);
    });

    it("returns null when the old head is not an ancestor, without comparing", async () => {
      const { adapter: gl, calls } = adapter([{ url: MERGE_BASE, body: { id: "other" } }]);
      expect(await gl.compareCommits("team/app", "h1", "h2")).toBeNull();
      expect(calls).toHaveLength(1);
    });

    it.each([400, 404])("returns null when the merge base answers %i", async (status) => {
      const { adapter: gl } = adapter([{ url: MERGE_BASE, status, body: { message: "Could not find ref: h1" } }]);
      expect(await gl.compareCommits("team/app", "h1", "h2")).toBeNull();
    });

    it("returns null when GitLab timed out computing the diff", async () => {
      const { adapter: gl } = adapter([
        { url: MERGE_BASE, body: { id: "h1" } },
        { url: COMPARE, body: { diffs: [{ old_path: "a", new_path: "a" }], compare_timeout: true } },
      ]);
      expect(await gl.compareCommits("team/app", "h1", "h2")).toBeNull();
    });

    it("surfaces a failed comparison", async () => {
      const { adapter: gl } = adapter([
        { url: MERGE_BASE, body: { id: "h1" } },
        { url: COMPARE, status: 502, body: {} },
      ]);
      await expect(gl.compareCommits("team/app", "h1", "h2")).rejects.toBeInstanceOf(ForgeError);
    });
  });

  it("reads a discussion's first note and replies in the discussion", async () => {
    const stub = fetchStub([
      {
        url: /\/projects\/team%2Fapp\/merge_requests\/7\/discussions\/d1$/,
        body: {
          id: "d1",
          notes: [
            { id: 1, body: "x\n<!-- sentryward:fp=0123456789abcdef -->", system: false, author: { username: "alice" } },
            { id: 2, body: "?", system: false, author: { username: "bot" } },
          ],
        },
      },
      { method: "POST", url: /\/projects\/team%2Fapp\/merge_requests\/7\/discussions\/d1\/notes$/, body: { id: 3 } },
    ]);
    const gl = new GitLabAdapter({ host: "gitlab.acme.com", token: async () => "glpat", fetch: stub.fetch, selfLogin: "bot" });
    const target = { project: "team/app", number: 7 };

    // Only the first note decides whose thread it is.
    expect(await gl.getThreadRoot(target, "d1")).toEqual({ ownedBySelf: false, fingerprint: "0123456789abcdef" });
    expect(await gl.replyToThread(target, "d1", "Because.")).toBe("3");
    expect(JSON.parse(stub.calls.at(-1)!.body!)).toEqual({ body: "Because." });
  });
});
