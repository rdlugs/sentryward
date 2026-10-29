import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "./App"
import { jsonResponse, mockFetch, renderWithProviders } from "./test/renderWithProviders"
import { mockApi } from "./test/apiRoutes"

const user = { id: "1", name: "Ada Lovelace", email: "ada@example.com", role: "member", avatarUpdatedAt: null, createdAt: "" }

describe("routing and auth", () => {
  it("redirects an anonymous visitor from /home to the login page", async () => {
    mockFetch(() => jsonResponse(401, { message: "Not authenticated" }))
    renderWithProviders(<App />, { route: "/home" })

    expect(await screen.findByText("Welcome back")).toBeInTheDocument()
  })

  it("sends a new user from the old /dashboard link to Home, which asks for a Git provider", async () => {
    mockApi({ "GET /api/connections": { connections: [], availableApps: ["github"] } })
    renderWithProviders(<App />, { route: "/dashboard" })

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument()
    expect(await screen.findByRole("heading", { name: "Connect GitHub or GitLab" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Connect a provider" })).toHaveAttribute("href", "/repositories?tab=installation")
  })

  it("redirects a logged-in user away from /login", async () => {
    mockApi({})
    renderWithProviders(<App />, { route: "/login" })

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument()
  })
})

describe("register form", () => {
  it("shows validation errors without calling the API", async () => {
    const fetchSpy = mockFetch(() => jsonResponse(401, { message: "Not authenticated" }))
    renderWithProviders(<App />, { route: "/register" })

    await userEvent.type(await screen.findByLabelText("Email"), "not-an-email")
    await userEvent.type(screen.getByLabelText("Password"), "short")
    await userEvent.type(screen.getByLabelText("Confirm password"), "different")
    await userEvent.click(screen.getByRole("button", { name: "Create account" }))

    expect(await screen.findByText("Name is required")).toBeInTheDocument()
    expect(screen.getByText("Enter a valid email address")).toBeInTheDocument()
    expect(screen.getByText("Password must be at least 8 characters")).toBeInTheDocument()
    expect(screen.getByText("Passwords do not match")).toBeInTheDocument()
    // Only the initial /auth/me and registration-mode checks.
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(["/api/auth/me", "/api/auth/registration"])
  })

  it("registers and lands on Home", async () => {
    mockFetch((url) =>
      url.endsWith("/auth/register")
        ? jsonResponse(201, { user })
        : jsonResponse(401, { message: "Not authenticated" }),
    )
    renderWithProviders(<App />, { route: "/register" })

    await userEvent.type(await screen.findByLabelText("Name"), user.name)
    await userEvent.type(screen.getByLabelText("Email"), user.email)
    await userEvent.type(screen.getByLabelText("Password"), "supersecret123")
    await userEvent.type(screen.getByLabelText("Confirm password"), "supersecret123")
    await userEvent.click(screen.getByRole("button", { name: "Create account" }))

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument()
  })
})

describe("login form", () => {
  it("shows the server error message on bad credentials", async () => {
    mockFetch((url) =>
      url.endsWith("/auth/login")
        ? jsonResponse(401, { message: "Invalid email or password" })
        : jsonResponse(401, { message: "Not authenticated" }),
    )
    renderWithProviders(<App />, { route: "/login" })

    await userEvent.type(await screen.findByLabelText("Email"), "ada@example.com")
    await userEvent.type(screen.getByLabelText("Password"), "wrongpassword")
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))

    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument()
    expect(screen.getByText("Welcome back")).toBeInTheDocument()
  })
})
