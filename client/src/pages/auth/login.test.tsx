import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, mockFetch, renderWithProviders } from "@/test/renderWithProviders"

// Signed out, with the given routes.
function signedOut(routes: Record<string, () => Response>) {
  return mockFetch((url, init) => {
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`
    return routes[key]?.() ?? jsonResponse(401, { message: "Not authenticated" })
  })
}

const open = () => jsonResponse(200, { mode: "open", firstUser: false })

describe("login page", () => {
  it("shows and hides the password", async () => {
    signedOut({ "GET /api/auth/registration": open })
    renderWithProviders(<App />, { route: "/login" })

    const password = await screen.findByLabelText("Password")
    await userEvent.type(password, "hunter22")
    expect(password).toHaveAttribute("type", "password")

    await userEvent.click(screen.getByRole("button", { name: "Show password" }))
    expect(password).toHaveAttribute("type", "text")

    await userEvent.click(screen.getByRole("button", { name: "Hide password" }))
    expect(password).toHaveAttribute("type", "password")
  })

  it("shows bad credentials inline, and clears them on the next attempt", async () => {
    signedOut({
      "GET /api/auth/registration": open,
      "POST /api/auth/login": () => jsonResponse(401, { message: "Invalid email or password" }),
    })
    renderWithProviders(<App />, { route: "/login" })

    await userEvent.type(await screen.findByLabelText("Email"), "ada@example.com")
    await userEvent.type(screen.getByLabelText("Password"), "wrongpassword")
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password")
    expect(screen.getAllByText("Invalid email or password")).toHaveLength(1)
  })

  it("focuses the email field", async () => {
    signedOut({ "GET /api/auth/registration": open })
    renderWithProviders(<App />, { route: "/login" })

    expect(await screen.findByLabelText("Email")).toHaveFocus()
  })
})

describe("register page", () => {
  it("rates the password and checks the confirmation as you type", async () => {
    signedOut({ "GET /api/auth/registration": open })
    renderWithProviders(<App />, { route: "/register" })

    const password = await screen.findByLabelText("Password")
    expect(screen.queryByText(/Strength:/)).not.toBeInTheDocument()

    await userEvent.type(password, "short")
    expect(screen.getByText("Strength: Weak")).toBeInTheDocument()

    await userEvent.type(password, "-Enough1")
    expect(screen.getByText("Strength: Strong")).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText("Confirm password"), "short")
    expect(screen.getByText("Passwords don't match yet")).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("Confirm password"), "-Enough1")
    expect(screen.getByText("Passwords match")).toBeInTheDocument()
  })
})
