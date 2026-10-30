import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { ConfigOverride } from "@/features/config/api"
import type { JobStatus, Provider, Verdict } from "@/features/reviews/types"

export interface Connection {
  id: string
  provider: Provider
  host: string
  kind: "github_app" | "token" | "oauth"
  accountLogin: string
  createdAt: string
  // The Sentryward user who added the connection; null once their account is gone.
  createdBy: { name: string; email: string } | null
  // Enabled repositories added from this connection.
  repositoryCount: number
  // Token and OAuth connections: when the forge last refused the stored
  // credentials. Automatic reviews are paused until the account reconnects.
  credentialsRejectedAt: string | null
}

export type ConnectionStatus = "active" | "revoked" | "unreachable"

// Healthy connections first; ones still being checked sink to the bottom.
const STATUS_RANK: Record<ConnectionStatus, number> = { active: 0, unreachable: 1, revoked: 2 }

export const STATUS_LABELS: Record<ConnectionStatus, string> = {
  active: "Active",
  revoked: "Inactive",
  unreachable: "Unknown",
}

// In rank order, for status filters.
export const STATUS_OPTIONS = (Object.keys(STATUS_RANK) as ConnectionStatus[])
  .sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])
  .map((status) => ({ value: status, label: STATUS_LABELS[status] }))

export interface ConnectionDetails {
  connection: Omit<Connection, "user"> & { installationId: string | null; updatedAt: string }
  repositories: {
    id: string
    fullPath: string
    defaultBranch: string
    webUrl: string
    webhook: WebhookState
  }[]
  reviews: {
    total: number
    recent: {
      id: string
      number: number
      status: JobStatus
      verdict: Verdict | null
      createdAt: string
      repository: { fullPath: string; provider: Provider }
    }[]
  }
}

// A repository the user has added to Sentryward.
export interface ForgeRepo {
  id: string
  connectionId: string
  account: { login: string; provider: Provider; host: string }
  externalId: string
  fullPath: string
  defaultBranch: string
  webUrl: string
  enabled: boolean
  settings: ConfigOverride
  // Ignore `settings` and use the global config.
  followGlobal: boolean
  // Place in the Repositories tab's dragged order; null sorts last, by path.
  position: number | null
}

// A repository's newest review that ran (skipped and superseded runs do not count).
export interface LastReview {
  id: string
  number: number
  status: JobStatus
  verdict: Verdict | null
  createdAt: string
}

// The Repositories tab's order. The API lists by path for the pickers that share it.
export function byPosition(a: ForgeRepo, b: ForgeRepo) {
  if (a.position !== b.position) {
    if (a.position === null) return 1
    if (b.position === null) return -1
    return a.position - b.position
  }
  return a.fullPath.localeCompare(b.fullPath)
}

// A repository the forge account can see; id is null until it is added.
export interface AvailableRepo
  extends Omit<ForgeRepo, "id" | "connectionId" | "account" | "followGlobal" | "position"> {
  id: string | null
  private: boolean
}

export interface SavedRepo {
  id: string
  connectionId: string
  fullPath: string
  enabled: boolean
  settings: ConfigOverride
  followGlobal: boolean
}

export interface WebhookState {
  active: boolean
  error?: string
}

export function useConnections() {
  return useQuery({
    queryKey: ["connections"],
    queryFn: () =>
      api<{
        connections: Connection[]
        availableApps: Provider[]
        // The host each configured OAuth app signs in on.
        oauthHosts?: Partial<Record<Provider, string>>
      }>("/connections"),
  })
}

export function useConnectionDetails(id: string | null) {
  return useQuery({
    queryKey: ["connections", id, "details"],
    queryFn: () => api<ConnectionDetails>(`/connections/${id}`),
    enabled: Boolean(id),
  })
}

// Shared by the table and the details sheet, so re-checking in one updates both.
function connectionStatusQuery(id: string) {
  return {
    queryKey: ["connections", id, "status"],
    queryFn: () => api<{ status: ConnectionStatus }>(`/connections/${id}/status`),
    staleTime: 60_000,
    retry: false,
  }
}

// One live credential check per connection, so a slow forge only delays its
// own row. Undefined while a check is still running, unless the server already
// knows the credentials were refused. With live off, only a check some page
// already ran is read: each one calls the forge and spends its rate limit.
export function useConnectionStatuses(
  connections: Connection[],
  { live = true }: { live?: boolean } = {},
): Record<string, ConnectionStatus | undefined> {
  return useQueries({
    queries: connections.map((connection) => ({ ...connectionStatusQuery(connection.id), enabled: live })),
    combine: (results) =>
      Object.fromEntries(
        results.map((result, index) => {
          const connection = connections[index]!
          const known = connection.credentialsRejectedAt ? "revoked" : undefined
          return [connection.id, result.isError ? "unreachable" : (result.data?.status ?? known)]
        }),
      ),
  })
}

// Connections whose repositories get no automatic reviews because the forge
// refused the credentials. A live check that passes wins over the stored flag,
// since the server clears the flag on that same check.
export function pausedConnections(
  connections: Connection[],
  statuses: Record<string, ConnectionStatus | undefined>,
): Connection[] {
  return connections.filter((connection) => {
    if (connection.kind === "github_app" || connection.repositoryCount === 0) return false
    const status = statuses[connection.id]
    return status === "revoked" || (Boolean(connection.credentialsRejectedAt) && status !== "active")
  })
}

export function useConnectionStatus(id: string) {
  const query = useQuery(connectionStatusQuery(id))
  const status: ConnectionStatus | undefined = query.isError ? "unreachable" : query.data?.status
  return { status, isFetching: query.isFetching, refetch: query.refetch }
}

// host and token, plus any extra fields the provider's connect method declares.
export type TokenConnectInput = Record<string, string>

export function useConnectToken(provider: Provider) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TokenConnectInput) =>
      api<{ connection: Omit<Connection, "repositoryCount"> }>(`/connections/${provider}`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  })
}

export function useDeleteConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  })
}

type ConnectionsData = NonNullable<ReturnType<typeof useConnections>["data"]>

const REORDER_CONNECTIONS = ["connections", "reorder"]

// Takes the whole list in its new order. The cache is reordered first so a
// dropped card stays where it was dropped, and put back if the save fails.
// Saves run one at a time, in drop order, so the last order chosen is the one
// stored, and only the last one refetches, so an earlier save's refetch
// cannot undo a newer drop on screen.
export function useReorderConnections() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: REORDER_CONNECTIONS,
    scope: { id: "reorder-connections" },
    mutationFn: (ids: string[]) =>
      api<void>("/connections/order", { method: "PUT", body: JSON.stringify({ ids }) }),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ["connections"], exact: true })
      const previous = queryClient.getQueryData<ConnectionsData>(["connections"])
      if (previous) {
        const byId = new Map(previous.connections.map((connection) => [connection.id, connection]))
        const connections = ids.flatMap((id) => byId.get(id) ?? [])
        queryClient.setQueryData<ConnectionsData>(["connections"], { ...previous, connections })
      }
      return { previous }
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(["connections"], context.previous)
    },
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: REORDER_CONNECTIONS }) === 1) {
        return queryClient.invalidateQueries({ queryKey: ["connections"], exact: true })
      }
    },
  })
}

// Added repositories across every connection.
export function useRepos() {
  return useQuery({
    queryKey: ["repos"],
    queryFn: () => api<{ repos: ForgeRepo[] }>("/repos"),
  })
}

// Each repository's newest review, by id. Only the Repositories tab shows
// them, so they are not part of the list the pickers share. The key sits under
// ["repos"] so the invalidations that refresh the list refresh these too.
export function useLastReviews() {
  return useQuery({
    queryKey: ["repos", "last-reviews"],
    queryFn: () => api<{ lastReviews: Record<string, LastReview | undefined> }>("/repos/last-reviews"),
  })
}

const REORDER_REPOS = ["repos", "reorder"]

// Like useReorderConnections, but the cache keeps its path order for the
// pickers that share it, so the new order goes onto each row's position.
export function useReorderRepos() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: REORDER_REPOS,
    scope: { id: "reorder-repos" },
    mutationFn: (ids: string[]) => api<void>("/repos/order", { method: "PUT", body: JSON.stringify({ ids }) }),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ["repos"], exact: true })
      const previous = queryClient.getQueryData<{ repos: ForgeRepo[] }>(["repos"])
      if (previous) {
        const positions = new Map(ids.map((id, index) => [id, index]))
        const repos = previous.repos.map((repo) => ({ ...repo, position: positions.get(repo.id) ?? repo.position }))
        queryClient.setQueryData(["repos"], { ...previous, repos })
      }
      return { previous }
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(["repos"], context.previous)
    },
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: REORDER_REPOS }) === 1) {
        return queryClient.invalidateQueries({ queryKey: ["repos"], exact: true })
      }
    },
  })
}

// Asks the forge for every repository the account can see, which can be slow,
// so only while the picker is open.
export function useAvailableRepos(connectionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repos", connectionId, "available"],
    queryFn: () => api<{ repos: AvailableRepo[] }>(`/repos/available?connectionId=${connectionId}`),
    enabled,
  })
}

type EnableResult = { repo: SavedRepo; webhook?: WebhookState }

export interface AddReposResult {
  added: { repo: AvailableRepo; webhook?: WebhookState }[]
  failed: { repo: AvailableRepo; error: string }[]
}

// One request per repository, so one failure does not undo the others.
export function useAddRepos(connectionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (repos: AvailableRepo[]): Promise<AddReposResult> => {
      const results = await Promise.allSettled(
        repos.map((repo) =>
          api<EnableResult>("/repos", {
            method: "POST",
            body: JSON.stringify({ connectionId, externalId: repo.externalId }),
          }),
        ),
      )
      const outcome: AddReposResult = { added: [], failed: [] }
      results.forEach((result, index) => {
        const repo = repos[index]!
        if (result.status === "fulfilled") outcome.added.push({ repo, webhook: result.value.webhook })
        else outcome.failed.push({ repo, error: result.reason instanceof Error ? result.reason.message : "Could not add" })
      })
      return outcome
    },
    // The prefix also refreshes the picker's list.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["repos"] })
      queryClient.invalidateQueries({ queryKey: ["connections"], exact: true })
    },
  })
}

// Keyed so the grid can tell which repositories still have a save in flight.
export const SET_REPO_ENABLED = ["repos", "set-enabled"]

export function useSetRepoEnabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: SET_REPO_ENABLED,
    mutationFn: ({ repo, enabled }: { repo: ForgeRepo; enabled: boolean }) =>
      api<EnableResult>(`/repos/${repo.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repos"] })
      // Exact, so the per-connection status checks are not re-run.
      queryClient.invalidateQueries({ queryKey: ["connections"], exact: true })
    },
  })
}

export function useRemoveRepo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (repo: ForgeRepo) => api<void>(`/repos/${repo.id}`, { method: "DELETE" }),
    onSuccess: (_data, repo) => {
      queryClient.invalidateQueries({ queryKey: ["repos"] })
      // The connection details sheet lists its repositories.
      queryClient.invalidateQueries({ queryKey: ["connections", repo.connectionId, "details"] })
      queryClient.invalidateQueries({ queryKey: ["connections"], exact: true })
    },
  })
}
