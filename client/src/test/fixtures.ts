import type { ReviewDetail, ReviewListItem, ReviewResult } from "@/features/reviews/types"

const finding = (overrides: Partial<ReviewResult["findings"][number]>) => ({
  file: "src/app.ts",
  startLine: 11,
  endLine: 11,
  severity: "major" as const,
  category: "bug",
  kind: "potential_issue",
  effort: "quick_win",
  title: "A finding",
  body: "Why it matters.",
  confidence: 0.9,
  evidence: "execution_path",
  evidenceNote: "Called with null from the handler.",
  evidenceFiles: [],
  source: "llm" as const,
  fingerprint: Math.random().toString(16).slice(2),
  bucket: "actionable" as const,
  ...overrides,
})

export const result: ReviewResult = {
  schemaVersion: 1,
  status: "completed",
  errors: [],
  warnings: [".sentryward.yaml was ignored: review: unknown setting nope"],
  change: {
    provider: "github",
    host: "github.com",
    project: "acme/web",
    number: 42,
    baseSha: "base",
    headSha: "abcdef1234",
    webUrl: "https://github.com/acme/web/pull/42",
    title: "Add b and c",
    isDraft: false,
  },
  files: [{ path: "src/app.ts", changeType: "modified", additions: 2, deletions: 0 }],
  findings: [
    finding({ severity: "critical", title: "SQL injection in search", suggestion: "db.query(sql, [q])" }),
    finding({ severity: "minor", kind: "nitpick", bucket: "nitpick", title: "Rename c" }),
    finding({ startLine: 40, endLine: 40, bucket: "outside_diff", title: "Caller ignores result" }),
  ],
  walkthrough: { overview: "Adds b and c.", fileSummaries: [], labels: ["feature"], estimatedEffort: 2 },
  coverage: { reviewedFiles: ["src/app.ts"], omissions: [{ path: "yarn.lock", reason: "ignored" }], passes: 1 },
  validation: { dropped: {}, demoted: 0 },
  usage: [],
  usageTotals: { calls: 2, inputTokens: 1200, outputTokens: 300, costUsd: 0.0054 },
  verdict: { verdict: "blocked", blockOn: "critical", blocking: [] },
  summary: {
    title: "Add b and c",
    webUrl: "https://github.com/acme/web/pull/42",
    total: 3,
    bySeverity: { critical: 1, major: 1, minor: 1 },
    byBucket: { actionable: 1, outside_diff: 1, nitpick: 1 },
    hasBlocking: true,
  },
}

export const listItem: ReviewListItem = {
  id: "11111111-1111-4111-8111-111111111111",
  number: 42,
  headSha: "abcdef1234",
  trigger: "manual",
  status: "completed",
  verdict: "blocked",
  title: result.summary.title,
  summary: result.summary,
  error: null,
  createdAt: new Date().toISOString(),
  startedAt: null,
  finishedAt: null,
  repository: { id: "r1", provider: "github", host: "github.com", fullPath: "acme/web" },
}

export const detail: ReviewDetail = { ...listItem, baseSha: "base", attempts: 1, result, publication: null, resultExpiredAt: null, errorKind: null, resolvedConfig: null }
