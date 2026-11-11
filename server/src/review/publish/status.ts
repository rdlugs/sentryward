import type { ReviewResult } from "../core/models.ts";
import type { CommitStatus } from "../forge/types.ts";
import { plural } from "../core/plural.ts";

// The commit status states the verdict, decided once in core/verdict.ts.
export function commitStatus(result: ReviewResult, targetUrl?: string): CommitStatus {
  const { verdict, blockOn, blocking } = result.verdict;
  const url = targetUrl ? { targetUrl } : {};
  if (verdict === "blocked") {
    return { state: "failure", description: `${plural(blocking.length, "finding")} at or above ${blockOn}`, ...url };
  }
  if (verdict === "pass") {
    return { state: "success", description: `No findings at or above ${blockOn}`, ...url };
  }
  return { state: "error", description: "Review incomplete; see the summary comment", ...url };
}

export function pendingStatus(targetUrl?: string): CommitStatus {
  return { state: "pending", description: "Review in progress", ...(targetUrl ? { targetUrl } : {}) };
}
