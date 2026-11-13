import { agentTools, readsContext, type SearchBudget } from "../agent/tools.ts";
import type { Config } from "../config/schema.ts";
import type { ChangeSet, RejectedFinding } from "../core/models.ts";
import type { Chunk } from "../context/chunk.ts";
import type { ContextSource } from "../context/gather.ts";
import { ToolsUnsupportedError, agenticSystemPrompt, type AgenticResponse, type GenerateAgentic } from "./agentic.ts";
import { reviewSystemPrompt, reviewUserPrompt, type ManifestEntry } from "./prompt.ts";
import {
  callUsage,
  errorMessage,
  failedUsage,
  isAbort,
  ModelCallError,
  modelChain,
  spentBy,
  type SpentTokens,
} from "./providers.ts";
import type { ChunkReview } from "./review.ts";
import { repairReviewOutput, reviewOutputSchemaFor, type ReviewOutput } from "./schemas.ts";

export interface AgenticChunkReview extends ChunkReview {
  // What the pass read through its tools, as CONTEXT blocks for the verifier.
  toolContext: string;
}

// A pass that starts from the same diff and gathered context as a static one,
// and may read more before it reports. The model chain is tried in order like
// generateWithFallback; when no model can call tools, the error says so and
// the pipeline reviews the pass statically instead.
export async function reviewChunkAgentic(
  generateAgentic: GenerateAgentic,
  changeSet: ChangeSet,
  chunk: Chunk,
  totalChunks: number,
  config: Config,
  context: { source: ContextSource; searches: SearchBudget },
  rejected: RejectedFinding[] = [],
  manifest?: ManifestEntry[],
  focus?: string,
): Promise<AgenticChunkReview> {
  const models = modelChain(config.llm, "review");
  const errors: unknown[] = [];
  const failedAttempts: SpentTokens[] = [];
  const schema = reviewOutputSchemaFor(config);
  const system = agenticSystemPrompt(reviewSystemPrompt(config), schema, "code_review");
  for (const model of models) {
    // Each model starts its own budget; the searches stay shared.
    const { tools, reads } = agentTools({ ...context, maxToolTokens: config.review.agent.maxToolTokens });
    let response: AgenticResponse<ReviewOutput>;
    try {
      response = await generateAgentic({
        model,
        system,
        prompt: reviewUserPrompt(changeSet, chunk, totalChunks, config, rejected, manifest, focus),
        schema,
        schemaName: "code_review",
        repair: repairReviewOutput,
        temperature: config.llm.temperature,
        maxOutputTokens: config.llm.maxTokens,
        thinking: config.llm.thinking,
        tools,
        maxSteps: config.review.agent.maxSteps,
      });
    } catch (err) {
      // A cancelled review has no use for the fallbacks either.
      if (isAbort(err)) throw err;
      errors.push(err);
      failedAttempts.push(...spentBy(err));
      continue;
    }
    const spent = [...failedAttempts, ...(response.failedAttempts ?? [])];
    return {
      findings: response.object.findings,
      usage: {
        purpose: "review",
        model: response.model,
        ...callUsage(response),
        latencyMs: response.latencyMs,
        chunk: chunk.index,
        steps: response.steps,
        toolCalls: response.toolCalls,
      },
      failedUsage: failedUsage(spent, "review", chunk.index),
      warnings: response.warnings ?? [],
      toolContext: readsContext(reads),
    };
  }
  // One model without tools is enough for a static review to be worth it: it
  // tries the whole chain again, so a fallback that failed for another reason
  // (a 5xx, say) gets a second chance there.
  const unsupported = models.filter((_, i) => errors[i] instanceof ToolsUnsupportedError);
  if (unsupported.length) throw new ToolsUnsupportedError(unsupported.join(", "), failedAttempts);
  if (errors.length === 1) throw errors[0];
  throw new ModelCallError(errors.map((err, i) => `${models[i]}: ${errorMessage(err)}`).join(" | "), failedAttempts);
}
