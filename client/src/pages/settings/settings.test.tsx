import { describe, expect, it } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi, testUser } from "@/test/apiRoutes"

function bodyOf(init?: RequestInit) {
  return JSON.parse(String(init?.body))
}

function calls(fetchSpy: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchSpy.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? "GET") === method)
}

describe("Settings page", () => {
  it("is reachable from the user menu", async () => {
    mockApi({ "GET /api/reviews": { reviews: [], total: 0 } })
    renderWithProviders(<App />, { route: "/repositories" })

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(testUser.name) }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Settings" }))

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument()
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "horizontal")
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true")
  })

  it("saves the profile and updates the signed-in user", async () => {
    const fetchSpy = mockApi({
      "PATCH /api/settings/profile": (init?: RequestInit) =>
        jsonResponse(200, { user: { ...testUser, ...bodyOf(init) } }),
    })
    renderWithProviders(<App />, { route: "/settings" })

    const name = await screen.findByLabelText("Name")
    await userEvent.clear(name)
    await userEvent.type(name, "Ada King")
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }))

    expect(await screen.findByText("Profile updated")).toBeInTheDocument()
    expect(bodyOf(calls(fetchSpy, "PATCH", "/api/settings/profile")[0]![1])).toEqual({
      name: "Ada King",
      email: testUser.email,
    })
    expect(screen.getAllByText("Ada King").length).toBeGreaterThan(0)
  })

  it("asks before a tab switch drops unsaved profile edits", async () => {
    mockApi({})
    renderWithProviders(<App />, { route: "/settings" })

    const name = await screen.findByLabelText("Name")
    await userEvent.clear(name)
    await userEvent.type(name, "Ada King")
    await userEvent.click(screen.getByRole("tab", { name: "Password" }))

    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }))
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByLabelText("Name")).toHaveDisplayValue("Ada King")
  })

  it("shows server field errors on the profile form", async () => {
    mockApi({
      "PATCH /api/settings/profile": () =>
        jsonResponse(409, {
          message: "An account with this email already exists",
          errors: { email: ["An account with this email already exists"] },
        }),
    })
    renderWithProviders(<App />, { route: "/settings" })

    const email = await screen.findByLabelText("Email")
    await userEvent.clear(email)
    await userEvent.type(email, "taken@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }))

    expect(await screen.findByText("An account with this email already exists")).toBeInTheDocument()
  })

  it("reports a wrong current password", async () => {
    mockApi({
      "PUT /api/settings/password": () =>
        jsonResponse(400, { message: "Validation failed", errors: { currentPassword: ["Password is incorrect"] } }),
    })
    renderWithProviders(<App />, { route: "/settings?tab=password" })

    await userEvent.type(await screen.findByLabelText("Current password"), "wrong")
    await userEvent.type(screen.getByLabelText("New password"), "new-password")
    await userEvent.type(screen.getByLabelText("Confirm new password"), "new-password")
    await userEvent.click(screen.getByRole("button", { name: "Change password" }))

    expect(await screen.findByText("Password is incorrect")).toBeInTheDocument()
  })

  it("deletes the account from the profile tab after confirming with the password", async () => {
    const fetchSpy = mockApi({ "DELETE /api/settings/account": () => jsonResponse(204) })
    // The old Account tab link falls back to Profile, which now holds the card.
    renderWithProviders(<App />, { route: "/settings?tab=account" })

    const deleteButton = await screen.findByRole("button", { name: "Delete account" })
    expect(screen.getByRole("tab", { name: "Profile", selected: true })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Account" })).not.toBeInTheDocument()
    await userEvent.click(deleteButton)
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Password"), "secret")
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }))

    expect(await screen.findByRole("button", { name: /log in/i })).toBeInTheDocument()
    expect(bodyOf(calls(fetchSpy, "DELETE", "/api/settings/account")[0]![1])).toEqual({ password: "secret" })
  })
})
