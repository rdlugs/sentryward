import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/review/config/schema.ts";
import { CREDENTIALS_REJECTED_REASON } from "../src/services/providers/credentials.ts";
import { UnreadableTokenError } from "../src/services/providers/token.ts";
import { PolicyViolation } from "../src/services/privacyPolicy.ts";
import { errorKind } from "../src/services/reviewErrors.ts";
import { resolveLlm, type LlmCredentials } from "../src/worker/llmEndpoint.ts";
import { ACCESS_LOST_REASON, DISABLED_REASON } from "../src/worker/queue.ts";
import { skipReason } from "../src/worker/runJob.ts";

const noCredentials: LlmCredentials = { keys: {}, baseUrls: {}, connections: {} };

function withLlm(llm: Partial<Config["llm"]>): Config {
  return { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, ...llm } };
}

// The worker's own message for a config, so a rewording there fails here.
function llmError(config: Config, credentials = noCredentials): string {
  try {
    resolveLlm(config, [config.llm.model], credentials);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("resolveLlm did not throw");
}

describe("errorKind", () => {
  it("has none without an error, or for an error it does not recognise", () => {
    expect(errorKind("completed", null)).toBeNull();
    expect(errorKind("failed", "Model call timed out")).toBeNull();
  });

  it("points at LLM connections for a missing, removed or mismatched connection", () => {
    const missingKey = llmError(withLlm({ baseUrl: "http://llm.internal", endpointKey: "openai" }));
    const removed = llmError(withLlm({ connection: "openai" }));
    const mismatch = llmError(withLlm({ connection: "openai" }), {
      ...noCredentials,
      connections: { openai: { apiKey: "sk" } },
    });

    expect(errorKind("failed", missingKey)).toBe("llm_connection");
    expect(errorKind("failed", removed)).toBe("llm_connection");
    expect(errorKind("failed", mismatch)).toBe("llm_connection");
    // Thrown from services/llm.ts while reading the stored keys.
    expect(
      errorKind("failed", "The stored openai API key can't be decrypted; re-enter it in Settings > API keys"),
    ).toBe("llm_connection");
  });

  it("points at the review settings when no connection is selected", () => {
    expect(errorKind("failed", llmError(withLlm({})))).toBe("llm_config");
  });

  it("tells forge credentials apart from lost access and a repository turned off", () => {
    expect(errorKind("failed", CREDENTIALS_REJECTED_REASON)).toBe("forge_credentials");
    expect(errorKind("failed", new UnreadableTokenError("gitlab").message)).toBe("forge_credentials");
    expect(errorKind("skipped", ACCESS_LOST_REASON)).toBe("forge_access");
    expect(errorKind("failed", "The repository is no longer connected")).toBe("forge_access");
    expect(errorKind("skipped", DISABLED_REASON)).toBe("repo_disabled");
    expect(errorKind("cancelled", DISABLED_REASON)).toBe("repo_disabled");
  });

  it("points at the privacy policy for a blocked model", () => {
    const blocked = new PolicyViolation("workspace", "provider", "openai/gpt-5", "api.openai.com", ["anthropic"]);
    expect(errorKind("failed", blocked.message)).toBe("privacy");
  });

  it("blames the trigger settings for any other skip", () => {
    const draft = skipReason(
      { trigger: "webhook" },
      DEFAULT_CONFIG,
      { isDraft: true, title: "WIP", labels: [], author: "dev", headRef: "feature", baseRef: "main" },
    );
    expect(draft).not.toBeNull();
    expect(errorKind("skipped", draft)).toBe("trigger");
  });

  it("finds a known error among several stored on one line each", () => {
    const blocked = new PolicyViolation("instance", "local_only", "openai/gpt-5", "api.openai.com");
    expect(errorKind("failed", `Chunk 2 failed: timeout\n${blocked.message}`)).toBe("privacy");
  });
});
