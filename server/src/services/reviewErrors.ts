import type { ReviewStatus } from "../generated/prisma/client.ts";
import { CREDENTIALS_REJECTED_REASON } from "./providers/credentials.ts";
import { POLICY_PREFIX } from "./privacyPolicy.ts";
import { ACCESS_LOST_REASON, DISABLED_REASON } from "../worker/queue.ts";

// What a review's stored error is about, so the dashboard can link to the page
// that fixes it. Derived when the review is read rather than stored, so older
// jobs get one too; tests produce the worker's real messages to keep these
// patterns from drifting.
export type ReviewErrorKind =
  | "llm_connection"
  | "llm_config"
  | "forge_credentials"
  | "forge_access"
  | "repo_disabled"
  | "privacy"
  | "trigger";

const LLM_CONNECTION = [
  /^No API key for /m,
  /^The stored \w+ API key can't be decrypted/m,
  /^The selected \w+ LLM connection no longer exists/m,
  /^The \w+ LLM connection uses its official API and cannot run model /m,
];
const LLM_CONFIG = /^No LLM connection selected/m;
const FORGE_TOKEN = /^The stored \w+ token can't be decrypted/m;
const NO_REPOSITORY = "The repository is no longer connected";

// A failed review may store several errors joined by newlines, so the
// patterns look at every line; the first kind that matches wins.
export function errorKind(status: ReviewStatus, error: string | null): ReviewErrorKind | null {
  if (!error) return null;
  const lines = error.split("\n");
  if (lines.includes(DISABLED_REASON)) return "repo_disabled";
  if (lines.includes(ACCESS_LOST_REASON) || lines.includes(NO_REPOSITORY)) return "forge_access";
  if (lines.includes(CREDENTIALS_REJECTED_REASON) || FORGE_TOKEN.test(error)) return "forge_credentials";
  if (lines.some((line) => line.startsWith(POLICY_PREFIX))) return "privacy";
  if (LLM_CONNECTION.some((pattern) => pattern.test(error))) return "llm_connection";
  if (LLM_CONFIG.test(error)) return "llm_config";
  // The other reasons a run is skipped come from its trigger settings
  // (skipReason in worker/runJob.ts).
  if (status === "skipped") return "trigger";
  return null;
}
