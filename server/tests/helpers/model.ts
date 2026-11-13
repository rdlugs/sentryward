import type { GenerateRequest, GenerateResponse, Generate } from "../../src/review/llm/providers.ts";
import type { ModelFinding } from "../../src/review/llm/schemas.ts";

export function modelFinding(overrides: Partial<ModelFinding> = {}): ModelFinding {
  return {
    file: "src/app.ts",
    startLine: 11,
    endLine: 11,
    severity: "major",
    category: "bug",
    kind: "potential_issue",
    effort: "quick_win",
    title: "b overflows for large a",
    body: "Adding one can exceed the safe integer range.",
    impact: "",
    fixRationale: "",
    suggestion: null,
    confidence: 0.9,
    evidence: "execution_path",
    evidenceNote: "main() is called with Number.MAX_SAFE_INTEGER from the CLI.",
    evidenceFiles: [],
    ruleId: null,
    claim: null,
    ...overrides,
  };
}

type Responder = (request: GenerateRequest<unknown>) => unknown;

// A model that answers from `respond` by schema name and records every request.
export function fakeModel(respond: Record<string, Responder | unknown>) {
  const requests: GenerateRequest<unknown>[] = [];
  const generate: Generate = async <T>(request: GenerateRequest<T>): Promise<GenerateResponse<T>> => {
    requests.push(request as GenerateRequest<unknown>);
    const answer = respond[request.schemaName];
    const object = typeof answer === "function" ? (answer as Responder)(request as GenerateRequest<unknown>) : answer;
    if (object instanceof Error) throw object;
    if (object === undefined) throw new Error(`No fake answer for ${request.schemaName}`);
    return { object: object as T, model: request.model, inputTokens: 100, outputTokens: 20, latencyMs: 5 };
  };
  return { generate, requests };
}

export const WALKTHROUGH = {
  overview: "Adds b and c.",
  fileSummaries: [{ path: "src/app.ts", summary: "Two new constants." }],
  labels: ["feature"],
  estimatedEffort: 1,
  blastRadius: "small",
};
