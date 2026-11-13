import type { Config } from "../config/schema.ts";
import type { ChangeSet, LlmUsage, RejectedFinding } from "../core/models.ts";
import type { Chunk } from "../context/chunk.ts";
import { reviewSystemPrompt, reviewUserPrompt, type ManifestEntry } from "./prompt.ts";
import { callUsage, failedUsage, type Generate, generateWithFallback, modelChain } from "./providers.ts";
import { repairReviewOutput, reviewOutputSchemaFor, type ModelFinding } from "./schemas.ts";

export interface ChunkReview {
  findings: ModelFinding[];
  usage: LlmUsage;
  // Models tried first whose replies were unusable.
  failedUsage: LlmUsage[];
  // What the calls had to give up, e.g. thinking the endpoint refused.
  warnings: string[];
}

export async function reviewChunk(
  generate: Generate,
  changeSet: ChangeSet,
  chunk: Chunk,
  totalChunks: number,
  config: Config,
  rejected: RejectedFinding[] = [],
  manifest?: ManifestEntry[],
): Promise<ChunkReview> {
  const response = await generateWithFallback(generate, modelChain(config.llm, "review"), {
    system: reviewSystemPrompt(config),
    prompt: reviewUserPrompt(changeSet, chunk, totalChunks, config, rejected, manifest),
    schema: reviewOutputSchemaFor(config),
    schemaName: "code_review",
    repair: repairReviewOutput,
    temperature: config.llm.temperature,
    maxOutputTokens: config.llm.maxTokens,
    thinking: config.llm.thinking,
  });
  return {
    findings: response.object.findings,
    usage: {
      purpose: "review",
      model: response.model,
      ...callUsage(response),
      latencyMs: response.latencyMs,
      chunk: chunk.index,
    },
    failedUsage: failedUsage(response.failedAttempts ?? [], "review", chunk.index),
    warnings: response.warnings ?? [],
  };
}
