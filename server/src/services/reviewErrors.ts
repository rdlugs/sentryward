import type { ReviewStatus } from "../generated/prisma/client.ts";
import { CREDENTIALS_REJECTED_REASON } from "./providers/credentials.ts";
import { POLICY_PREFIX } from "./privacyPolicy.ts";
import { ACCESS_LOST_REASON, DISABLED_REASON, NO_REPOSITORY_REASON } from "../worker/queue.ts";

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
  /^No API key for /,
  /^The stored \w+ API key can't be decrypted/,
  /^The selected \w+ LLM connection no longer exists/,
  /^The \w+ LLM connection uses its official API and cannot run model /,
];
const LLM_CONFIG = /^No LLM connection selected/;
const FORGE_TOKEN = /^The stored \w+ token can't be decrypted/;
// How the pipeline records a failed pass (review/pipeline.ts).
const PASS_PREFIX = /^Review pass \d+ failed: /;

// A failed review may store several errors joined by newlines, each possibly
// wrapped as a failed pass, so the patterns look at every line with that
// prefix removed; the first kind that matches wins.
export function errorKind(status: ReviewStatus, error: string | null): ReviewErrorKind | null {
  if (!error) return null;
  const lines = error.split("\n").map((line) => line.replace(PASS_PREFIX, ""));
  const any = (pattern: RegExp) => lines.some((line) => pattern.test(line));
  if (lines.includes(DISABLED_REASON)) return "repo_disabled";
  if (lines.includes(ACCESS_LOST_REASON) || lines.includes(NO_REPOSITORY_REASON)) return "forge_access";
  if (lines.includes(CREDENTIALS_REJECTED_REASON) || any(FORGE_TOKEN)) return "forge_credentials";
  if (lines.some((line) => line.startsWith(POLICY_PREFIX))) return "privacy";
  if (LLM_CONNECTION.some(any)) return "llm_connection";
  if (any(LLM_CONFIG)) return "llm_config";
  // The other reasons a run is skipped come from its trigger settings
  // (skipReason in worker/runJob.ts).
  if (status === "skipped") return "trigger";
  return null;
}
