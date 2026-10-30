import type { DirListing } from "../context/gather.ts";
import type { ChangeSet, ForgeProvider, ForgeRef, IssueContext } from "../core/models.ts";
import type { ForgeCache } from "./cache.ts";
import type { ToolResults } from "./toolResults.ts";

export interface ForgeRepo {
  externalId: string;
  fullPath: string;
  defaultBranch: string;
  private: boolean;
  webUrl: string;
}

export interface ChangeHead {
  headSha: string;
  // A ref to read the base revision at: GitLab gives only the target branch
  // until it has computed the MR's diff.
  baseSha: string;
  title: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
}

// An open PR/MR as listed for picking one to review by hand.
export interface ChangeSummary {
  number: number;
  title: string;
  author?: string;
  isDraft: boolean;
  headSha: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  updatedAt: string;
}

// Busy repositories can have thousands of open changes; the most recently
// updated few hundred are the ones anyone would pick by hand.
export const MAX_OPEN_CHANGE_PAGES = 3;

export interface ForgeAccount {
  login: string;
}

// One forge, bound to one set of credentials. The read side; publishing is
// ForgePublisher below, which both adapters also implement.
export interface ForgeAdapter {
  readonly provider: ForgeProvider;
  readonly host: string;
  currentAccount(): Promise<ForgeAccount>;
  listRepos(): Promise<ForgeRepo[]>;
  getRepo(externalId: string): Promise<ForgeRepo>;
  // The diff is read through the cache when one is given; the change's own
  // fields are always fetched fresh.
  getChange(project: string, number: number, cache?: ForgeCache): Promise<ChangeSet>;
  // Just enough to queue a review, without fetching the diff.
  getChangeHead(project: string, number: number): Promise<ChangeHead>;
  // Open changes, most recently updated first.
  listOpenChanges(project: string): Promise<ChangeSummary[]>;
  // Raw file content at a ref, or null when the file does not exist there.
  getFileAtRef(project: string, path: string, ref: string): Promise<string | null>;
  // Entries of a directory at a ref ("" is the root, see DirListing), or null
  // when the path does not exist there or is not a directory.
  listDirAtRef(project: string, path: string, ref: string): Promise<DirListing | null>;
  // Issues the change says it closes, at most MAX_LINKED_ISSUES (issues.ts).
  getLinkedIssues(change: ChangeSet): Promise<IssueContext[]>;
  // Issues matching any of the terms, at most MAX_CANDIDATE_ISSUES.
  searchIssues(project: string, terms: string[]): Promise<IssueContext[]>;
  // Paths of files mentioning `term`, best match first, at most
  // MAX_CODE_SEARCH_RESULTS. `ref` is honoured where the forge can search one.
  searchCode(project: string, term: string, ref: string): Promise<string[]>;
  // Paths (old and new) changed from `from` to `to`, or null when `from` is gone
  // or is not an ancestor of `to` (a force push or rebase), or when the forge
  // cut the list short. Fixed by the two shas, so read through the cache.
  compareCommits(project: string, from: string, to: string, cache?: ForgeCache): Promise<string[] | null>;
  // What static analyzers already reported for the change's head revision:
  // check run annotations on GitHub, Code Quality and SAST reports from the
  // head pipeline on GitLab. No checks or pipeline is an empty result, not an
  // error; a missing permission throws.
  getToolAnnotations(ref: ForgeRef): Promise<ToolResults>;
}

// GitHub's compare endpoint lists at most this many files and says nothing
// when it stops, so a list this long may be incomplete.
export const MAX_COMPARE_FILES = 300;

export const MAX_CODE_SEARCH_RESULTS = 20;

// Webhooks Sentryward registers on one repository, for forges (or connection kinds)
// that do not deliver events through an app.
export interface HookTarget {
  externalId: string;
  fullPath: string;
}

export interface ForgeHooks {
  createHook(repo: HookTarget, url: string, secret: string): Promise<string>;
  // Succeeds when the hook is already gone.
  deleteHook(repo: HookTarget, hookId: string): Promise<void>;
}

// "gitlab.com" means https; a self-hosted plain-http instance keeps its scheme.
export function hostOrigin(host: string): string {
  return /^https?:\/\//.test(host) ? host.replace(/\/+$/, "") : `https://${host}`;
}

// ---------------------------------------------------------------------------
// Publishing. Only publishers translate new-file lines into forge positions.
// ---------------------------------------------------------------------------

export interface InlineComment {
  fingerprint: string;
  path: string;
  previousPath?: string;
  startLine: number;
  endLine: number;
  // Set when startLine is an unchanged context line; GitLab needs it.
  oldLine?: number;
  body: string;
}

export interface PostedComment {
  fingerprint: string;
  forgeCommentId: string;
}

export interface InlineResult {
  posted: PostedComment[];
  failed: { fingerprint: string; error: string }[];
}

// Threads found and switched, by fingerprint. A fingerprint with no thread of
// Sentryward's, or one already in the wanted state, is in neither list.
export interface ThreadResult {
  updated: string[];
  failed: { fingerprint: string; error: string }[];
}

export type CommitState = "pending" | "success" | "failure" | "error";

export interface CommitStatus {
  state: CommitState;
  description: string;
  targetUrl?: string;
}

export const STATUS_CONTEXT = "sentryward/review";

// The change a thread lives on; a webhook knows no more than this.
export interface ThreadTarget {
  project: string;
  number: number;
}

// The first comment of an inline thread: the finding it is about when
// Sentryward opened the thread, read from the hidden fingerprint marker.
export interface ThreadRoot {
  ownedBySelf: boolean;
  fingerprint: string | null;
}

export interface ForgePublisher {
  postInlineComments(ref: ForgeRef, comments: InlineComment[]): Promise<InlineResult>;
  // Fingerprints in Sentryward's own inline comments on this change, read from their
  // hidden markers, so a lost database row never means a duplicate comment.
  listPostedFingerprints(ref: ForgeRef): Promise<Set<string>>;
  // Creates Sentryward's summary comment, or edits the one it posted before.
  upsertSummaryComment(ref: ForgeRef, body: string): Promise<string>;
  // The same for any comment Sentryward owns, found by the hidden marker in its body.
  upsertComment(ref: ForgeRef, marker: string, body: string): Promise<string>;
  // Rewrites the PR/MR description from its current text.
  updateDescription(ref: ForgeRef, transform: (description: string) => string): Promise<void>;
  // Adds and removes labels; removing one the change does not carry is not an error.
  setLabels(ref: ForgeRef, add: string[], remove: string[]): Promise<void>;
  setCommitStatus(ref: ForgeRef, status: CommitStatus): Promise<void>;
  // Resolves (or reopens) Sentryward's own inline threads for these findings,
  // found by the hidden fingerprint marker in each thread's first comment.
  setThreadsResolved(ref: ForgeRef, fingerprints: string[], resolved: boolean): Promise<ThreadResult>;
}

// Conversation in Sentryward's inline threads: people replying to a finding.
export interface ForgeThreads {
  // The first comment of an inline thread (GitHub: root comment id; GitLab:
  // discussion id), or null when it no longer exists.
  getThreadRoot(target: ThreadTarget, threadId: string): Promise<ThreadRoot | null>;
  // Posts a reply in an inline thread and returns the new comment's id.
  replyToThread(target: ThreadTarget, threadId: string, body: string): Promise<string>;
  // Whether a forge login is Sentryward itself, so its own comments never
  // count as a person's reply.
  isSelfLogin(login: string | undefined): boolean;
}
