import type { ChangeDetails, ReviewResult } from "../types"

// The change's branches: live from the forge when read, else what the review
// recorded, so they show while the details load or when the forge is down.
export function branchesOf(details: ChangeDetails | undefined, result: ReviewResult | null) {
  return {
    source: details?.sourceBranch ?? result?.change.headRef,
    target: details?.targetBranch ?? result?.change.baseRef,
  }
}
