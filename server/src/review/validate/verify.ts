import type { Config } from "../config/schema.ts";
import { mapLimit } from "../core/mapLimit.ts";
import type { ChangeSet, Finding, LlmUsage } from "../core/models.ts";
import { atLeast } from "../core/severity.ts";
import { isBlocking } from "../core/verdict.ts";
import { contextTokenBudget, diffTokenBudget, estimateTokens } from "../context/budget.ts";
import type { Chunk, ChunkPart } from "../context/chunk.ts";
import type { ContextBlock } from "../context/fileContext.ts";
import { fillContext } from "../context/gather.ts";
import { renderFileDiff } from "../context/diffText.ts";
import { VERIFY_SYSTEM_PROMPT } from "../llm/prompt.ts";
import { errorMessage, failedUsage, modelChain, spentBy, type Generate } from "../llm/providers.ts";
import { VERIFY_OUTPUT_TOKENS, verifyFinding, type FindingVerification } from "../llm/verify.ts";
import { ruleFloor } from "../rules.ts";
import { compareFindings, demoteFinding, stronger, type DropReason } from "./validator.ts";

export interface VerifyInput {
  findings: Finding[];
  changeSet: ChangeSet;
  // The passes that ran, for the diff and context each finding came from.
  chunks: Chunk[];
  config: Config;
  generate: Generate;
  concurrency: number;
  // Fingerprints this team dismissed on this change. Checked again here because
  // demoting an uncertain finding changes its kind and so its fingerprint: one
  // the validator passed can land on an ignored fingerprint only after verify.
  ignoredFingerprints?: ReadonlySet<string>;
}

export interface VerifyResult {
  findings: Finding[];
  dropped: Partial<Record<DropReason, number>>;
  demoted: number;
  usage: LlmUsage[];
  warnings: string[];
}

// Fixed prompt text next to the measured system prompt, as for a pass.
const PROMPT_ALLOWANCE = 3_000;
const DIFF_PRIORITY = { flagged: 0, evidence: 1, file: 2, pass: 3 } as const;

function shows(part: ChunkPart, finding: Finding): boolean {
  return (
    part.file.path === finding.file &&
    part.hunks.some((hunk) => finding.startLine >= hunk.newStart && finding.startLine < hunk.newStart + Math.max(hunk.newLines, 1))
  );
}

// The verifier gets what the reviewing pass relied on, nothing fetched anew,
// within the same budget a pass has: the hunks the finding points at first,
// then the files its evidence names (from whichever pass had them), then the
// rest of its file, then the rest of the pass that reported it. A large file
// spans several passes, so its other parts must not crowd out the flagged
// line; and without the files it names, a finding about a caller broken by a
// changed helper would be judged without the helper.
function codeFor(finding: Finding, chunks: Chunk[], config: Config): { diff: string; context: string } {
  const evidence = new Set(finding.evidenceFiles);
  const ofFile = chunks.filter((chunk) => chunk.parts.some((part) => part.file.path === finding.file));
  // A finding off the diff (review.fullFile) is in no hunk; any pass with its file reported it.
  const flagged = ofFile.filter((chunk) => chunk.parts.some((part) => shows(part, finding)));
  const reporting = flagged.length ? flagged : ofFile;
  const blocks: ContextBlock[] = [];
  const add = (part: ChunkPart, priority: number) => {
    const text = renderFileDiff(part.file, part.hunks);
    blocks.push({ path: part.file.path, label: "diff", priority, text, tokens: estimateTokens(text) });
  };
  for (const chunk of chunks) {
    for (const part of chunk.parts) {
      if (part.file.path === finding.file) add(part, shows(part, finding) ? DIFF_PRIORITY.flagged : DIFF_PRIORITY.file);
      else if (evidence.has(part.file.path)) add(part, DIFF_PRIORITY.evidence);
      else if (reporting.includes(chunk)) add(part, DIFF_PRIORITY.pass);
    }
  }
  const overhead = estimateTokens(VERIFY_SYSTEM_PROMPT) + PROMPT_ALLOWANCE;
  const sizing = verifySizing(config);
  const diff = fillContext(blocks, diffTokenBudget(sizing, overhead));
  // An agentic pass's reads come after what was gathered for it: the verifier
  // sees the code the finding was reported from.
  const texts = [...reporting, ...ofFile].flatMap((chunk) => [chunk.context, chunk.toolContext ?? ""]);
  const contexts = [...new Set(texts.filter(Boolean))].map(
    (text, index): ContextBlock => ({ path: "", label: "context", priority: index, text, tokens: estimateTokens(text) }),
  );
  return { diff, context: fillContext(contexts, contextTokenBudget(sizing, overhead, estimateTokens(diff))) };
}

// The budget helpers size a prompt from config.llm, which describes a review
// pass. A verify call runs its own model at its own thinking level with a
// smaller reply, and its prompt must leave room for exactly that reply.
function verifySizing(config: Config): Config {
  return {
    ...config,
    llm: {
      ...config.llm,
      model: modelChain(config.llm, "verify")[0]!,
      thinking: config.llm.verifyThinking ?? config.llm.thinking,
      maxTokens: Math.min(config.llm.maxTokens, VERIFY_OUTPUT_TOKENS),
    },
  };
}

// Whether a run verifies at all. Shared with the worker's step list, so the
// dashboard lists the step exactly when the pipeline reports it.
export function verifies(config: Config): boolean {
  return config.review.verify !== "off";
}

// A second, independent look at the findings that matter. Verification only
// ever weakens a finding: a refuted one is dropped, an uncertain one demoted,
// and a failed call keeps the finding as the review reported it.
export async function verifyFindings(input: VerifyInput): Promise<VerifyResult> {
  const { findings, config } = input;
  const mode = config.review.verify;
  const result: VerifyResult = { findings, dropped: {}, demoted: 0, usage: [], warnings: [] };
  const candidates =
    mode === "off" ? [] : findings.filter((finding) => mode === "all" || isBlocking(finding, config.review.blockOn));
  if (!candidates.length) return result;

  const outcomes = new Map<Finding, FindingVerification | { error: string; failedUsage: LlmUsage[] }>();
  await mapLimit(candidates, input.concurrency, async (finding) => {
    try {
      outcomes.set(
        finding,
        await verifyFinding(input.generate, input.changeSet, finding, codeFor(finding, input.chunks, config), config),
      );
    } catch (err) {
      outcomes.set(finding, { error: errorMessage(err), failedUsage: failedUsage(spentBy(err), "verify") });
    }
  });

  const drop = (reason: DropReason) => {
    result.dropped[reason] = (result.dropped[reason] ?? 0) + 1;
  };
  const failures: string[] = [];
  const kept = new Map<string, Finding>();
  for (const finding of findings) {
    const outcome = outcomes.get(finding);
    let next = finding;
    if (outcome) result.usage.push(...outcome.failedUsage);
    if (outcome && "error" in outcome) {
      failures.push(outcome.error);
    } else if (outcome) {
      result.usage.push(outcome.usage);
      result.warnings.push(...outcome.warnings);
      if (outcome.verdict === "refuted") {
        drop("refuted");
        continue;
      }
      // Recorded so readers can see a finding survived a second look; a failed
      // call leaves it not_checked, as reported.
      next = { ...finding, verification: outcome.verdict === "confirmed" ? "verified" : "uncertain" };
      if (outcome.verdict === "uncertain" && finding.kind !== "verification_needed") {
        next = demoteFinding(next, input.changeSet);
        result.demoted += 1;
        if (!atLeast(next.severity, ruleFloor(config, next.source === "rule" ? next.ruleId : undefined))) {
          drop("below_floor");
          continue;
        }
      }
    }
    // Demotion can land a finding on an ignored fingerprint it did not have at
    // validation time, so re-check before it is kept.
    if (input.ignoredFingerprints?.has(next.fingerprint)) {
      drop("previously_ignored");
      continue;
    }
    // A demoted finding can land on the fingerprint of one already kept.
    const existing = kept.get(next.fingerprint);
    if (existing) drop("duplicate");
    kept.set(next.fingerprint, existing ? stronger(existing, next) : next);
  }

  if (failures.length) {
    const count = failures.length === 1 ? "1 finding" : `${failures.length} findings`;
    result.warnings.push(`Verification failed for ${count}, kept as reported: ${failures[0]}`);
  }
  result.findings = [...kept.values()].sort(compareFindings);
  return result;
}
