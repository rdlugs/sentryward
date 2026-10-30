import type { DirListing } from "../context/gather.ts";
import { markersIn, SUMMARY_MARKER, withoutDescriptionBlock } from "../core/markers.ts";
import type { ChangeSet, ChangeType, ForgeRef, IssueContext } from "../core/models.ts";
import { toChangedFile } from "../diff/parse.ts";
import { ForgeError, ForgeHttp, isNotFound, linkHeaderNext, type FetchLike } from "./http.ts";
import { cacheKey, cached, type ForgeCache } from "./cache.ts";
import { githubApiBase } from "./githubApp.ts";
import { closingIssueNumbers, MAX_CANDIDATE_ISSUES } from "./issues.ts";
import { fromGitHubAnnotation, MAX_TOOL_ANNOTATIONS, type GhAnnotation, type ToolResults } from "./toolResults.ts";
import {
  hostOrigin,
  STATUS_CONTEXT,
  MAX_OPEN_CHANGE_PAGES,
  MAX_CODE_SEARCH_RESULTS,
  MAX_COMPARE_FILES,
  type ChangeHead,
  type ChangeSummary,
  type CommitStatus,
  type ForgeAccount,
  type ForgeAdapter,
  type ForgeHooks,
  type ForgePublisher,
  type ForgeThreads,
  type ForgeRepo,
  type HookTarget,
  type InlineComment,
  type InlineResult,
  type ThreadResult,
  type ThreadRoot,
  type ThreadTarget,
} from "./types.ts";

export interface GitHubAdapterOptions {
  host: string;
  token: () => Promise<string>;
  // The login Sentryward posts as (an app's is "<slug>[bot]"), used to find its own
  // comments again.
  selfLogin?: string;
  // App installations have no user; their account comes from the installation.
  account?: () => Promise<ForgeAccount>;
  // An app lists the repositories it is installed on; a token lists the user's.
  repoSource?: "installation" | "user";
  fetch?: FetchLike;
}

interface GhRepo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
}

interface GhPull {
  number: number;
  updated_at: string;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  title: string;
  body: string | null;
  draft?: boolean;
  html_url: string;
  user?: { login: string } | null;
  labels?: { name: string }[];
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
}

interface GhFile {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  patch?: string;
  changes: number;
}

interface GhComparison {
  status: "ahead" | "behind" | "diverged" | "identical";
  files?: Pick<GhFile, "filename" | "previous_filename">[];
}

interface GhContentEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

// The contents endpoint returns at most this many entries of a directory.
const GITHUB_DIR_LIMIT = 1000;

// GitHub caps the files endpoint at 3000 files, 100 per page.
const MAX_FILE_PAGES = 30;

interface GhCheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
  output: { annotations_count: number };
}

// A commit rarely has more than a few dozen check runs.
const MAX_CHECK_RUN_PAGES = 3;

function changeTypeOf(status: GhFile["status"]): ChangeType {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

// Encodes each segment, keeping the "/" between them.
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function repoApiPath(project: string): string {
  return `/repos/${encodePath(project)}`;
}

function toRepo(repo: GhRepo): ForgeRepo {
  return {
    externalId: String(repo.id),
    fullPath: repo.full_name,
    defaultBranch: repo.default_branch,
    private: repo.private,
    webUrl: repo.html_url,
  };
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  // Set when the "issue" is a pull request; the issues API returns both.
  pull_request?: unknown;
}

function toIssue(issue: GhIssue): IssueContext {
  return {
    ref: `#${issue.number}`,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    body: issue.body ?? "",
  };
}

interface GhComment {
  id: number;
  body: string;
  user: { login: string } | null;
}

interface GhThread {
  id: string;
  isResolved: boolean;
  resolvedBy: { login: string } | null;
  comments: { nodes: { body: string; author: { login: string } | null }[] };
}

interface GhThreadPage {
  repository: {
    pullRequest: {
      reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GhThread[] };
    } | null;
  } | null;
}

const REVIEW_THREADS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved resolvedBy { login } comments(first: 1) { nodes { body author { login } } } }
      }
    }
  }
}`;

const RESOLVE_THREAD = `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`;
const UNRESOLVE_THREAD = `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }`;

// REST names an app "<slug>[bot]", GraphQL just "<slug>".
function botless(login: string): string {
  return login.replace(/\[bot\]$/, "");
}

function reviewComment(comment: InlineComment) {
  return {
    path: comment.path,
    line: comment.endLine,
    side: "RIGHT" as const,
    ...(comment.endLine > comment.startLine ? { start_line: comment.startLine, start_side: "RIGHT" as const } : {}),
    body: comment.body,
  };
}

export class GitHubAdapter implements ForgeAdapter, ForgePublisher, ForgeHooks, ForgeThreads {
  readonly provider = "github" as const;
  readonly host: string;
  private http: ForgeHttp;

  constructor(private options: GitHubAdapterOptions) {
    this.host = options.host;
    this.http = new ForgeHttp({
      baseUrl: githubApiBase(options.host),
      fetch: options.fetch,
      headers: async () => ({
        Authorization: `Bearer ${await options.token()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
    });
  }

  async currentAccount(): Promise<ForgeAccount> {
    if (this.options.account) {
      return this.options.account();
    }
    const user = await this.http.json<{ login: string }>("/user");
    return { login: user.login };
  }

  async listRepos(): Promise<ForgeRepo[]> {
    if (this.options.repoSource === "user") {
      const repos = await this.http.paginate<GhRepo>(
        "/user/repos?per_page=100&affiliation=owner,collaborator,organization_member",
        linkHeaderNext,
        10,
      );
      return repos.map(toRepo);
    }
    const repos = await this.http.paginate<GhRepo>(
      "/installation/repositories?per_page=100",
      linkHeaderNext,
      10,
      (body) => (body as { repositories: GhRepo[] }).repositories,
    );
    return repos.map(toRepo);
  }

  async getRepo(externalId: string): Promise<ForgeRepo> {
    return toRepo(await this.http.json<GhRepo>(`/repositories/${encodeURIComponent(externalId)}`));
  }

  async getChange(project: string, number: number, cache?: ForgeCache): Promise<ChangeSet> {
    const repoPath = repoApiPath(project);
    const pull = await this.http.json<GhPull>(`${repoPath}/pulls/${number}`);
    // The files of a PR are fixed by its base and head.
    const files = await cached(cache, cacheKey("github-files", this.host, project, number, pull.base.sha, pull.head.sha), () =>
      this.http.paginate<GhFile>(`${repoPath}/pulls/${number}/files?per_page=100`, linkHeaderNext, MAX_FILE_PAGES),
    );

    return {
      forgeRef: {
        provider: "github",
        host: this.host,
        project,
        number,
        baseSha: pull.base.sha,
        startSha: pull.base.sha,
        headSha: pull.head.sha,
        webUrl: pull.html_url,
      },
      title: pull.title,
      description: withoutDescriptionBlock(pull.body ?? ""),
      baseRef: pull.base.ref,
      headRef: pull.head.ref,
      isDraft: pull.draft ?? false,
      author: pull.user?.login,
      labels: (pull.labels ?? []).map((label) => label.name),
      files: files.map((file) =>
        toChangedFile({
          path: file.filename,
          previousPath: file.previous_filename,
          changeType: changeTypeOf(file.status),
          // GitHub omits `patch` for binary files and for oversized diffs; a
          // pure rename or empty file has no changes and so no patch either.
          patch: file.patch ?? (file.changes === 0 ? "" : undefined),
        }),
      ),
    };
  }

  async getChangeHead(project: string, number: number): Promise<ChangeHead> {
    const pull = await this.http.json<GhPull>(`${repoApiPath(project)}/pulls/${number}`);
    const merged = pull.merged ?? Boolean(pull.merged_at);
    return {
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      title: pull.title,
      state: merged ? "merged" : pull.state,
      isDraft: pull.draft ?? false,
    };
  }

  async listOpenChanges(project: string): Promise<ChangeSummary[]> {
    const pulls = await this.http.paginate<GhPull>(
      `${repoApiPath(project)}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
      linkHeaderNext,
      MAX_OPEN_CHANGE_PAGES,
    );
    return pulls.map((pull) => ({
      number: pull.number,
      title: pull.title,
      author: pull.user?.login,
      isDraft: pull.draft ?? false,
      headSha: pull.head.sha,
      sourceBranch: pull.head.ref,
      targetBranch: pull.base.ref,
      webUrl: pull.html_url,
      updatedAt: pull.updated_at,
    }));
  }

  async getFileAtRef(project: string, path: string, ref: string): Promise<string | null> {
    const encodedPath = encodePath(path);
    try {
      const res = await this.http.request(
        `${repoApiPath(project)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        { headers: { Accept: "application/vnd.github.raw+json" } },
      );
      return await res.text();
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  // The contents endpoint answers a directory with an array of its entries
  // (up to GITHUB_DIR_LIMIT, with no sign of how many more) and a file with a
  // single object.
  async listDirAtRef(project: string, path: string, ref: string): Promise<DirListing | null> {
    const encodedPath = path ? `/${encodePath(path)}` : "";
    let body: GhContentEntry[] | GhContentEntry;
    try {
      body = await this.http.json<GhContentEntry[] | GhContentEntry>(
        `${repoApiPath(project)}/contents${encodedPath}?ref=${encodeURIComponent(ref)}`,
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    if (!Array.isArray(body)) return null;
    return {
      entries: body.map((entry) =>
        entry.type === "dir" ? `${entry.name}/` : entry.type === "symlink" ? `${entry.name}@` : entry.name,
      ),
      truncated: body.length >= GITHUB_DIR_LIMIT,
    };
  }

  async getLinkedIssues(change: ChangeSet): Promise<IssueContext[]> {
    const { project, number: self } = change.forgeRef;
    const numbers = closingIssueNumbers(change.description, project, this.host).filter((n) => n !== self);
    const issues = await Promise.all(
      numbers.map((n) =>
        this.http.json<GhIssue>(`${repoApiPath(project)}/issues/${n}`).catch((err: unknown) => {
          // A reference to a missing issue is the author's typo, not a failure.
          if (isNotFound(err)) return null;
          throw err;
        }),
      ),
    );
    return issues.filter((issue): issue is GhIssue => !!issue && !issue.pull_request).map(toIssue);
  }

  // Terms are ORed: a title rarely shares every word with the issue it relates to.
  async searchIssues(project: string, terms: string[]): Promise<IssueContext[]> {
    if (terms.length === 0) return [];
    const query = `repo:${project} is:issue ${terms.join(" OR ")}`;
    const result = await this.http.json<{ items: GhIssue[] }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=${MAX_CANDIDATE_ISSUES}`,
    );
    return result.items.filter((issue) => !issue.pull_request).map(toIssue);
  }

  // GitHub's code search only indexes the default branch, so `ref` cannot be
  // honoured. That suits finding callers: the files a change touches are in
  // its diff, and the rest rarely differ from the default branch.
  async searchCode(project: string, term: string, _ref: string): Promise<string[]> {
    const query = `${term} repo:${project}`;
    const result = await this.http.json<{ items: { path: string }[] }>(
      `/search/code?q=${encodeURIComponent(query)}&per_page=${MAX_CODE_SEARCH_RESULTS}`,
    );
    return [...new Set(result.items.map((item) => item.path))];
  }

  // "ahead" (or "identical") is the only answer in which `from` is an
  // ancestor of `to`; "diverged" and "behind" mean history was rewritten.
  async compareCommits(project: string, from: string, to: string, cache?: ForgeCache): Promise<string[] | null> {
    return cached(cache, cacheKey("github-compare", this.host, project, from, to), async () => {
      let comparison: GhComparison;
      try {
        comparison = await this.http.json<GhComparison>(
          `${repoApiPath(project)}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`,
        );
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      if (comparison.status !== "ahead" && comparison.status !== "identical") return null;
      const files = comparison.files ?? [];
      if (files.length >= MAX_COMPARE_FILES) return null;
      return [...new Set(files.flatMap((file) => (file.previous_filename ? [file.filename, file.previous_filename] : [file.filename])))];
    });
  }

  // Check runs need the Checks (read) permission; without it GitHub answers
  // 403 (or 404 for a token), which the caller reports as a warning. Only
  // finished runs are read: a running one may not have annotated yet.
  async getToolAnnotations(ref: ForgeRef): Promise<ToolResults> {
    const repoPath = repoApiPath(ref.project);
    const runs = await this.http.paginate<GhCheckRun>(
      `${repoPath}/commits/${encodeURIComponent(ref.headSha)}/check-runs?per_page=100`,
      linkHeaderNext,
      MAX_CHECK_RUN_PAGES,
      (body) => (body as { check_runs: GhCheckRun[] }).check_runs,
    );
    const warnings: string[] = [];
    const running = runs.filter((run) => run.status !== "completed");
    if (running.length > 0) {
      const names = running.map((run) => run.name).join(", ");
      warnings.push(`Checks still running when the review started were left out: ${names}`);
    }

    const annotations: ToolResults["annotations"] = [];
    for (const run of runs) {
      if (run.status !== "completed" || run.output.annotations_count === 0) continue;
      if (annotations.length >= MAX_TOOL_ANNOTATIONS) break;
      // The run's name, not its app's: every Actions job belongs to the app
      // "GitHub Actions", while the run is named after the job ("lint",
      // "CodeQL").
      const tool = run.name;
      const pages = Math.ceil(Math.min(run.output.annotations_count, MAX_TOOL_ANNOTATIONS) / 100);
      const found = await this.http.paginate<GhAnnotation>(
        `${repoPath}/check-runs/${run.id}/annotations?per_page=100`,
        linkHeaderNext,
        pages,
      );
      for (const annotation of found) {
        const mapped = fromGitHubAnnotation(tool, annotation);
        if (mapped) annotations.push(mapped);
      }
    }
    return { annotations: annotations.slice(0, MAX_TOOL_ANNOTATIONS), warnings };
  }

  private isSelf(comment: GhComment): boolean {
    return this.isSelfLogin(comment.user?.login);
  }

  isSelfLogin(login: string | undefined): boolean {
    return Boolean(this.options.selfLogin) && login === this.options.selfLogin;
  }

  // GitHub threads are flat: every reply's in_reply_to_id is the root comment.
  async getThreadRoot(target: ThreadTarget, threadId: string): Promise<ThreadRoot | null> {
    try {
      const comment = await this.http.json<GhComment>(
        `${repoApiPath(target.project)}/pulls/comments/${encodeURIComponent(threadId)}`,
      );
      return { ownedBySelf: this.isSelf(comment), fingerprint: markersIn(comment.body)[0] ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async replyToThread(target: ThreadTarget, threadId: string, body: string): Promise<string> {
    const created = await this.http.json<GhComment>(
      `${repoApiPath(target.project)}/pulls/${target.number}/comments/${encodeURIComponent(threadId)}/replies`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    return String(created.id);
  }

  // One review carries every inline comment, posted as COMMENT: Sentryward never
  // approves or requests changes. If GitHub rejects the batch (one bad anchor
  // fails the whole request), each comment is retried on its own so one
  // problem does not lose the rest.
  async postInlineComments(ref: ForgeRef, comments: InlineComment[]): Promise<InlineResult> {
    if (comments.length === 0) return { posted: [], failed: [] };
    const pulls = `${repoApiPath(ref.project)}/pulls/${ref.number}`;
    try {
      const review = await this.http.json<{ id: number }>(`${pulls}/reviews`, {
        method: "POST",
        body: JSON.stringify({ commit_id: ref.headSha, event: "COMMENT", comments: comments.map(reviewComment) }),
      });
      const created = await this.http.paginate<GhComment>(
        `${pulls}/reviews/${review.id}/comments?per_page=100`,
        linkHeaderNext,
      );
      const idByPrint = new Map<string, string>();
      for (const comment of created) {
        for (const print of markersIn(comment.body)) idByPrint.set(print, String(comment.id));
      }
      return {
        posted: comments.map((c) => ({ fingerprint: c.fingerprint, forgeCommentId: idByPrint.get(c.fingerprint) ?? `review:${review.id}` })),
        failed: [],
      };
    } catch (err) {
      if (!(err instanceof ForgeError) || err.status !== 422) throw err;
    }

    const result: InlineResult = { posted: [], failed: [] };
    for (const comment of comments) {
      try {
        const created = await this.http.json<GhComment>(`${pulls}/comments`, {
          method: "POST",
          body: JSON.stringify({ commit_id: ref.headSha, ...reviewComment(comment) }),
        });
        result.posted.push({ fingerprint: comment.fingerprint, forgeCommentId: String(created.id) });
      } catch (err) {
        result.failed.push({ fingerprint: comment.fingerprint, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  async listPostedFingerprints(ref: ForgeRef): Promise<Set<string>> {
    const comments = await this.http.paginate<GhComment>(
      `${repoApiPath(ref.project)}/pulls/${ref.number}/comments?per_page=100`,
      linkHeaderNext,
    );
    return new Set(comments.filter((c) => this.isSelf(c)).flatMap((c) => markersIn(c.body)));
  }

  upsertSummaryComment(ref: ForgeRef, body: string): Promise<string> {
    return this.upsertComment(ref, SUMMARY_MARKER, body);
  }

  async upsertComment(ref: ForgeRef, marker: string, body: string): Promise<string> {
    const issue = `${repoApiPath(ref.project)}/issues/${ref.number}`;
    const comments = await this.http.paginate<GhComment>(`${issue}/comments?per_page=100`, linkHeaderNext);
    const existing = comments.filter((c) => this.isSelf(c) && c.body.includes(marker)).at(-1);
    const saved = existing
      ? await this.http.json<GhComment>(`${repoApiPath(ref.project)}/issues/comments/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        })
      : await this.http.json<GhComment>(`${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    return String(saved.id);
  }

  // Read just before writing so an edit the author made since the change was
  // fetched is kept.
  async updateDescription(ref: ForgeRef, transform: (description: string) => string): Promise<void> {
    const pulls = `${repoApiPath(ref.project)}/pulls/${ref.number}`;
    const pull = await this.http.json<GhPull>(pulls);
    const body = pull.body ?? "";
    const next = transform(body);
    if (next === body) return;
    await this.http.request(pulls, { method: "PATCH", body: JSON.stringify({ body: next }) });
  }

  // Pull request labels live on the issue API.
  async setLabels(ref: ForgeRef, add: string[], remove: string[]): Promise<void> {
    const labels = `${repoApiPath(ref.project)}/issues/${ref.number}/labels`;
    for (const name of remove) {
      try {
        await this.http.request(`${labels}/${encodeURIComponent(name)}`, { method: "DELETE" });
      } catch (err) {
        // Not on the change, which is the usual case.
        if (!isNotFound(err)) throw err;
      }
    }
    if (add.length) await this.http.request(labels, { method: "POST", body: JSON.stringify({ labels: add }) });
  }

  async setCommitStatus(ref: ForgeRef, status: CommitStatus): Promise<void> {
    await this.http.request(`${repoApiPath(ref.project)}/statuses/${ref.headSha}`, {
      method: "POST",
      body: JSON.stringify({
        state: status.state,
        context: STATUS_CONTEXT,
        description: status.description.slice(0, 140),
        ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
      }),
    });
  }

  // Threads can only be resolved through GraphQL. GitHub Enterprise serves it
  // beside the REST API rather than under it.
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const url = this.host === "github.com" ? "/graphql" : `${hostOrigin(this.host)}/api/graphql`;
    const res = await this.http.json<{ data?: T; errors?: { message: string }[] }>(url, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    // GraphQL reports most failures with a 200.
    if (res.errors?.length || !res.data) {
      throw new ForgeError(502, `GraphQL request failed: ${res.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
    }
    return res.data;
  }

  async setThreadsResolved(ref: ForgeRef, fingerprints: string[], resolved: boolean): Promise<ThreadResult> {
    const result: ThreadResult = { updated: [], failed: [] };
    if (fingerprints.length === 0) return result;
    const [owner, name] = ref.project.split("/");
    const self = this.options.selfLogin ? botless(this.options.selfLogin) : undefined;
    const isSelf = (actor: { login: string } | null) => Boolean(self && actor && botless(actor.login) === self);
    const wanted = new Set(fingerprints);
    // Own threads found for a wanted fingerprint, whatever their state, and
    // the ones among them still to move.
    const seen = new Set<string>();
    const threads = new Map<string, string>();
    // Read until every wanted thread is found or the threads run out: a later
    // run starts from the first page again, so stopping at a fixed cap would
    // leave a thread past it out of reach for good.
    let complete = false;
    let after: string | null = null;
    for (;;) {
      const data: GhThreadPage = await this.graphql<GhThreadPage>(REVIEW_THREADS, { owner, name, number: ref.number, after });
      const connection = data.repository?.pullRequest?.reviewThreads;
      for (const thread of connection?.nodes ?? []) {
        const first = thread.comments.nodes[0];
        if (!first || !isSelf(first.author)) continue;
        for (const print of markersIn(first.body)) {
          if (!wanted.has(print)) continue;
          seen.add(print);
          if (thread.isResolved === resolved) continue;
          // Only a thread Sentryward resolved is reopened; one a person
          // resolved stays resolved.
          if (!resolved && !isSelf(thread.resolvedBy)) continue;
          threads.set(print, thread.id);
        }
      }
      if (!connection?.pageInfo.hasNextPage || seen.size === wanted.size) {
        complete = true;
        break;
      }
      // A cursor that does not move would loop forever.
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) break;
      after = connection.pageInfo.endCursor;
    }
    // A thread the listing never reached may still exist; reporting it as
    // failed keeps it pending rather than settled.
    if (!complete) {
      for (const print of wanted) {
        if (!seen.has(print)) result.failed.push({ fingerprint: print, error: "Review thread listing stopped early" });
      }
    }
    for (const [fingerprint, id] of threads) {
      try {
        await this.graphql(resolved ? RESOLVE_THREAD : UNRESOLVE_THREAD, { id });
        result.updated.push(fingerprint);
      } catch (err) {
        result.failed.push({ fingerprint, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  async createHook(repo: HookTarget, url: string, secret: string): Promise<string> {
    const hook = await this.http.json<{ id: number }>(`${repoApiPath(repo.fullPath)}/hooks`, {
      method: "POST",
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["pull_request", "issue_comment", "pull_request_review_comment"],
        config: { url, secret, content_type: "json", insecure_ssl: "0" },
      }),
    });
    return String(hook.id);
  }

  async deleteHook(repo: HookTarget, hookId: string): Promise<void> {
    try {
      await this.http.request(`${repoApiPath(repo.fullPath)}/hooks/${encodeURIComponent(hookId)}`, { method: "DELETE" });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}
