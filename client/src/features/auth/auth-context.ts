import { createContext } from "react"
import type { LoginInput, RegisterInput, ResetPasswordInput } from "./schemas"

export type User = {
  id: string
  name: string
  email: string
  // Instance role: admins manage users and invites.
  role: "admin" | "member"
  // Null without a profile picture; versions the picture's URL otherwise.
  avatarUpdatedAt: string | null
  createdAt: string
}

export type WorkspaceRole = "owner" | "admin" | "member"

export type Workspace = {
  id: string
  name: string
  // Every user has exactly one, private to them: no members or invites.
  personal: boolean
  role: WorkspaceRole
}

export type Session = { user: User; workspaces: Workspace[] }

export type AuthContextValue = {
  user: User | null
  // Personal first, as the server orders them.
  workspaces: Workspace[]
  // The one the dashboard acts in; null only while signed out.
  workspace: Workspace | null
  isLoading: boolean
  login: (input: LoginInput) => Promise<User>
  register: (input: RegisterInput) => Promise<User>
  // Sets a new password from a reset link and signs in as that account.
  resetPassword: (token: string, input: ResetPasswordInput) => Promise<User>
  logout: () => Promise<void>
  switchWorkspace: (id: string) => void
}

// Null once signed out, so code running after a logout can tell.
export const ME_QUERY_KEY = ["auth", "me"] as const

export const AuthContext = createContext<AuthContextValue | null>(null)
