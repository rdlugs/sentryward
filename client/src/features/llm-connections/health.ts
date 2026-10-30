import type { ApiKey, LlmConnectionStatus, LlmProvider } from "./api"

// What a provider card shows, from the stored key and its latest check.
export type ConnectionState =
  | "blocked"
  | "unreadable"
  | "rejected"
  | "unverified"
  | "checking"
  | "active"
  | "server"
  | "none"

export function connectionState(key: ApiKey, status: LlmConnectionStatus | undefined): ConnectionState {
  // The policy refuses the provider whichever key is used, so it outranks
  // anything wrong with the key itself.
  if (key.blocked || status === "blocked") return "blocked"
  if (!key.stored) return key.serverDefault ? "server" : "none"
  // An unreadable key is never checked, so it has no status.
  if (key.undecryptable) return "unreadable"
  if (status === "revoked") return "rejected"
  if (status === "unreachable") return "unverified"
  return status === "active" ? "active" : "checking"
}

// The same rule as the sidebar's warning dot: only stored connections count,
// and a check not yet run is not a problem yet.
export function needsAttention(key: ApiKey, status: LlmConnectionStatus | undefined) {
  if (!key.stored) return false
  if (key.undecryptable || key.blocked) return true
  return status === "revoked" || status === "unreachable" || status === "blocked"
}

export function summarize(keys: ApiKey[], statuses: Partial<Record<LlmProvider, LlmConnectionStatus | undefined>>) {
  return {
    connected: keys.filter((key) => key.stored).length,
    total: keys.length,
    attention: keys.filter((key) => needsAttention(key, statuses[key.provider])).length,
  }
}
