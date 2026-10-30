import { lazy, type ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes, useLocation } from "react-router"
import { DashboardLayout } from "./DashboardLayout"
import { useConnections, useConnectionStatuses } from "@/features/forge/api"
import { useApiKeys, useApiKeyStatuses } from "@/features/llm-connections/api"
import { mockApi, testUser } from "@/test/apiRoutes"
import { listItem } from "@/test/fixtures"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"

const Broken = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")))

describe("DashboardLayout", () => {
  it("keeps the sidebar when a page chunk fails, and recovers on navigation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockApi({})
    renderWithProviders(
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/findings" element={<Broken />} />
          <Route path="/reviews" element={<p>Reviews page</p>} />
        </Route>
      </Routes>,
      { route: "/findings" },
    )

    expect(await screen.findByRole("alert")).toHaveTextContent("This page failed to load")
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("link", { name: "Reviews" }))
    expect(await screen.findByText("Reviews page")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("groups the navigation and names the group in the breadcrumb", async () => {
    mockApi({})
    renderWithProviders(
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/usage" element={<p>Usage page</p>} />
        </Route>
      </Routes>,
      { route: "/usage" },
    )

    await screen.findByText("Usage page")
    const labels = [...document.querySelectorAll("[data-sidebar=group-label]")].map((label) => label.textContent)
    // Administration is for instance admins only.
    expect(labels).toEqual(["Activity", "Insights", "Workspace"])
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" })
    expect(within(breadcrumb).getByText("Insights")).toBeInTheDocument()
    expect(within(breadcrumb).getByText("Usage")).toHaveAttribute("aria-current", "page")
  })

  describe("attention indicators", () => {
    const apiKey = {
      provider: "anthropic",
      stored: true,
      last4: "abcd",
      undecryptable: false,
      baseUrl: null,
      updatedAt: null,
      serverDefault: false,
      blocked: false,
    }
    const connection = {
      id: "c1",
      provider: "github",
      host: "github.com",
      kind: "token",
      accountLogin: "dev",
      createdAt: "",
      createdBy: null,
      repositoryCount: 1,
      credentialsRejectedAt: null,
    }

    function renderOn(route: string, element: ReactElement = <p>Page</p>) {
      return renderWithProviders(
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path={route} element={element} />
          </Route>
        </Routes>,
        { route },
      )
    }

    // Stands in for the pages that run the live checks the sidebar only reads.
    function CheckingPage() {
      useApiKeyStatuses(useApiKeys().data?.keys ?? [])
      useConnectionStatuses(useConnections().data?.connections ?? [])
      return <p>Page</p>
    }

    it("flags failed reviews and unhealthy connections a page has checked, with accessible labels", async () => {
      mockApi({
        "GET /api/reviews/attention": { failed: 3, since: "" },
        "GET /api/settings/api-keys": { keys: [apiKey] },
        "GET /api/settings/api-keys/anthropic/status": { status: "revoked" },
        "GET /api/connections": { connections: [connection], availableApps: [] },
        "GET /api/connections/c1/status": () => jsonResponse(502, { message: "down" }),
      })
      renderOn("/usage", <CheckingPage />)

      expect(
        await screen.findByRole("link", { name: /^Reviews\W+3 failed reviews since your last visit$/ }),
      ).toBeInTheDocument()
      expect(
        await screen.findByRole("link", { name: /^LLM Connections\W+A connection needs attention$/ }),
      ).toBeInTheDocument()
      // A forge that cannot be reached counts too.
      expect(
        await screen.findByRole("link", { name: /^Repositories\W+A forge connection needs attention$/ }),
      ).toBeInTheDocument()
    })

    it("starts no credential checks itself, but still flags what the server already knows", async () => {
      const keyStatus = vi.fn(() => jsonResponse(200, { status: "revoked" }))
      const connectionStatus = vi.fn(() => jsonResponse(200, { status: "revoked" }))
      mockApi({
        "GET /api/reviews/attention": { failed: 0, since: "" },
        "GET /api/settings/api-keys": { keys: [{ ...apiKey, blocked: true }] },
        "GET /api/settings/api-keys/anthropic/status": keyStatus,
        "GET /api/connections": {
          connections: [{ ...connection, credentialsRejectedAt: "2026-01-01T00:00:00Z" }],
          availableApps: [],
        },
        "GET /api/connections/c1/status": connectionStatus,
      })
      renderOn("/usage")

      expect(
        await screen.findByRole("link", { name: /^LLM Connections\W+A connection needs attention$/ }),
      ).toBeInTheDocument()
      expect(
        await screen.findByRole("link", { name: /^Repositories\W+A forge connection needs attention$/ }),
      ).toBeInTheDocument()
      expect(keyStatus).not.toHaveBeenCalled()
      expect(connectionStatus).not.toHaveBeenCalled()
    })

    it("shows nothing while connections are healthy or still being checked", async () => {
      mockApi({
        "GET /api/reviews/attention": { failed: 0, since: "" },
        "GET /api/settings/api-keys": { keys: [apiKey] },
        "GET /api/settings/api-keys/anthropic/status": { status: "active" },
        "GET /api/connections": { connections: [connection], availableApps: [] },
        "GET /api/connections/c1/status": () => new Promise<Response>(() => {}) as unknown as Response,
      })
      renderOn("/usage", <CheckingPage />)

      await screen.findByText("Page")
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.getByRole("link", { name: "Reviews" })).toBeInTheDocument()
      expect(screen.getByRole("link", { name: "LLM Connections" })).toBeInTheDocument()
      expect(screen.getByRole("link", { name: "Repositories" })).toBeInTheDocument()
    })

    it("hides the failed count while the Reviews list is open", async () => {
      mockApi({ "GET /api/reviews/attention": { failed: 2, since: "" } })
      renderOn("/reviews")

      await screen.findByText("Page")
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.getByRole("link", { name: "Reviews" })).toBeInTheDocument()
    })

    it("hides the failed count on the list's trailing-slash URL too", async () => {
      mockApi({ "GET /api/reviews/attention": { failed: 2, since: "" } })
      renderWithProviders(
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="/reviews" element={<p>Page</p>} />
          </Route>
        </Routes>,
        { route: "/reviews/" },
      )

      await screen.findByText("Page")
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.queryByRole("link", { name: /failed review/ })).not.toBeInTheDocument()
    })
  })

  describe("command palette", () => {
    const repo = {
      id: "r1",
      connectionId: "c1",
      account: { login: "acme", provider: "github", host: "github.com" },
      externalId: "1",
      fullPath: "acme/web",
      defaultBranch: "main",
      webUrl: "https://github.com/acme/web",
      enabled: true,
      settings: {},
      followGlobal: true,
    }

    function Where() {
      const { pathname, search } = useLocation()
      return <p>At {pathname + search}</p>
    }

    function renderLayout(routes: Record<string, unknown> = {}) {
      mockApi({ "GET /api/repos": { repos: [repo] }, ...routes })
      renderWithProviders(
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="*" element={<Where />} />
          </Route>
        </Routes>,
        { route: "/usage" },
      )
    }

    async function openPalette(shortcut = "{Control>}k{/Control}") {
      await screen.findByText("At /usage")
      await userEvent.keyboard(shortcut)
      return screen.findByRole("dialog", { name: "Command palette" })
    }

    it("opens with Ctrl+K or Cmd+K and goes to a page", async () => {
      renderLayout()

      const palette = await openPalette("{Meta>}k{/Meta}")
      await userEvent.keyboard("{Escape}")
      expect(palette).not.toBeInTheDocument()

      await openPalette()
      await userEvent.type(screen.getByRole("combobox", { name: "Search pages and repositories" }), "findings")
      await userEvent.keyboard("{Enter}")

      expect(await screen.findByText("At /findings")).toBeInTheDocument()
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument()
    })

    it("hides admin pages from members", async () => {
      renderLayout()
      const palette = await openPalette()
      expect(within(palette).getByRole("option", { name: "Usage" })).toBeInTheDocument()
      expect(within(palette).queryByRole("option", { name: "Instance settings" })).not.toBeInTheDocument()
    })

    it("lists admin pages for an admin", async () => {
      renderLayout({ "GET /api/auth/me": { user: { ...testUser, role: "admin" }, workspaces: [] } })
      const palette = await openPalette()
      expect(within(palette).getByRole("option", { name: "Users" })).toBeInTheDocument()
      expect(within(palette).getByRole("option", { name: "Instance settings" })).toBeInTheDocument()
    })

    it("opens a repository's reviews", async () => {
      renderLayout()
      const palette = await openPalette()
      await userEvent.click(await within(palette).findByRole("option", { name: /acme\/web/ }))

      expect(await screen.findByText("At /reviews?repo=r1")).toBeInTheDocument()
    })

    it("queues a review for a pasted link", async () => {
      const create = vi.fn((_init?: RequestInit) => jsonResponse(201, { review: listItem }))
      renderLayout({ "POST /api/reviews": create })
      await openPalette()
      await userEvent.type(
        screen.getByRole("combobox", { name: "Search pages and repositories" }),
        "https://github.com/acme/web/pull/42",
      )
      await userEvent.keyboard("{Enter}")

      expect(await screen.findByText(`At /reviews/${listItem.id}`)).toBeInTheDocument()
      expect(JSON.parse(String(create.mock.calls[0]![0]?.body))).toEqual({ url: "https://github.com/acme/web/pull/42" })
    })

    it("starts a manual review from the palette or the top bar", async () => {
      renderLayout()
      const palette = await openPalette()
      await userEvent.click(within(palette).getByRole("option", { name: "Start manual review" }))
      expect(await screen.findByRole("dialog", { name: "Manual review" })).toBeInTheDocument()
      await userEvent.keyboard("{Escape}")
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Manual review" })).not.toBeInTheDocument())

      await userEvent.click(screen.getByRole("button", { name: "Review a PR" }))
      expect(await screen.findByRole("dialog", { name: "Manual review" })).toBeInTheDocument()
    })
  })
})
