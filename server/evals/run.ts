// Reviews every corpus case with a real model and scores the findings against
// the case's expectations. Costs money, so it is never part of `npm test`.
//
//   npm run eval -- --model anthropic/claude-sonnet-5-5 [--case a,b] [--out file]
//                   [--thinking off|low|medium|high] [--context static|agentic] [--compare]
//
// --compare reviews every case twice, once with thinking off and static
// context and once with the settings given (thinking defaults to medium), and
// prints recall and cost side by side.
//
// See README "Review quality evals" for the options and how to add a case.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { CONTEXT_MODES, DEFAULT_CONFIG, THINKING_LEVELS } from "../src/review/config/schema.ts";
import { createGenerateAgentic } from "../src/review/llm/agentic.ts";
import { memoryLedger } from "../src/review/llm/capabilities.ts";
import type { ThinkingLevel } from "../src/review/llm/thinking.ts";
import {
  createGenerate,
  missingKeys,
  providerOf,
  type ApiKeys,
  type ProviderBaseUrls,
} from "../src/review/llm/providers.ts";
import { loadCorpus } from "./corpus.ts";
import { evaluate, type CaseReport, type EvalOptions, type EvalRun } from "./evaluate.ts";
import { DEFAULT_MATCH_OPTIONS } from "./match.ts";
import { parsePrice } from "./pricing.ts";

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: DEFAULT_CONFIG.llm.model },
    case: { type: "string" },
    concurrency: { type: "string", default: "2" },
    out: { type: "string" },
    tolerance: { type: "string", default: String(DEFAULT_MATCH_OPTIONS.tolerance) },
    "strict-category": { type: "boolean", default: false },
    price: { type: "string" },
    "base-url": { type: "string" },
    thinking: { type: "string" },
    context: { type: "string" },
    compare: { type: "boolean", default: false },
  },
});

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function positiveInt(name: string, text: string, min: number): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`);
  return value;
}

// Read straight from the environment rather than services/llm.ts, which would
// pull in the API's env validation and Prisma: an eval needs neither a
// database nor the server's secrets.
const keys: ApiKeys = {
  anthropic: process.env.ANTHROPIC_API_KEY || undefined,
  openai: process.env.OPENAI_API_KEY || undefined,
  google: process.env.GOOGLE_GENERATIVE_AI_API_KEY || undefined,
};

// The container has no git, so a SHA can also be handed in.
function gitSha(): string | null {
  if (process.env.EVAL_GIT_SHA) return process.env.EVAL_GIT_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const percent = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(0)}%`);
const usd = (value: number | null) => (value === null ? "n/a" : `$${value.toFixed(4)}`);

function row(report: CaseReport): string {
  const s = report.score;
  const cells = s
    ? [
        `${s.truePositives}/${report.expected.length}`,
        String(s.falsePositives),
        s.trapHits ? String(s.trapHits) : "",
        percent(s.precision),
        percent(s.recall),
      ]
    : [report.status, "", "", "", ""];
  return [report.id.padEnd(32), ...cells.map((cell) => cell.padStart(7)), usd(report.costUsd).padStart(10)].join(" ");
}

function printRun(run: EvalRun) {
  console.log(["case".padEnd(32), ..."found fp traps prec recall".split(" ").map((h) => h.padStart(7)), "cost".padStart(10)].join(" "));
  for (const report of run.cases) {
    console.log(row(report));
    if (report.error) console.log(`  ${report.error}`);
  }
  const t = run.totals;
  const steps = run.cases.reduce((total, report) => total + report.usage.steps, 0);
  const reasoning = run.cases.reduce((total, report) => total + report.usage.reasoningTokens, 0);
  console.log(
    `\nprecision ${percent(t.precision)}  recall ${percent(t.recall)}  f1 ${percent(t.f1)}` +
      `  category ${percent(t.categoryAgreement)}  traps hit ${t.trapHits}` +
      `  clean-case FPs ${t.cleanCaseFalsePositives}/${t.cleanCases} cases` +
      `  no-op suggestions ${t.noopSuggestions}` +
      `  errored ${t.errored}  tokens ${t.inputTokens}/${t.outputTokens}` +
      (reasoning ? `  reasoning ${reasoning}` : "") +
      (steps ? `  agent steps ${steps}` : "") +
      `  cost ${usd(t.costUsd)}\n`,
  );
}

async function main() {
  const model = args.model!;
  const baseUrls: ProviderBaseUrls = args["base-url"] ? { [providerOf(model)]: args["base-url"] } : {};
  const missing = missingKeys([model], keys, undefined, baseUrls);
  if (missing.length > 0) {
    throw new Error(`No API key for ${missing.join(", ")}: set it in the environment (the worker container has them).`);
  }
  const thinking = oneOf("thinking", args.thinking, THINKING_LEVELS);
  const context = oneOf("context", args.context, CONTEXT_MODES);
  const options: EvalOptions = {
    model,
    concurrency: positiveInt("concurrency", args.concurrency!, 1),
    match: { tolerance: positiveInt("tolerance", args.tolerance!, 0), strictCategory: args["strict-category"]! },
    ...(args.price ? { price: parsePrice(args.price) } : {}),
  };
  const cases = loadCorpus(args.case?.split(",").map((id) => id.trim()).filter(Boolean));
  const settings: { label: string; thinking?: ThinkingLevel; context?: EvalOptions["context"] }[] = args.compare
    ? [
        { label: "baseline", thinking: "off", context: "static" },
        { label: "candidate", thinking: thinking ?? "medium", context: context ?? "static" },
      ]
    : [{ label: "run", ...(thinking ? { thinking } : {}), ...(context ? { context } : {}) }];

  const startedAt = new Date();
  const runs: (EvalRun & { label: string; thinking?: string; context?: string })[] = [];
  for (const setting of settings) {
    const described = [setting.thinking && `thinking ${setting.thinking}`, setting.context && `${setting.context} context`]
      .filter(Boolean)
      .join(", ");
    console.log(`Reviewing ${cases.length} case(s) with ${model}${described ? ` (${described})` : ""}...\n`);
    // One ledger per run, as one review would have: what the endpoint refuses
    // is learned once rather than per call.
    const { ledger } = memoryLedger();
    const run = await evaluate(
      cases,
      {
        generate: createGenerate(keys, undefined, baseUrls, { ledger }),
        generateAgentic: createGenerateAgentic(keys, undefined, baseUrls, { ledger }),
      },
      { ...options, ...(setting.thinking ? { thinking: setting.thinking } : {}), ...(setting.context ? { context: setting.context } : {}) },
    );
    printRun(run);
    runs.push({ ...setting, ...run });
  }
  if (runs.length === 2) {
    const [a, b] = [runs[0]!, runs[1]!];
    console.log(
      `\ncompare  recall ${percent(a.totals.recall)} -> ${percent(b.totals.recall)}` +
        `  precision ${percent(a.totals.precision)} -> ${percent(b.totals.precision)}` +
        `  no-op suggestions ${a.totals.noopSuggestions} -> ${b.totals.noopSuggestions}` +
        `  cost ${usd(a.totals.costUsd)} -> ${usd(b.totals.costUsd)}`,
    );
  }

  const out =
    args.out ??
    join(import.meta.dirname, "reports", `${startedAt.toISOString().replace(/[:.]/g, "-")}-${model.replace(/[^\w.-]+/g, "_")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  const report = {
    model,
    gitSha: gitSha(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    options,
    // A single run keeps the report shape it always had.
    ...(runs.length === 1 ? runs[0] : { runs }),
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${relative(process.cwd(), out)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
