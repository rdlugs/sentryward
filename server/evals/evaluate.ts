import { resolveConfig } from "../src/review/config/resolve.ts";
import type { CONTEXT_MODES, Config } from "../src/review/config/schema.ts";
import type { LlmUsage, ReviewStatus } from "../src/review/core/models.ts";
import { mapLimit } from "../src/review/core/mapLimit.ts";
import type { GenerateAgentic } from "../src/review/llm/agentic.ts";
import type { Generate } from "../src/review/llm/providers.ts";
import type { ThinkingLevel } from "../src/review/llm/thinking.ts";
import { runReview } from "../src/review/pipeline.ts";
import { caseContext } from "./context.ts";
import type { EvalCase, Expected } from "./corpus.ts";
import { scoreCase, summarize, type CaseScore, type MatchOptions, type Totals } from "./match.ts";
import { costOf, type Price } from "./pricing.ts";

export interface EvalOptions {
  model: string;
  match: MatchOptions;
  // Cases reviewed at once; each review also runs its passes concurrently.
  concurrency: number;
  price?: Price;
  // What is being compared; absent keeps the case's own (or the default) setting.
  thinking?: ThinkingLevel;
  context?: (typeof CONTEXT_MODES)[number];
}

// The model calls a run makes: agentic passes need their own.
export interface EvalModels {
  generate: Generate;
  generateAgentic?: GenerateAgentic;
}

export interface CaseReport {
  id: string;
  title: string;
  language: string;
  status: ReviewStatus | "error";
  // Set when the review failed or threw; the case is then left out of the rates.
  error?: string;
  warnings: string[];
  expected: Expected[];
  score?: CaseScore;
  // Committable suggestions the validator removed for changing nothing; a
  // prompt that lowers this wastes fewer "apply" buttons.
  noopSuggestions: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    reasoningTokens: number;
    // Agentic passes only: model calls and tool calls by name.
    steps: number;
    toolCalls: Record<string, number>;
    byPurpose: Partial<Record<LlmUsage["purpose"], { calls: number; inputTokens: number; outputTokens: number }>>;
  };
  costUsd: number | null;
}

export interface EvalRun {
  cases: CaseReport[];
  totals: Totals & { inputTokens: number; outputTokens: number; noopSuggestions: number; costUsd: number | null };
}

// The config a case is reviewed with: production defaults, the case's own
// override, then the model under test with no fallbacks, so a run measures one
// model only.
export function caseConfig(evalCase: EvalCase, model: string, settings: Pick<EvalOptions, "thinking" | "context"> = {}): Config {
  return resolveConfig({
    trigger: {
      ...evalCase.config,
      llm: {
        ...evalCase.config.llm,
        model,
        fallbackModels: [],
        ...(settings.thinking ? { thinking: settings.thinking } : {}),
      },
      review: { ...evalCase.config.review, ...(settings.context ? { context: settings.context } : {}) },
    },
  }).config;
}

function summarizeUsage(usage: LlmUsage[]): CaseReport["usage"] {
  const byPurpose: CaseReport["usage"]["byPurpose"] = {};
  for (const call of usage) {
    const entry = (byPurpose[call.purpose] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
    entry.calls += 1;
    entry.inputTokens += call.inputTokens;
    entry.outputTokens += call.outputTokens;
  }
  const toolCalls: Record<string, number> = {};
  for (const call of usage) {
    for (const [name, count] of Object.entries(call.toolCalls ?? {})) toolCalls[name] = (toolCalls[name] ?? 0) + count;
  }
  return {
    inputTokens: usage.reduce((total, call) => total + call.inputTokens, 0),
    outputTokens: usage.reduce((total, call) => total + call.outputTokens, 0),
    latencyMs: usage.reduce((total, call) => total + call.latencyMs, 0),
    reasoningTokens: usage.reduce((total, call) => total + (call.reasoningTokens ?? 0), 0),
    steps: usage.reduce((total, call) => total + (call.steps ?? 0), 0),
    toolCalls,
    byPurpose,
  };
}

export async function evaluateCase(evalCase: EvalCase, models: EvalModels, options: EvalOptions): Promise<CaseReport> {
  const base = { id: evalCase.id, title: evalCase.title, language: evalCase.language, expected: evalCase.expected };
  try {
    const result = await runReview(
      { changeSet: evalCase.changeSet, config: caseConfig(evalCase, options.model, options) },
      {
        generate: models.generate,
        context: caseContext(evalCase.dir),
        ...(models.generateAgentic ? { generateAgentic: models.generateAgentic } : {}),
      },
    );
    const usage = summarizeUsage(result.usage);
    if (result.status === "failed") {
      // A call that threw (e.g. on a malformed response) may still have been
      // billed, and its usage is not in the result, so the cost is unknown.
      return {
        ...base,
        status: "failed",
        error: result.errors.join("; "),
        warnings: result.warnings,
        noopSuggestions: result.validation.noopSuggestions ?? 0,
        usage,
        costUsd: null,
      };
    }
    const costUsd = costOf(result.usage, options.price);
    return {
      ...base,
      status: result.status,
      warnings: result.warnings,
      score: scoreCase(result.findings, evalCase.expected, evalCase.traps, options.match),
      noopSuggestions: result.validation.noopSuggestions ?? 0,
      usage,
      costUsd,
    };
  } catch (err) {
    // The throw may have come after billable calls, whose usage is lost with
    // the result, so the cost is unknown rather than zero.
    return {
      ...base,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      warnings: [],
      noopSuggestions: 0,
      usage: summarizeUsage([]),
      costUsd: null,
    };
  }
}

export async function evaluate(cases: EvalCase[], models: EvalModels, options: EvalOptions): Promise<EvalRun> {
  const reports = await mapLimit(cases, options.concurrency, (evalCase) => evaluateCase(evalCase, models, options));
  const costs = reports.map((report) => report.costUsd);
  return {
    cases: reports,
    totals: {
      ...summarize(reports.map((report) => ({ expectedCount: report.expected.length, score: report.score }))),
      inputTokens: reports.reduce((total, report) => total + report.usage.inputTokens, 0),
      outputTokens: reports.reduce((total, report) => total + report.usage.outputTokens, 0),
      noopSuggestions: reports.reduce((total, report) => total + report.noopSuggestions, 0),
      costUsd: costs.includes(null) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0),
    },
  };
}
