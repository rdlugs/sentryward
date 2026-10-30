import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"

const API_KEYS_QUERY_KEY = ["settings", "api-keys"]

export type LlmProvider = "anthropic" | "openai" | "google" | "ollama"
// blocked: the privacy policy refuses the connection's host or provider.
export type LlmConnectionStatus = "active" | "revoked" | "unreachable" | "blocked"

// Shared with the status filter and the status badge so both read the same.
export const STATUS_LABELS: Record<LlmConnectionStatus, string> = {
  active: "Active",
  revoked: "Key rejected",
  unreachable: "Couldn't verify",
  blocked: "Blocked by policy",
}

export interface ApiKey {
  provider: LlmProvider
  stored: boolean
  last4: string | null
  // Saved under a different server ENCRYPTION_KEY; only replacing it helps.
  undecryptable: boolean
  baseUrl: string | null
  updatedAt: string | null
  serverDefault: boolean
  // The privacy policy refuses this provider or its host, whichever key is used.
  blocked: boolean
}

export function useApiKeys() {
  return useQuery({
    queryKey: API_KEYS_QUERY_KEY,
    queryFn: () => api<{ keys: ApiKey[] }>("/settings/api-keys"),
  })
}

function apiKeyStatusQuery(provider: LlmProvider) {
  return {
    queryKey: [...API_KEYS_QUERY_KEY, provider, "status"],
    queryFn: () => api<{ status: LlmConnectionStatus }>(`/settings/api-keys/${provider}/status`),
    staleTime: 60_000,
    retry: false,
  }
}

// Each provider is checked independently so one slow host does not delay the
// other badges. Undefined means its request is still in progress. With live
// off, only a check some page already ran is read, since each one calls the
// provider.
export function useApiKeyStatuses(
  keys: ApiKey[],
  { live = true }: { live?: boolean } = {},
): Partial<Record<LlmProvider, LlmConnectionStatus | undefined>> {
  return useQueries({
    queries: keys.map((key) => ({ ...apiKeyStatusQuery(key.provider), enabled: live })),
    combine: (results) =>
      Object.fromEntries(
        results.map((result, index) => [
          keys[index]!.provider,
          result.isError ? "unreachable" : result.data?.status,
        ]),
      ),
  })
}

// One provider's check, for a card or details sheet that shows when it last ran
// and can run it again. Shares its cache entry with useApiKeyStatuses.
export function useApiKeyStatus(provider: LlmProvider, { enabled = true }: { enabled?: boolean } = {}) {
  const query = useQuery({ ...apiKeyStatusQuery(provider), enabled })
  const status: LlmConnectionStatus | undefined = query.isError ? "unreachable" : query.data?.status
  const checkedAt = Math.max(query.dataUpdatedAt, query.errorUpdatedAt) || null
  return { status, checkedAt, isFetching: query.isFetching, refetch: query.refetch }
}

// Feeds the model pickers. Saving or deleting a key invalidates the api-keys
// prefix, so a changed connection lists afresh.
export function useLlmModels(provider: LlmProvider | null) {
  return useQuery({
    queryKey: [...API_KEYS_QUERY_KEY, provider, "models"],
    queryFn: () => api<{ models: string[] }>(`/settings/api-keys/${provider}/models`),
    enabled: Boolean(provider),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export type ThinkingSupport = "options" | "model" | "none"

// What a probe or a review found one model supports on this connection; null
// is unknown.
export interface ModelCapability {
  model: string
  // The custom host, or null for the provider's official API.
  endpoint: string | null
  thinking: ThinkingSupport | null
  tools: boolean | null
  source: "probe" | "runtime"
  detail: string | null
  checkedAt: string
}

export type ModelTestResult =
  | {
      ok: true
      latencyMs: number
      inputTokens: number
      outputTokens: number
      // Absent when the probe after the test could not run.
      capabilities?: { thinking: ThinkingSupport | null; tools: boolean | null; detail: string }
    }
  | { ok: false; reason: "revoked" | "model" | "unreachable" | "output"; message: string }

export function useLlmCapabilities(provider: LlmProvider | null) {
  return useQuery({
    queryKey: [...API_KEYS_QUERY_KEY, provider, "capabilities"],
    queryFn: () => api<{ capabilities: ModelCapability[] }>(`/settings/api-keys/${provider}/capabilities`),
    enabled: Boolean(provider),
  })
}

// A passing test probes the model and stores what it found, so the
// connection's capabilities are read afresh.
export function useTestLlmModel() {
  const queryClient = useQueryClient()
  return useMutation({
    onSuccess: (_data, { provider }) =>
      queryClient.invalidateQueries({ queryKey: [...API_KEYS_QUERY_KEY, provider, "capabilities"] }),
    mutationFn: ({ provider, model }: { provider: LlmProvider; model: string }) =>
      api<{ result: ModelTestResult }>(`/settings/api-keys/${provider}/test`, {
        method: "POST",
        body: JSON.stringify({ model }),
      }),
  })
}

export function useSaveApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, apiKey, baseUrl }: { provider: LlmProvider; apiKey?: string; baseUrl?: string }) =>
      api<{ key: ApiKey }>(`/settings/api-keys/${provider}`, {
        method: "PUT",
        body: JSON.stringify({ apiKey: apiKey || undefined, baseUrl }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY }),
  })
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (provider: LlmProvider) => api<void>(`/settings/api-keys/${provider}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY }),
  })
}
