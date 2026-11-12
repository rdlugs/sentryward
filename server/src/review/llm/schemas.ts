import { z } from "zod";
import {
  CATEGORIES,
  EFFORTS,
  EVIDENCE,
  SEVERITIES,
  categorySchema,
  effortSchema,
  evidenceSchema,
  severitySchema,
} from "../core/severity.ts";
import { CLAIM_KINDS } from "../core/models.ts";

// What the model is asked to return. Numeric ranges and string lengths are
// described rather than enforced in the schema, because providers' structured
// output modes support different subsets of JSON Schema; the validator clamps
// and checks afterwards.
const MODEL_KINDS = ["potential_issue", "refactor_suggestion", "nitpick"] as const;

export const modelFindingSchema = z.object({
  file: z.string().describe("Path exactly as given in the FILE header"),
  startLine: z.number().describe("New-file line number from the diff's left column"),
  endLine: z.number().describe("Last new-file line of the issue; equal to startLine for one line"),
  severity: severitySchema,
  category: categorySchema,
  kind: z.enum(MODEL_KINDS),
  effort: effortSchema,
  title: z.string().describe("One short sentence naming the problem"),
  body: z.string().describe("What is wrong and what to do; markdown"),
  impact: z.string().describe("What breaks, and for whom, if this ships; one or two sentences"),
  fixRationale: z
    .string()
    .describe("Why the suggestion or recommended change fixes it; one sentence, or an empty string when there is no fix"),
  suggestion: z
    .string()
    .nullable()
    .describe("Exact replacement code for startLine..endLine, or null"),
  confidence: z.number().describe("Your own estimate, 0 to 1, that the finding is correct"),
  evidence: evidenceSchema,
  evidenceNote: z
    .string()
    .describe("One sentence: the trigger and failure path, violated contract, or reproduction"),
  evidenceFiles: z.array(z.string()).describe("Other files the evidence relies on, if any"),
  ruleId: z.string().nullable().describe("The id of the repository rule this finding violates, or null"),
  claim: z
    .object({
      kind: z
        .enum(CLAIM_KINDS)
        .describe(
          "missing_path: the file or module at subject does not exist; unused_symbol: the identifier subject is never referenced; unreferenced_file: nothing imports or references the file at subject",
        ),
      subject: z.string().describe("An exact identifier, or a path relative to the repository root"),
    })
    .nullable()
    .describe("The checkable fact the finding rests on, or null"),
});
export type ModelFinding = z.infer<typeof modelFindingSchema>;

export const reviewOutputSchema = z.object({
  findings: z.array(modelFindingSchema),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const VERIFICATION_VERDICTS = ["confirmed", "refuted", "uncertain"] as const;

export const verificationOutputSchema = z.object({
  verdict: z.enum(VERIFICATION_VERDICTS),
  reason: z.string().describe("One or two sentences: why the finding holds, cannot happen, or cannot be decided"),
});
export type VerificationOutput = z.infer<typeof verificationOutputSchema>;

export const threadAnswerOutputSchema = z.object({
  answer: z.string().describe("The reply to post in the thread, in GitHub-flavoured markdown"),
});
export type ThreadAnswerOutput = z.infer<typeof threadAnswerOutputSchema>;

export const walkthroughOutputSchema = z.object({
  overview: z.string().describe("Two to five sentences on what the change does and why"),
  fileSummaries: z.array(z.object({ path: z.string(), summary: z.string() })),
  labels: z.array(z.string()).describe("Up to five short labels, e.g. bugfix, refactor, feature"),
  estimatedEffort: z.number().describe("Review effort from 1 (trivial) to 5 (very involved)"),
  blastRadius: z
    .enum(["small", "medium", "large"])
    .describe("How much of the system the change could break: small (local), medium (one feature or module), large (shared code, data, config or many callers)"),
});
export type WalkthroughOutput = z.infer<typeof walkthroughOutputSchema>;

export const ISSUE_ASSESSMENTS = ["addressed", "partial", "not_addressed", "unclear"] as const;

const sequenceDiagramField = z
  .string()
  .describe(
    'Mermaid "sequenceDiagram" source (no code fence) showing the main interaction the change adds or alters, or an empty string when the change has no meaningful interaction between components',
  );
const highLevelSummaryField = z.string().describe("The high-level summary, in markdown, following the summary instructions");
const linkedIssuesField = z
  .array(
    z.object({
      ref: z.string().describe("The issue reference exactly as given, e.g. #12"),
      assessment: z.enum(ISSUE_ASSESSMENTS),
      note: z.string().describe("One sentence on what is or is not addressed"),
    }),
  )
  .describe("One entry per linked issue given");
const relatedIssuesField = z
  .array(
    z.object({
      ref: z.string().describe("The candidate issue reference exactly as given, e.g. #12"),
      reason: z.string().describe("One short sentence on how it relates"),
    }),
  )
  .describe("Only candidate issues this change plausibly relates to; empty when none do");

export interface WalkthroughParts {
  sequenceDiagram: boolean;
  highLevelSummary: boolean;
  linkedIssues: boolean;
  relatedIssues: boolean;
}

// Only the enabled parts are requested, so a disabled part costs no output
// tokens and the model is never tempted to invent one.
export function walkthroughSchemaFor(parts: WalkthroughParts) {
  return walkthroughOutputSchema.extend({
    ...(parts.sequenceDiagram ? { sequenceDiagram: sequenceDiagramField } : {}),
    ...(parts.highLevelSummary ? { highLevelSummary: highLevelSummaryField } : {}),
    ...(parts.linkedIssues ? { linkedIssues: linkedIssuesField } : {}),
    ...(parts.relatedIssues ? { relatedIssues: relatedIssuesField } : {}),
  });
}

export type FullWalkthroughOutput = WalkthroughOutput & {
  sequenceDiagram?: string;
  highLevelSummary?: string;
  linkedIssues?: z.infer<typeof linkedIssuesField>;
  relatedIssues?: z.infer<typeof relatedIssuesField>;
};

// Repairs for replies that were not schema-enforced (see format.ts). They fix
// what a model predictably gets wrong; whatever still fails is dropped or
// rejected by the schema afterwards.

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function camelKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) out[snakeToCamel(key)] = field;
  return out;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback?: T): T | undefined {
  const normalised = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (allowed as readonly string[]).includes(normalised) ? (normalised as T) : fallback;
}

function numberValue(value: unknown): unknown {
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

function repairFinding(value: unknown): unknown {
  const entry = camelKeys(record(value));
  const startLine = numberValue(entry.startLine ?? entry.line);
  const ruleId = typeof entry.ruleId === "string" && entry.ruleId.trim() ? entry.ruleId.trim() : null;
  return {
    ...entry,
    startLine,
    endLine: numberValue(entry.endLine ?? startLine),
    // Severity and category decide what blocks, so an unknown value is not
    // guessed: the finding is dropped instead. A finding naming a rule is the
    // exception: the rule sets both, and one naming a rule it may not is
    // dropped by the validator, so the placeholder is never reported.
    severity: enumValue(entry.severity, SEVERITIES, ruleId ? "minor" : undefined),
    category: enumValue(entry.category, CATEGORIES, ruleId ? "maintainability" : undefined),
    kind: enumValue(entry.kind, MODEL_KINDS, "potential_issue"),
    effort: enumValue(entry.effort, EFFORTS, "moderate"),
    // Unverified is what the validator demotes, so it is the safe default.
    evidence: enumValue(entry.evidence, EVIDENCE, "unverified"),
    evidenceNote: entry.evidenceNote ?? "",
    impact: typeof entry.impact === "string" ? entry.impact : "",
    fixRationale: typeof entry.fixRationale === "string" ? entry.fixRationale : "",
    evidenceFiles: Array.isArray(entry.evidenceFiles) ? entry.evidenceFiles : [],
    suggestion: typeof entry.suggestion === "string" && entry.suggestion.trim() ? entry.suggestion : null,
    confidence: numberValue(entry.confidence),
    ruleId,
    claim: repairClaim(entry.claim),
  };
}

// A malformed claim is dropped rather than the finding: the claim only ever
// lets the repository remove a finding, so losing one keeps the finding.
function repairClaim(value: unknown): unknown {
  const claim = camelKeys(record(value));
  const kind = enumValue(claim.kind, CLAIM_KINDS);
  return kind && typeof claim.subject === "string" && claim.subject.trim() ? { kind, subject: claim.subject.trim() } : null;
}

// One malformed finding must not cost the whole pass.
export function repairReviewOutput(raw: unknown): unknown {
  const findings = record(raw).findings;
  if (!Array.isArray(findings)) return raw;
  return {
    findings: findings.flatMap((entry) => {
      const parsed = modelFindingSchema.safeParse(repairFinding(entry));
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

export function repairWalkthroughOutput(raw: unknown): unknown {
  const output = camelKeys(record(raw));
  const effort = Number(numberValue(output.estimatedEffort));
  return {
    ...output,
    fileSummaries: (Array.isArray(output.fileSummaries) ? output.fileSummaries : [])
      .map(record)
      .filter((entry) => typeof entry.path === "string" && typeof entry.summary === "string"),
    labels: Array.isArray(output.labels) ? output.labels.map(String) : [],
    estimatedEffort: Number.isFinite(effort) ? effort : 3,
    blastRadius: enumValue(output.blastRadius, ["small", "medium", "large"] as const, "medium"),
    // Optional parts: a malformed entry is dropped, a missing list is empty.
    ...(output.sequenceDiagram !== undefined ? { sequenceDiagram: String(output.sequenceDiagram ?? "") } : {}),
    ...(output.highLevelSummary !== undefined ? { highLevelSummary: String(output.highLevelSummary ?? "") } : {}),
    ...(output.linkedIssues !== undefined
      ? {
          linkedIssues: (Array.isArray(output.linkedIssues) ? output.linkedIssues : [])
            .map((entry) => camelKeys(record(entry)))
            .filter((entry) => typeof entry.ref === "string")
            .map((entry) => ({
              ref: entry.ref,
              assessment: enumValue(entry.assessment ?? entry.status, ISSUE_ASSESSMENTS, "unclear"),
              note: String(entry.note ?? ""),
            })),
        }
      : {}),
    ...(output.relatedIssues !== undefined
      ? {
          relatedIssues: (Array.isArray(output.relatedIssues) ? output.relatedIssues : [])
            .map((entry) => camelKeys(record(entry)))
            .filter((entry) => typeof entry.ref === "string")
            .map((entry) => ({ ref: entry.ref, reason: String(entry.reason ?? "") })),
        }
      : {}),
  };
}

// An unreadable verdict is left for the schema to reject: the call then
// counts as failed and the finding is kept unverified, never guessed at.
export function repairThreadAnswerOutput(raw: unknown): unknown {
  const output = camelKeys(record(raw));
  return { answer: String(output.answer ?? output.reply ?? "") };
}

export function repairVerificationOutput(raw: unknown): unknown {
  const output = camelKeys(record(raw));
  return {
    verdict: enumValue(output.verdict ?? output.status, VERIFICATION_VERDICTS),
    reason: String(output.reason ?? ""),
  };
}
