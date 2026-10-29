export type FieldErrors = Record<string, string[] | undefined>

export class ApiError extends Error {
  status: number
  fieldErrors?: FieldErrors

  constructor(status: number, message: string, fieldErrors?: FieldErrors) {
    super(message)
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

// The team workspace requests act in, set by AuthProvider. Kept out of query
// keys on purpose: switching clears the cache instead, so every feature's
// hooks stay workspace-agnostic. Null means the personal workspace, which the
// server uses when the header is absent.
let currentWorkspaceId: string | null = null

export function setApiWorkspace(id: string | null) {
  currentWorkspaceId = id
}

export function apiWorkspace(): string | null {
  return currentWorkspaceId
}

// For requests that bypass api(), such as raw-text downloads, or that must act
// in a given workspace whatever is selected now.
export function workspaceHeaders(id: string | null = currentWorkspaceId): Record<string, string> {
  return id ? { "x-sentryward-workspace": id } : {}
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...workspaceHeaders(), ...init.headers },
  })

  if (res.status === 204) {
    return undefined as T
  }

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(res.status, body.message ?? "Something went wrong", body.errors)
  }
  return body as T
}
