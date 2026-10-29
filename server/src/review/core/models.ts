import { z } from "zod";
import {
  categorySchema,
  effortSchema,
  evidenceSchema,
  kindSchema,
  severitySchema,
  verificationSchema,
  type Category,
  type Severity,
} from "./severity.ts";

// The intermediate representation every forge produces and every later stage
// reads. Line numbers are new-file coordinates everywhere; only publishers
// translate them into a forge's position payload.

export const forgeProviderSchema = z.enum(["github", "gitlab"]);
export type ForgeProvider = z.infer<typeof forgeProviderSchema>;

export const hunkSchema = z.object({
  oldStart: z.number().int().min(0),
  oldLines: z.number().int().min(0),
  newStart: z.number().int().min(0),
  newLines: z.number().int().min(0),
  header: z.string(),
  content: z.string(),
  // New-file lines this hunk adds; the only lines a finding may target unless
  // the review allows context lines.
  addedLines: z.array(z.number().int().positive()),
  // New-file line to its position in the file's patch (1 = the line below the
  // first @@). Covers added and context lines; a line missing here cannot carry
  // an inline comment.
  newLineToPosition: z.record(z.string(), z.number().int().positive()),
  // New-file line to old-file line for unchanged context lines. GitLab needs
  // both to anchor a comment on a line the change did not touch.
  contextOldLines: z.record(z.string(), z.number().int().positive()),
});
export type Hunk = z.infer<typeof hunkSchema>;

export const changeTypeSchema = z.enum(["added", "modified", "deleted", "renamed"]);
export type ChangeType = z.infer<typeof changeTypeSchema>;

export const changedFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  changeType: changeTypeSchema,
  language: z.string().optional(),
  isBinary: z.boolean(),
  // The forge withheld the patch (too large, or truncated); the file changed but
  // there is nothing to anchor against.
  patchUnavailable: z.boolean(),
  hunks: z.array(hunkSchema),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const forgeRefSchema = z.object({
  provider: forgeProviderSchema,
  host: z.string(),
  project: z.string(),
  number: z.number().int().positive(),
  baseSha: z.string(),
  startSha: z.string(),
  headSha: z.string(),
  webUrl: z.string().optional(),
});
export type ForgeRef = z.infer<typeof forgeRefSchema>;

export const changeSetSchema = z.object({
  forgeRef: forgeRefSchema,
  title: z.string(),
  description: z.string(),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  isDraft: z.boolean(),
  // Login of whoever opened the change, and its labels, for the skip lists.
  author: z.string().optional(),
  labels: z.array(z.string()).optional(),
  files: z.array(changedFileSchema),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

export function diffPosition(file: ChangedFile, newLine: number): number | undefined {
  for (const hunk of file.hunks) {
    const position = hunk.newLineToPosition[String(newLine)];
    if (position !== undefined) {
      return position;
    }
  }
  return undefined;
}

export function isAddedLine(file: ChangedFile, newLine: number): boolean {
  return file.hunks.some((hunk) => hunk.addedLines.includes(newLine));
}

// ---------------------------------------------------------------------------
// Review result. Stored as JSONB on the job and rendered by every surface.
// ---------------------------------------------------------------------------

export const RESULT_SCHEMA_VERSION = 1;

export const bucketSchema = z.enum(["actionable", "outside_diff", "nitpick", "requirement_gap"]);
export type Bucket = z.infer<typeof bucketSchema>;

export const findingSchema = z.object({
  file: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  severity: severitySchema,
  category: categorySchema,
  kind: kindSchema,
  effort: effortSchema,
  title: z.string(),
  body: z.string(),
  // What breaks if it ships, and why the suggested fix works. Kept apart from
  // the body so every surface can show them as such. Absent when the model gave
  // none, on tool and rule findings, and in results stored before they existed.
  impact: z.string().optional(),
  fixRationale: z.string().optional(),
  // Verbatim replacement for startLine..endLine.
  suggestion: z.string().optional(),
  // The model's own estimate, never checked against outcomes by itself; the
  // calibration endpoint is what measures it. Never shown as a probability.
  confidence: z.number().min(0).max(1),
  evidence: evidenceSchema,
  evidenceNote: z.string(),
  evidenceFiles: z.array(z.string()),
  // Absent in results stored before it was recorded, which means not checked.
  verification: verificationSchema.optional(),
  // "tool" findings come from analyzers that already ran on the forge (check
  // run annotations, GitLab report artifacts), named by `tool`.
  source: z.enum(["llm", "tool", "rule"]),
  tool: z.string().optional(),
  ruleId: z.string().optional(),
  fingerprint: z.string(),
  // The model of the review pass that raised it (not the verifier's). Absent
  // for tool and rule findings, and in results stored before it was recorded.
  model: z.string().optional(),
  // Decided once by core/buckets.ts so no surface can disagree about it.
  bucket: bucketSchema,
});
export type Finding = z.infer<typeof findingSchema>;

// One result of a static analyzer as the forge reported it, before it is
// checked against the diff and the config like any model finding.
export interface ToolAnnotation {
  tool: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  category: Category;
  ruleId?: string;
  title: string;
  message: string;
}

export const omissionReasonSchema = z.enum([
  "ignored",
  "binary",
  "deleted",
  "patch_unavailable",
  "too_large",
  "budget",
  "chunk_failed",
]);
export type OmissionReason = z.infer<typeof omissionReasonSchema>;

export const omissionSchema = z.object({
  path: z.string(),
  reason: omissionReasonSchema,
  detail: z.string().optional(),
});
export type Omission = z.infer<typeof omissionSchema>;

export const llmUsageSchema = z.object({
  // probe: a check of what the model supports, run before the review used it.
  purpose: z.enum(["review", "walkthrough", "verify", "probe"]),
  model: z.string(),
  // Total input, cache reads included.
  inputTokens: z.number().int().min(0),
  // Input read from and written to the provider's prompt cache, and output
  // spent reasoning (part of outputTokens). Each is absent when there was none,
  // and on results stored before it was recorded.
  cachedInputTokens: z.number().int().min(0).optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0),
  reasoningTokens: z.number().int().min(0).optional(),
  latencyMs: z.number().int().min(0),
  chunk: z.number().int().positive().optional(),
  // An agentic pass (review.context: agentic): its model calls, and its tool
  // calls by tool name. The token counts above sum every step.
  steps: z.number().int().positive().optional(),
  toolCalls: z.record(z.string(), z.number().int().min(0)).optional(),
  // A call whose reply could not be used, kept because its tokens were billed.
  failed: z.literal(true).optional(),
  // USD at the prices in effect when the call was made (core/pricing). Absent
  // on results stored before costs were recorded, and on calls no price was
  // known for, which are flagged unpriced instead so they read as unknown
  // rather than free.
  cost: z
    .object({
      input: z.number().min(0),
      cached: z.number().min(0),
      cacheWrite: z.number().min(0),
      output: z.number().min(0),
      reasoning: z.number().min(0),
      total: z.number().min(0),
    })
    .optional(),
  unpriced: z.literal(true).optional(),
});
export type LlmUsage = z.infer<typeof llmUsageSchema>;

// An issue as the forge reports it. `ref` is how the model and the rendered
// comment name it, e.g. "#12".
export const issueRefSchema = z.object({
  ref: z.string(),
  title: z.string(),
  url: z.string().optional(),
  state: z.enum(["open", "closed"]),
});
export type IssueRef = z.infer<typeof issueRefSchema>;

// What the walkthrough reads about an issue; the body is never stored.
export type IssueContext = IssueRef & { body: string };

// A finding this team previously dismissed (false_positive/intentional), fed
// back into the review so the model does not report it again. The note is the
// user's own text and is treated as untrusted in the prompt.
export type RejectedFinding = { title: string; category: string; file: string; note?: string };

export const issueAssessmentSchema = z.enum(["addressed", "partial", "not_addressed", "unclear"]);
export type IssueAssessment = z.infer<typeof issueAssessmentSchema>;

export const RISK_KINDS = ["auth", "database", "api"] as const;

// A sensitive area the change touches or reaches, found by pattern in the
// diff and in the callers traced for context.
export const riskyAreaSchema = z.object({
  kind: z.enum(RISK_KINDS),
  path: z.string(),
  reason: z.string(),
  // The chain of names from the changed code to this file, when it is only
  // reached through callers.
  via: z.string().optional(),
  // An authorization check the diff removes.
  removesCheck: z.boolean().optional(),
});
export type RiskyArea = z.infer<typeof riskyAreaSchema>;

export const walkthroughSchema = z.object({
  overview: z.string(),
  fileSummaries: z.array(z.object({ path: z.string(), summary: z.string() })),
  labels: z.array(z.string()),
  estimatedEffort: z.number().int().min(1).max(5),
  // Optional: results stored before it existed have none.
  blastRadius: z.enum(["small", "medium", "large"]).optional(),
  // Optional parts, each present only when its setting was on.
  sequenceDiagram: z.string().optional(),
  highLevelSummary: z.string().optional(),
  linkedIssues: z
    .array(issueRefSchema.extend({ assessment: issueAssessmentSchema, note: z.string() }))
    .optional(),
  relatedIssues: z.array(issueRefSchema.extend({ reason: z.string() })).optional(),
  // Optional: results stored before it existed have none.
  riskyAreas: z.array(riskyAreaSchema).optional(),
});
export type Walkthrough = z.infer<typeof walkthroughSchema>;

export const reviewStatusSchema = z.enum(["completed", "partial", "failed"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

// Where a running review is, stored on the job while it runs. Coarse on
// purpose: planning, context and walkthrough are details of the reviewing
// step, which is all `steps` lists.
export type ReviewStep = "fetching" | "preparing" | "reviewing" | "verifying" | "publishing";
export type ReviewStage = ReviewStep | "planning" | "context" | "walkthrough";
export interface ReviewProgress {
  stage: ReviewStage;
  // The steps this run goes through, known once its config is.
  steps?: ReviewStep[];
  passes?: { done: number; total: number };
}
// What the pipeline reports; the worker adds the steps around it.
export type PipelineProgress = Omit<ReviewProgress, "steps">;

export const verdictSchema = z.enum(["pass", "blocked", "error"]);
export type Verdict = z.infer<typeof verdictSchema>;

// Why a finding went away without being fixed: its file was renamed, deleted
// or dropped from the change, or the same problem is now reported elsewhere.
export const invalidatedReasonSchema = z.enum(["renamed", "deleted", "left_change", "moved"]);
export type InvalidatedReason = z.infer<typeof invalidatedReasonSchema>;

// How this run's findings relate to the ones earlier runs left on the change
// (worker/syncFindings.ts). `new`, `stillOpen` and `reopened` (resolved by an
// earlier run, reported again) are fingerprints of `findings`; `gone` are
// earlier findings this run no longer reports, kept as a snapshot since they
// are not in `findings`.
export const lifecycleSchema = z.object({
  new: z.array(z.string()),
  stillOpen: z.array(z.string()),
  // Results stored before it existed counted these as still open.
  reopened: z.array(z.string()).default([]),
  gone: z.array(
    z.object({
      fingerprint: z.string(),
      title: z.string(),
      file: z.string(),
      startLine: z.number().int(),
      endLine: z.number().int().optional(),
      severity: severitySchema,
      outcome: z.enum(["fixed", "invalidated"]),
      reason: invalidatedReasonSchema.optional(),
    }),
  ),
});
export type Lifecycle = z.infer<typeof lifecycleSchema>;

export const reviewResultSchema = z.object({
  schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
  status: reviewStatusSchema,
  // Why the review is partial or failed.
  errors: z.array(z.string()),
  // Non-fatal: an ignored config file, a failed walkthrough.
  warnings: z.array(z.string()),
  change: forgeRefSchema.extend({
    title: z.string(),
    baseRef: z.string().optional(),
    headRef: z.string().optional(),
    isDraft: z.boolean(),
  }),
  files: z.array(
    z.object({
      path: z.string(),
      previousPath: z.string().optional(),
      changeType: changeTypeSchema,
      additions: z.number().int().min(0),
      deletions: z.number().int().min(0),
    }),
  ),
  findings: z.array(findingSchema),
  walkthrough: walkthroughSchema.optional(),
  // Set when only the files changed since an earlier completed review were
  // reviewed (worker/incremental.ts). `files` are the paths reviewed again;
  // `carried` counts the findings kept from that review for the other files.
  incremental: z
    .object({
      fromSha: z.string(),
      toSha: z.string(),
      files: z.array(z.string()),
      carried: z.number().int().min(0),
    })
    .optional(),
  // Absent on a change's first review, a failed one, and results stored before it existed.
  lifecycle: lifecycleSchema.optional(),
  coverage: z.object({
    reviewedFiles: z.array(z.string()),
    omissions: z.array(omissionSchema),
    passes: z.number().int().min(0),
  }),
  validation: z.object({
    // Reason to how many model findings it removed.
    dropped: z.record(z.string(), z.number().int().min(0)),
    demoted: z.number().int().min(0),
  }),
  usage: z.array(llmUsageSchema),
  verdict: z.object({
    verdict: verdictSchema,
    blockOn: severitySchema,
    blocking: z.array(z.string()),
  }),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;
