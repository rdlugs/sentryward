// Mirrors the server's review result (server/src/review/core/models.ts),
// schemaVersion 1, as served by GET /api/reviews/:id.

export type Severity = "critical" | "major" | "minor" | "info"
export type Bucket = "actionable" | "outside_diff" | "nitpick" | "requirement_gap"
export type JobStatus = "queued" | "running" | "completed" | "partial" | "failed" | "superseded" | "skipped" | "cancelled"
export type Verdict = "pass" | "blocked" | "error"
export type Provider = "github" | "gitlab"
export type Trigger = "manual" | "webhook" | "comment"
export type IssueAssessment = "addressed" | "partial" | "not_addressed" | "unclear"

// A sensitive area the change touches, or reaches through its callers (via).
export interface RiskyArea {
  kind: "auth" | "database" | "api"
  path: string
  reason: string
  via?: string
  removesCheck?: boolean
}

export interface IssueRef {
  ref: string
  title: string
  url?: string
  state: "open" | "closed"
}

export const SEVERITIES: Severity[] = ["critical", "major", "minor", "info"]
export const BUCKET_ORDER: Bucket[] = ["actionable", "requirement_gap", "outside_diff", "nitpick"]
export const BUCKET_TITLE: Record<Bucket, string> = {
  actionable: "Actionable comments",
  requirement_gap: "Requirements not met",
  outside_diff: "Outside diff range comments",
  nitpick: "Nitpick comments",
}

export type Verification = "verified" | "uncertain" | "not_checked"

export interface Finding {
  file: string
  startLine: number
  endLine: number
  severity: Severity
  category: string
  kind: string
  effort: string
  title: string
  body: string
  // What breaks if it ships, and why the suggested fix works; absent when the
  // model gave none, on tool findings and in older results.
  impact?: string
  fixRationale?: string
  suggestion?: string
  // The model's own estimate. Never show it as a calibrated probability.
  confidence: number
  evidence: string
  evidenceNote: string
  evidenceFiles: string[]
  // What review.verify made of it; absent on older results, meaning not checked.
  verification?: Verification
  source: "llm" | "tool" | "rule"
  tool?: string
  // The `.sentryward.yaml` rule a rule finding violates, or an analyzer's rule
  // on a tool finding.
  ruleId?: string
  fingerprint: string
  // The model of the review pass that raised it; absent for tool and rule
  // findings and older results.
  model?: string
  bucket: Bucket
}

export interface Omission {
  path: string
  reason: string
  detail?: string
}

// Mirrors DropReason in server/src/review/validate/validator.ts. Results can
// still carry reasons the client does not know, so `dropped` stays keyed by string.
export type DropReason =
  | "invalid_line"
  | "unknown_file"
  | "category"
  | "off_diff"
  | "low_confidence"
  | "below_floor"
  | "empty"
  | "duplicate"
  | "over_limit"
  | "previously_ignored"
  | "refuted"
  | "rule_mismatch"

export interface UsageTotals {
  calls: number
  // Calls no price was known for; absent on digests from before they were counted.
  unpricedCalls?: number
  inputTokens: number
  outputTokens: number
}

// Summed from the costs reviews recorded when they ran, at that day's prices;
// a call without a price adds nothing, and when no call had one the cost reads
// as unknown (see costUnknown).
export interface CostEstimate {
  usd: number
}

export interface ReviewSummary {
  title: string
  webUrl?: string
  total: number
  bySeverity: Partial<Record<Severity, number>>
  byBucket: Partial<Record<Bucket, number>>
  hasBlocking: boolean
  // Absent on runs stored before the digest carried token totals.
  usageTotals?: UsageTotals
}

export interface ReviewResult {
  schemaVersion: 1
  status: "completed" | "partial" | "failed"
  errors: string[]
  warnings: string[]
  change: {
    provider: Provider
    host: string
    project: string
    number: number
    baseSha: string
    headSha: string
    webUrl?: string
    title: string
    baseRef?: string
    headRef?: string
    isDraft: boolean
  }
  files: { path: string; changeType: string; additions: number; deletions: number }[]
  findings: Finding[]
  walkthrough?: {
    overview: string
    fileSummaries: { path: string; summary: string }[]
    labels: string[]
    estimatedEffort: number
    // Optional parts, present only when their settings were on.
    sequenceDiagram?: string
    highLevelSummary?: string
    linkedIssues?: (IssueRef & { assessment: IssueAssessment; note: string })[]
    relatedIssues?: (IssueRef & { reason: string })[]
    riskyAreas?: RiskyArea[]
  }
  coverage: { reviewedFiles: string[]; omissions: Omission[]; passes: number }
  validation: { dropped: Record<string, number>; demoted: number }
  usage: {
    purpose: string
    model: string
    inputTokens: number
    outputTokens: number
    reasoningTokens?: number
    latencyMs: number
    // Agentic passes: model calls, and tool calls by name.
    steps?: number
    toolCalls?: Record<string, number>
  }[]
  // costUsd is absent on results stored before costs were recorded, and
  // unpricedCalls on those from before calls without a price were counted.
  usageTotals: { calls: number; inputTokens: number; outputTokens: number; costUsd?: number; unpricedCalls?: number }
  verdict: { verdict: Verdict; blockOn: Severity; blocking: string[] }
  summary: ReviewSummary
}

export interface ReviewListItem {
  id: string
  number: number
  headSha: string
  trigger: Trigger
  status: JobStatus
  verdict: Verdict | null
  // The change's title, stored once the worker fetched the change (so skipped
  // runs have it too). Null on runs that never got that far; older rows may
  // only have it in the summary.
  title: string | null
  summary: ReviewSummary | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  repository: { id: string; provider: Provider; host: string; fullPath: string }
  // Only in the "changes" view: matching runs of this change, this one included.
  runCount?: number
}

// An open pull/merge request, as GET /api/repos/:id/changes lists it.
export interface OpenChange {
  number: number
  title: string
  author?: string
  isDraft: boolean
  headSha: string
  sourceBranch: string
  targetBranch: string
  webUrl: string
  updatedAt: string
}

export interface Publication {
  inlinePosted: { fingerprint: string; forgeCommentId: string }[]
  inlineSkipped: number
  inlineFailed: { fingerprint: string; error: string }[]
  summaryCommentId: string | null
  statusState: string | null
  errors: string[]
}

// Where a running review is (worker/progress.ts on the server). Planning,
// context and walkthrough are details of the reviewing step.
export type ReviewStep = "fetching" | "preparing" | "reviewing" | "verifying" | "publishing"
export type ReviewStage = ReviewStep | "planning" | "context" | "walkthrough"
export interface ReviewProgress {
  stage: ReviewStage
  // Known once the run's config is.
  steps?: ReviewStep[]
  passes?: { done: number; total: number }
}

export interface ReviewDetail extends ReviewListItem {
  baseSha: string | null
  attempts: number
  result: ReviewResult | null
  publication: Publication | null
  // Set once the server's retention setting cleared the full result.
  resultExpiredAt: string | null
  // Null until the worker records a stage, and stale once the run ends.
  progress: ReviewProgress | null
  // What `error` is about, so the page can link to the fix (null when unknown).
  errorKind: ReviewErrorKind | null
  // The config the run used, with the layer each field came from. Cleared by
  // retention like the result.
  resolvedConfig: { sources?: Record<string, string>; repoFile?: string | null } | null
  // `enabled` is the repository's current state: a re-run is refused while it is off.
  repository: ReviewListItem["repository"] & { enabled: boolean }
}

export type ReviewErrorKind =
  | "llm_connection"
  | "llm_config"
  | "forge_credentials"
  | "forge_access"
  | "repo_disabled"
  | "privacy"
  | "trigger"

export interface ReviewStats {
  days: number
  runs: number
  blocked: number
  passed: number
  failed: number
  // Milliseconds from start to finish of completed runs; null when none finished.
  duration: { median: number | null; max: number | null }
  // Summed over the period; runs stored before token digests count as zero.
  tokens: UsageTotals
  cost: CostEstimate
}

export function isActive(status: JobStatus) {
  return status === "queued" || status === "running"
}
