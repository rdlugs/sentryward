import { useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api, ApiError, setApiWorkspace } from "@/lib/api"
import { AuthContext, ME_QUERY_KEY, type Session, type User, type Workspace } from "./auth-context"
import type { LoginInput, RegisterInput, ResetPasswordInput } from "./schemas"

export const WORKSPACES_QUERY_KEY = ["auth", "workspaces"] as const
const STORED_WORKSPACE = "sentryward.workspace"

// The team you are acting in was deleted or you were removed from it, so its
// id in the workspace header no longer resolves. The query client refreshes
// the workspace list on this, which drops the vanished workspace and lets the
// fallback below move you to your personal one.
export function isStaleWorkspaceError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.message === "Workspace not found"
}

// Storage can be unavailable (private windows, blocked site data); the
// personal workspace is the fallback either way.
function readStoredWorkspace(): string | null {
  try {
    return localStorage.getItem(STORED_WORKSPACE)
  } catch {
    return null
  }
}

function storeWorkspace(id: string | null) {
  try {
    if (id) localStorage.setItem(STORED_WORKSPACE, id)
    else localStorage.removeItem(STORED_WORKSPACE)
  } catch {
    // Only a convenience: the next visit starts in the personal workspace.
  }
}

// Every session response carries the workspace list, so it seeds that query
// and the dashboard does not fetch it again on load.
function seedSession(queryClient: QueryClient, session: Session) {
  if (session.workspaces) queryClient.setQueryData(WORKSPACES_QUERY_KEY, session.workspaces)
  return session.user
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState(readStoredWorkspace)

  const { data: user = null, isLoading } = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: async (): Promise<User | null> => {
      try {
        return seedSession(queryClient, await api<Session>("/auth/me"))
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          return null
        }
        throw error
      }
    },
    staleTime: Infinity,
    retry: false,
  })

  const { data: workspaces = [], isLoading: workspacesLoading } = useQuery({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: () => api<{ workspaces: Workspace[] }>("/workspaces").then((body) => body.workspaces),
    enabled: user !== null,
    staleTime: Infinity,
  })

  // A workspace you were removed from, or one that was deleted, drops out of
  // the list on the next refresh and you land back in your personal one.
  const workspace = user
    ? (workspaces.find((w) => w.id === selectedId) ?? workspaces.find((w) => w.personal) ?? null)
    : null
  // Whenever the workspace changes (a switch, or falling back after leaving
  // one), nothing cached from the previous one may show: the cache is cleared
  // and DashboardLayout remounts its pages. Done during render, not in an
  // effect, because child effects run first and pages would fetch once with
  // the old header.
  const applied = useRef<string | null | undefined>(undefined)
  const workspaceId = workspace?.id ?? null
  if (applied.current !== workspaceId) {
    setApiWorkspace(workspace && !workspace.personal ? workspace.id : null)
    if (applied.current !== undefined) {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" })
    }
    applied.current = workspaceId
  }

  const switchWorkspace = useCallback((id: string) => {
    setSelectedId(id)
    storeWorkspace(id)
  }, [])

  const login = useCallback(
    async (input: LoginInput) => {
      const session = await api<Session>("/auth/login", { method: "POST", body: JSON.stringify(input) })
      const user = seedSession(queryClient, session)
      queryClient.setQueryData(ME_QUERY_KEY, user)
      return user
    },
    [queryClient],
  )

  const register = useCallback(
    async (input: RegisterInput) => {
      const session = await api<Session>("/auth/register", { method: "POST", body: JSON.stringify(input) })
      const user = seedSession(queryClient, session)
      queryClient.setQueryData(ME_QUERY_KEY, user)
      return user
    },
    [queryClient],
  )

  // The link may be opened while signed in as someone else, so the stored
  // workspace choice is dropped: it belongs to whoever was signed in before.
  const resetPassword = useCallback(
    async (token: string, input: ResetPasswordInput) => {
      const session = await api<Session>(`/auth/password-reset/${encodeURIComponent(token)}`, {
        method: "POST",
        body: JSON.stringify(input),
      })
      setSelectedId(null)
      storeWorkspace(null)
      const user = seedSession(queryClient, session)
      queryClient.setQueryData(ME_QUERY_KEY, user)
      return user
    },
    [queryClient],
  )

  const logout = useCallback(async () => {
    await api<void>("/auth/logout", { method: "POST" })
    setSelectedId(null)
    storeWorkspace(null)
    queryClient.removeQueries({ queryKey: WORKSPACES_QUERY_KEY })
    queryClient.setQueryData(ME_QUERY_KEY, null)
  }, [queryClient])

  const value = useMemo(
    () => ({
      user,
      workspaces,
      workspace,
      isLoading: isLoading || (user !== null && workspacesLoading),
      login,
      register,
      resetPassword,
      logout,
      switchWorkspace,
    }),
    [user, workspaces, workspace, isLoading, workspacesLoading, login, register, resetPassword, logout, switchWorkspace],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
