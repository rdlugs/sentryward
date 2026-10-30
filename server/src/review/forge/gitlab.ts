import type { DirListing } from "../context/gather.ts";
import { markersIn, SUMMARY_MARKER, withoutDescriptionBlock } from "../core/markers.ts";
import type { ChangeSet, ChangeType, ForgeRef, IssueContext } from "../core/models.ts";
import { toChangedFile } from "../diff/parse.ts";
import { ForgeError, ForgeHttp, isNotFound, type FetchLike } from "./http.ts";
import { cacheKey, cached, type ForgeCache } from "./cache.ts";
import { MAX_CANDIDATE_ISSUES, MAX_LINKED_ISSUES } from "./issues.ts";
import {
  fromCodeQuality,
  fromSastReport,
  MAX_TOOL_ANNOTATIONS,
  type CodeQualityIssue,
  type SastReport,
  type ToolResults,
} from "./toolResults.ts";
import {
  hostOrigin,
  STATUS_CONTEXT,
  MAX_OPEN_CHANGE_PAGES,
  MAX_CODE_SEARCH_RESULTS,
  type ChangeHead,
  type ChangeSummary,
  type CommitState,
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

export interface GitLabAdapterOptions {
  host: string;
  token: () => Promise<string>;
  // OAuth access tokens go in Authorization; personal, project and group
  // tokens in PRIVATE-TOKEN.
  oauth?: boolean;
  // The username Sentryward posts as (the token's user), to find its own notes.
  selfLogin?: string;
  fetch?: FetchLike;
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  visibility: "private" | "internal" | "public";
  web_url: string;
}

interface GlMergeRequest {
  iid: number;
  updated_at: string;
  state: "opened" | "closed" | "merged" | "locked";
  sha: string;
  title: string;
  description: string | null;
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  author?: { username: string };
  labels?: string[];
  source_branch: string;
  target_branch: string;
  diff_refs: { base_sha: string; start_sha: string; head_sha: string } | null;
}

interface GlDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
  too_large?: boolean;
  collapsed?: boolean;
}

interface GlComparison {
  diffs?: Pick<GlDiff, "old_path" | "new_path">[];
  // Set when GitLab gave up computing the diff; the list is then incomplete.
  compare_timeout?: boolean;
}

interface GlTreeEntry {
  name: string;
  type: "tree" | "blob" | "commit";
  // Git's file mode; a symlink is a blob with mode 120000.
  mode: string;
}

interface GlPipeline {
  id: number;
  sha: string;
}

interface GlJob {
  id: number;
  name: string;
  status: string;
  artifacts?: { file_type: string }[];
}

// The reports Sentryward reads, by artifact type, and where GitLab's own CI
// templates write them. The jobs API serves files from a job's artifacts
// archive only, so a report declared under artifacts:reports alone (and not
// also under artifacts:paths) cannot be downloaded.
const REPORTS = {
  codequality: "gl-code-quality-report.json",
  sast: "gl-sast-report.json",
} as const;

const FINISHED_JOB = new Set(["success", "failed"]);

function changeTypeOf(diff: GlDiff): ChangeType {
  if (diff.new_file) return "added";
  if (diff.deleted_file) return "deleted";
  if (diff.renamed_file) return "renamed";
  return "modified";
}

function toRepo(project: GlProject): ForgeRepo {
  return {
    externalId: String(project.id),
    fullPath: project.path_with_namespace,
    defaultBranch: project.default_branch ?? "main",
    private: project.visibility !== "public",
    webUrl: project.web_url,
  };
}

function nextPage(res: Response, current: string): string | null {
  const next = res.headers.get("x-next-page");
  if (!next) {
    return null;
  }
  const url = new URL(current, "http://placeholder");
  url.searchParams.set("page", next);
  return `${url.pathname}${url.search}`;
}

interface GlIssue {
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  web_url: string;
}

function toIssue(issue: GlIssue): IssueContext {
  return {
    ref: `#${issue.iid}`,
    title: issue.title,
    url: issue.web_url,
    state: issue.state === "closed" ? "closed" : "open",
    body: issue.description ?? "",
  };
}

interface GlNote {
  id: number;
  body: string;
  system: boolean;
  author: { username: string };
  // Set on notes in a resolvable discussion, such as a diff thread.
  resolved?: boolean;
  resolved_by?: { username: string } | null;
}

interface GlDiscussion {
  id: string;
  notes: GlNote[];
}

// GitLab has no "error" state; a review that could not finish fails the check.
const GITLAB_STATE: Record<CommitState, string> = {
  pending: "running",
  success: "success",
  failure: "failed",
  error: "failed",
};

export class GitLabAdapter implements ForgeAdapter, ForgePublisher, ForgeHooks, ForgeThreads {
  readonly provider = "gitlab" as const;
  readonly host: string;
  private http: ForgeHttp;
  private selfLogin: string | undefined;

  constructor(options: GitLabAdapterOptions) {
    this.selfLogin = options.selfLogin;
    this.host = options.host;
    this.http = new ForgeHttp({
      baseUrl: `${hostOrigin(options.host)}/api/v4`,
      fetch: options.fetch,
      headers: async (): Promise<Record<string, string>> =>
        options.oauth
          ? { Authorization: `Bearer ${await options.token()}` }
          : { "PRIVATE-TOKEN": await options.token() },
    });
  }

  private project(project: string): string {
    return `/projects/${encodeURIComponent(project)}`;
  }

  async currentAccount(): Promise<ForgeAccount> {
    const user = await this.http.json<{ username: string }>("/user");
    return { login: user.username };
  }

  async listRepos(): Promise<ForgeRepo[]> {
    // Developer access (30) is the least that can read MRs and post discussions.
    const projects = await this.http.paginate<GlProject>(
      "/projects?membership=true&min_access_level=30&archived=false&per_page=100&order_by=last_activity_at",
      nextPage,
      10,
    );
    return projects.map(toRepo);
  }

  async getRepo(externalId: string): Promise<ForgeRepo> {
    return toRepo(await this.http.json<GlProject>(this.project(externalId)));
  }

  // `/diffs` arrived in GitLab 15.7; older self-managed instances 404 on it.
  // `/changes` (deprecated, still in API v4) returns the same diff objects in
  // one unpaginated response, so fall back to it only on a 404. The MR itself
  // was just fetched, so a 404 here means the route is missing, not the MR.
  private async mergeRequestDiffs(base: string): Promise<GlDiff[]> {
    try {
      return await this.http.paginate<GlDiff>(`${base}/diffs?per_page=100`, nextPage);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const mr = await this.http.json<{ changes?: GlDiff[] }>(`${base}/changes`);
      return mr.changes ?? [];
    }
  }

  async getChange(project: string, number: number, cache?: ForgeCache): Promise<ChangeSet> {
    const base = `${this.project(project)}/merge_requests/${number}`;
    const mr = await this.http.json<GlMergeRequest>(base);
    if (!mr.diff_refs) {
      throw new Error(`Merge request !${number} has no diff yet`);
    }
    const refs = mr.diff_refs;
    // The diffs of an MR are fixed by its diff refs.
    const diffs = await cached(
      cache,
      cacheKey("gitlab-diffs", this.host, project, number, refs.base_sha, refs.start_sha, refs.head_sha),
      () => this.mergeRequestDiffs(base),
    );

    return {
      forgeRef: {
        provider: "gitlab",
        host: this.host,
        project,
        number,
        baseSha: mr.diff_refs.base_sha,
        startSha: mr.diff_refs.start_sha,
        headSha: mr.diff_refs.head_sha,
        webUrl: mr.web_url,
      },
      title: mr.title,
      description: withoutDescriptionBlock(mr.description ?? ""),
      baseRef: mr.target_branch,
      headRef: mr.source_branch,
      isDraft: mr.draft ?? mr.work_in_progress ?? false,
      author: mr.author?.username,
      labels: mr.labels ?? [],
      files: diffs.map((diff) =>
        toChangedFile({
          path: diff.deleted_file ? diff.old_path : diff.new_path,
          previousPath: diff.old_path,
          changeType: changeTypeOf(diff),
          // GitLab empties `diff` and flags it when a file is over its limits.
          patch: diff.too_large || diff.collapsed ? undefined : diff.diff,
        }),
      ),
    };
  }

  async getChangeHead(project: string, number: number): Promise<ChangeHead> {
    const mr = await this.http.json<GlMergeRequest>(`${this.project(project)}/merge_requests/${number}`);
    return {
      headSha: mr.diff_refs?.head_sha ?? mr.sha,
      baseSha: mr.diff_refs?.base_sha ?? mr.target_branch,
      title: mr.title,
      state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open",
      isDraft: mr.draft ?? mr.work_in_progress ?? false,
    };
  }

  async listOpenChanges(project: string): Promise<ChangeSummary[]> {
    const mrs = await this.http.paginate<GlMergeRequest>(
      `${this.project(project)}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=100`,
      nextPage,
      MAX_OPEN_CHANGE_PAGES,
    );
    return mrs.map((mr) => ({
      number: mr.iid,
      title: mr.title,
      author: mr.author?.username,
      isDraft: mr.draft ?? mr.work_in_progress ?? false,
      headSha: mr.sha,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      webUrl: mr.web_url,
      updatedAt: mr.updated_at,
    }));
  }

  async getFileAtRef(project: string, path: string, ref: string): Promise<string | null> {
    try {
      const res = await this.http.request(
        `${this.project(project)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      );
      return await res.text();
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  // One page is enough: a pass is shown far fewer entries than that, and a
  // next page only marks the listing truncated. GitLab answers a file's path
  // with an empty list rather than a 404, and git keeps no empty directories,
  // so an empty list means "not a directory".
  async listDirAtRef(project: string, path: string, ref: string): Promise<DirListing | null> {
    const query = `${path ? `path=${encodeURIComponent(path)}&` : ""}ref=${encodeURIComponent(ref)}&per_page=100`;
    let res: Response;
    try {
      res = await this.http.request(`${this.project(project)}/repository/tree?${query}`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const entries = (await res.json()) as GlTreeEntry[];
    if (entries.length === 0) return null;
    return {
      entries: entries.map((entry) =>
        entry.type === "tree" ? `${entry.name}/` : entry.mode === "120000" ? `${entry.name}@` : entry.name,
      ),
      truncated: !!res.headers.get("x-next-page"),
    };
  }

  // GitLab already knows which issues an MR closes, from the same keywords.
  async getLinkedIssues(change: ChangeSet): Promise<IssueContext[]> {
    const issues = await this.http.json<GlIssue[]>(
      `${this.mergeRequest(change.forgeRef)}/closes_issues?per_page=${MAX_LINKED_ISSUES}`,
    );
    return issues.slice(0, MAX_LINKED_ISSUES).map(toIssue);
  }

  // GitLab's search matches every word it is given, so each term is searched
  // on its own and the results merged.
  async searchIssues(project: string, terms: string[]): Promise<IssueContext[]> {
    const found = new Map<number, GlIssue>();
    for (const term of terms) {
      const issues = await this.http.json<GlIssue[]>(
        `${this.project(project)}/issues?search=${encodeURIComponent(term)}&in=title,description&order_by=updated_at&per_page=${MAX_CANDIDATE_ISSUES}`,
      );
      for (const issue of issues) {
        if (found.size < MAX_CANDIDATE_ISSUES) found.set(issue.iid, issue);
      }
      if (found.size >= MAX_CANDIDATE_ISSUES) break;
    }
    return [...found.values()].map(toIssue);
  }

  async searchCode(project: string, term: string, ref: string): Promise<string[]> {
    const blobs = await this.http.json<{ path: string }[]>(
      `${this.project(project)}/search?scope=blobs&search=${encodeURIComponent(term)}&ref=${encodeURIComponent(ref)}&per_page=${MAX_CODE_SEARCH_RESULTS}`,
    );
    return [...new Set(blobs.map((blob) => blob.path))];
  }

  // The compare endpoint diffs from the merge base whatever the history, so
  // ancestry is asked separately: `from` is an ancestor exactly when it is its
  // own merge base with `to`.
  async compareCommits(project: string, from: string, to: string, cache?: ForgeCache): Promise<string[] | null> {
    return cached(cache, cacheKey("gitlab-compare", this.host, project, from, to), async () => {
      const repository = `${this.project(project)}/repository`;
      let base: { id: string };
      try {
        base = await this.http.json<{ id: string }>(
          `${repository}/merge_base?refs[]=${encodeURIComponent(from)}&refs[]=${encodeURIComponent(to)}`,
        );
      } catch (err) {
        // 400 is GitLab's "Could not find ref" (a commit gone after a force
        // push), 404 means the two share no history.
        if (isNotFound(err) || (err instanceof ForgeError && err.status === 400)) return null;
        throw err;
      }
      if (base.id !== from) return null;
      const comparison = await this.http.json<GlComparison>(
        `${repository}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      if (comparison.compare_timeout) return null;
      return [...new Set((comparison.diffs ?? []).flatMap((diff) => [diff.new_path, diff.old_path]))];
    });
  }

  // Reads the newest pipeline for the change's head commit. No pipeline, or
  // no report jobs in it, is an empty result.
  async getToolAnnotations(ref: ForgeRef): Promise<ToolResults> {
    const pipelines = await this.http.json<GlPipeline[]>(`${this.mergeRequest(ref)}/pipelines?per_page=20`);
    const pipeline = pipelines.find((candidate) => candidate.sha === ref.headSha);
    if (!pipeline) return { annotations: [], warnings: [] };

    const project = this.project(ref.project);
    const jobs = await this.http.paginate<GlJob>(`${project}/pipelines/${pipeline.id}/jobs?per_page=100`, nextPage, 5);
    const annotations: ToolResults["annotations"] = [];
    const warnings: string[] = [];
    const running: string[] = [];
    for (const job of jobs) {
      const types = new Set((job.artifacts ?? []).map((artifact) => artifact.file_type));
      const reports = (Object.keys(REPORTS) as (keyof typeof REPORTS)[]).filter((type) => types.has(type));
      if (reports.length === 0) {
        if (!FINISHED_JOB.has(job.status) && /code.?quality|sast/i.test(job.name)) running.push(job.name);
        continue;
      }
      for (const type of reports) {
        const path = REPORTS[type];
        let report: unknown;
        try {
          report = await this.http.json<unknown>(`${project}/jobs/${job.id}/artifacts/${path}`);
        } catch (err) {
          if (!isNotFound(err)) throw err;
          warnings.push(
            `The ${type} report of job "${job.name}" could not be downloaded; list ${path} under artifacts:paths as well as artifacts:reports`,
          );
          continue;
        }
        if (type === "codequality") {
          for (const issue of Array.isArray(report) ? (report as CodeQualityIssue[]) : []) {
            const mapped = fromCodeQuality(issue);
            if (mapped) annotations.push(mapped);
          }
        } else {
          annotations.push(...fromSastReport((report ?? {}) as SastReport));
        }
      }
    }
    if (running.length > 0) {
      warnings.push(`Jobs still running when the review started were left out: ${running.join(", ")}`);
    }
    return { annotations: annotations.slice(0, MAX_TOOL_ANNOTATIONS), warnings };
  }

  private mergeRequest(ref: ForgeRef): string {
    return `${this.project(ref.project)}/merge_requests/${ref.number}`;
  }

  private isSelf(note: GlNote): boolean {
    return !note.system && this.isSelfLogin(note.author.username);
  }

  isSelfLogin(login: string | undefined): boolean {
    return Boolean(this.selfLogin) && login === this.selfLogin;
  }

  private discussion(target: ThreadTarget, threadId: string): string {
    return `${this.project(target.project)}/merge_requests/${target.number}/discussions/${encodeURIComponent(threadId)}`;
  }

  async getThreadRoot(target: ThreadTarget, threadId: string): Promise<ThreadRoot | null> {
    try {
      const discussion = await this.http.json<GlDiscussion>(this.discussion(target, threadId));
      const first = discussion.notes[0];
      if (!first) return null;
      return { ownedBySelf: this.isSelf(first), fingerprint: markersIn(first.body)[0] ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async replyToThread(target: ThreadTarget, threadId: string, body: string): Promise<string> {
    const note = await this.http.json<GlNote>(`${this.discussion(target, threadId)}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return String(note.id);
  }

  // GitLab has no batch review API, so each finding is its own discussion. A
  // multi-line finding is anchored on its first line; its suggestion block
  // carries the range.
  async postInlineComments(ref: ForgeRef, comments: InlineComment[]): Promise<InlineResult> {
    const result: InlineResult = { posted: [], failed: [] };
    for (const comment of comments) {
      const position = {
        position_type: "text",
        base_sha: ref.baseSha,
        start_sha: ref.startSha,
        head_sha: ref.headSha,
        new_path: comment.path,
        old_path: comment.previousPath ?? comment.path,
        new_line: comment.startLine,
        ...(comment.oldLine !== undefined ? { old_line: comment.oldLine } : {}),
      };
      try {
        const discussion = await this.http.json<GlDiscussion>(`${this.mergeRequest(ref)}/discussions`, {
          method: "POST",
          body: JSON.stringify({ body: comment.body, position }),
        });
        result.posted.push({ fingerprint: comment.fingerprint, forgeCommentId: discussion.id });
      } catch (err) {
        result.failed.push({ fingerprint: comment.fingerprint, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  // Sentryward opened the discussion: its first note is Sentryward's own.
  private isOwn(discussion: GlDiscussion): boolean {
    return Boolean(discussion.notes[0] && this.isSelf(discussion.notes[0]));
  }

  // Runs on every inline publish, so it keeps the default page cap; a marker
  // past it only risks a duplicate comment.
  async listPostedFingerprints(ref: ForgeRef): Promise<Set<string>> {
    const discussions = await this.http.paginate<GlDiscussion>(`${this.mergeRequest(ref)}/discussions?per_page=100`, nextPage);
    return new Set(discussions.filter((d) => this.isOwn(d)).flatMap((d) => markersIn(d.notes[0]!.body)));
  }

  async setThreadsResolved(ref: ForgeRef, fingerprints: string[], resolved: boolean): Promise<ThreadResult> {
    const result: ThreadResult = { updated: [], failed: [] };
    if (fingerprints.length === 0) return result;
    const wanted = new Set(fingerprints);
    const seen = new Set<string>();
    // Read a page at a time until every wanted discussion is found or they run
    // out: a later run starts from the first page again, so stopping at a fixed
    // cap would leave a discussion past it out of reach for good. Only runs
    // with a thread to move pay for this, and pages are not kept.
    let complete = false;
    let url: string | null = `${this.mergeRequest(ref)}/discussions?per_page=100`;
    while (url) {
      const res = await this.http.request(url);
      const page = (await res.json()) as GlDiscussion[];
      for (const discussion of page) {
        if (!this.isOwn(discussion)) continue;
        const first = discussion.notes[0]!;
        const print = markersIn(first.body).find((p) => wanted.has(p));
        if (!print) continue;
        seen.add(print);
        // Not a diff thread, or already where it should be.
        if (first.resolved === undefined || first.resolved === resolved) continue;
        // Only a discussion Sentryward resolved is reopened; one a person
        // resolved stays resolved.
        if (!resolved && first.resolved_by?.username !== this.selfLogin) continue;
        try {
          await this.http.request(
            `${this.mergeRequest(ref)}/discussions/${encodeURIComponent(discussion.id)}?resolved=${resolved}`,
            { method: "PUT" },
          );
          result.updated.push(print);
        } catch (err) {
          result.failed.push({ fingerprint: print, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const next = nextPage(res, url);
      if (next === null || seen.size === wanted.size) {
        complete = true;
        break;
      }
      // A next page that does not move would loop forever.
      if (next === url) break;
      url = next;
    }
    // A discussion the listing never reached may still exist; reporting it as
    // failed keeps it pending rather than settled.
    if (!complete) {
      for (const print of wanted) {
        if (!seen.has(print)) {
          result.failed.push({ fingerprint: print, error: "Discussion listing stopped early" });
        }
      }
    }
    return result;
  }

  upsertSummaryComment(ref: ForgeRef, body: string): Promise<string> {
    return this.upsertComment(ref, SUMMARY_MARKER, body);
  }

  async upsertComment(ref: ForgeRef, marker: string, body: string): Promise<string> {
    const notes = await this.http.paginate<GlNote>(`${this.mergeRequest(ref)}/notes?per_page=100&sort=asc`, nextPage);
    const existing = notes.filter((n) => this.isSelf(n) && n.body.includes(marker)).at(-1);
    const saved = existing
      ? await this.http.json<GlNote>(`${this.mergeRequest(ref)}/notes/${existing.id}`, {
          method: "PUT",
          body: JSON.stringify({ body }),
        })
      : await this.http.json<GlNote>(`${this.mergeRequest(ref)}/notes`, { method: "POST", body: JSON.stringify({ body }) });
    return String(saved.id);
  }

  // Read just before writing so an edit the author made since the change was
  // fetched is kept.
  async updateDescription(ref: ForgeRef, transform: (description: string) => string): Promise<void> {
    const mr = await this.http.json<GlMergeRequest>(this.mergeRequest(ref));
    const description = mr.description ?? "";
    const next = transform(description);
    if (next === description) return;
    await this.http.request(this.mergeRequest(ref), { method: "PUT", body: JSON.stringify({ description: next }) });
  }

  // One request; GitLab ignores labels it cannot remove and creates missing ones.
  async setLabels(ref: ForgeRef, add: string[], remove: string[]): Promise<void> {
    if (!add.length && !remove.length) return;
    await this.http.request(this.mergeRequest(ref), {
      method: "PUT",
      body: JSON.stringify({ add_labels: add.join(","), remove_labels: remove.join(",") }),
    });
  }

  async setCommitStatus(ref: ForgeRef, status: CommitStatus): Promise<void> {
    await this.http.request(`${this.project(ref.project)}/statuses/${ref.headSha}`, {
      method: "POST",
      body: JSON.stringify({
        state: GITLAB_STATE[status.state],
        name: STATUS_CONTEXT,
        description: status.description.slice(0, 255),
        ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
      }),
    });
  }

  // Project hooks need Maintainer access; callers treat a failure as "automatic
  // reviews unavailable" rather than an error.
  async createHook(repo: HookTarget, url: string, token: string): Promise<string> {
    const hook = await this.http.json<{ id: number }>(`${this.project(repo.externalId)}/hooks`, {
      method: "POST",
      body: JSON.stringify({
        url,
        token,
        merge_requests_events: true,
        note_events: true,
        push_events: false,
        enable_ssl_verification: true,
      }),
    });
    return String(hook.id);
  }

  async deleteHook(repo: HookTarget, hookId: string): Promise<void> {
    try {
      await this.http.request(`${this.project(repo.externalId)}/hooks/${encodeURIComponent(hookId)}`, { method: "DELETE" });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // Effective access level of a user on the project, inherited membership
  // included; 0 when they are not a member.
  async memberAccessLevel(project: string, userId: number): Promise<number> {
    try {
      const member = await this.http.json<{ access_level: number }>(`${this.project(project)}/members/all/${userId}`);
      return member.access_level;
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw err;
    }
  }
}
