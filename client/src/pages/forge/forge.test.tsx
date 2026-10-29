import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"
import { PROVIDER_IDS, PROVIDERS } from "@/features/forge/providers"

const gitlabConnection = {
  id: "c1",
  provider: "gitlab",
  host: "gitlab.com",
  kind: "token",
  accountLogin: "dev",
  createdAt: "2026-03-14T12:00:00.000Z",
  createdBy: { name: "Dev", email: "dev@example.com" },
  repositoryCount: 3,
  credentialsRejectedAt: null,
}

async function openAddConnection() {
  await userEvent.click(await screen.findByRole("button", { name: "Add connection" }))
}

async function chooseFilter(label: string, option: string) {
  await userEvent.click(screen.getByRole("button", { name: "Filters" }))
  await userEvent.click(await screen.findByRole("combobox", { name: label }))
  await userEvent.click(screen.getByRole("option", { name: option }))
}

async function clearFilters() {
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
  await userEvent.keyboard("{Escape}")
}

async function openRowAction(account: string, action: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${account}` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: action }))
}

async function chooseProvider(label: string) {
  await userEvent.click(screen.getByRole("combobox", { name: "Provider" }))
  await userEvent.click(screen.getByRole("option", { name: label }))
}

describe("Connections page", () => {
  it("offers one Add connection button when nothing is connected", async () => {
    mockApi({ "GET /api/connections": { connections: [], availableApps: ["github"] } })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    expect(await screen.findByText("No connections yet")).toBeInTheDocument()
    await openAddConnection()

    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent("GitHub")
    expect(screen.getByRole("checkbox", { name: "Self-hosted" })).not.toBeChecked()
    expect(screen.getByRole("link", { name: "Install GitHub App" })).toHaveAttribute(
      "href",
      "/api/connections/github/install",
    )
  })

  it("offers every registered provider and its self-hosted option", async () => {
    mockApi({ "GET /api/connections": { connections: [], availableApps: ["github"] } })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    await openAddConnection()

    await userEvent.click(screen.getByRole("combobox", { name: "Provider" }))
    const options = screen.getAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual(PROVIDER_IDS.map((id) => PROVIDERS[id].label))
    await userEvent.keyboard("{Escape}")

    for (const id of PROVIDER_IDS) {
      await chooseProvider(PROVIDERS[id].label)
      const checkbox = screen.queryByRole("checkbox", { name: "Self-hosted" })
      expect(Boolean(checkbox)).toBe(Boolean(PROVIDERS[id].hosting.selfHosted))
    }
  })

  it("validates the GitLab form before calling the API", async () => {
    const fetchSpy = mockApi({ "GET /api/connections": { connections: [], availableApps: [] } })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    await openAddConnection()
    expect(screen.getByText("The GitHub App is not configured on this server.")).toBeInTheDocument()
    await chooseProvider("GitLab")
    expect(screen.queryByLabelText("Host")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Connect GitLab" }))

    expect(await screen.findByText("Token is required")).toBeInTheDocument()
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith("/connections/gitlab"))).toBe(false)
  })

  it("offers GitLab OAuth on the option matching the server's OAuth host", async () => {
    mockApi({
      "GET /api/connections": { connections: [], availableApps: ["gitlab"], oauthHosts: { gitlab: "gitlab.acme.com" } },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    await openAddConnection()
    await chooseProvider("GitLab")
    expect(screen.queryByRole("link", { name: "Connect with GitLab" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("checkbox", { name: "Self-hosted" }))
    expect(screen.getByRole("link", { name: "Connect with GitLab" })).toHaveAttribute(
      "href",
      "/api/connections/gitlab/oauth/start",
    )
    expect(screen.getByText(/Signs in on gitlab\.acme\.com/)).toBeInTheDocument()
    expect(screen.getByLabelText("Access token")).toBeInTheDocument()
  })

  it("offers GitLab OAuth on GitLab.com and hides it when the server has no OAuth app", async () => {
    mockApi({
      "GET /api/connections": { connections: [], availableApps: ["gitlab"], oauthHosts: { gitlab: "gitlab.com" } },
    })
    const { unmount } = renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    await openAddConnection()
    await chooseProvider("GitLab")
    expect(screen.getByRole("link", { name: "Connect with GitLab" })).toBeInTheDocument()
    unmount()

    mockApi({ "GET /api/connections": { connections: [], availableApps: [] } })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })
    await openAddConnection()
    await chooseProvider("GitLab")
    expect(screen.queryByRole("link", { name: "Connect with GitLab" })).not.toBeInTheDocument()
  })

  it("asks self-hosted GitLab for a host and shows a field error from the server", async () => {
    mockApi({
      "GET /api/connections": { connections: [], availableApps: ["github"] },
      "POST /api/connections/gitlab": () =>
        jsonResponse(400, { message: "Validation failed", errors: { host: ["Enter a host such as gitlab.com"] } }),
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    await openAddConnection()
    await chooseProvider("GitLab")
    await userEvent.click(screen.getByRole("checkbox", { name: "Self-hosted" }))
    await userEvent.click(screen.getByRole("button", { name: "Connect GitLab" }))
    expect(await screen.findByText("Host is required")).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText("Host"), "gitlab.acme.com/group")
    await userEvent.type(screen.getByLabelText("Access token"), "glpat-x")
    await userEvent.click(screen.getByRole("button", { name: "Connect GitLab" }))

    expect(await screen.findByText("Enter a host such as gitlab.com")).toBeInTheDocument()
  })

  it("connects self-hosted GitHub with a host and token", async () => {
    let body: unknown
    mockApi({
      "GET /api/connections": { connections: [], availableApps: ["github"] },
      "POST /api/connections/github": (init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        return jsonResponse(201, {
          connection: { id: "c2", provider: "github", host: "ghe.acme.com", kind: "token", accountLogin: "dev", createdAt: "", createdBy: { name: "Dev", email: "dev@example.com" } },
        })
      },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    await openAddConnection()
    await userEvent.click(screen.getByRole("checkbox", { name: "Self-hosted" }))
    await userEvent.type(screen.getByLabelText("Host"), "ghe.acme.com")
    await userEvent.type(screen.getByLabelText("Access token"), "ghp_x")
    await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }))

    await waitFor(() => expect(body).toEqual({ host: "ghe.acme.com", token: "ghp_x" }))
  })

  it("shows whether each connection is active, who added it and when", async () => {
    mockApi({
      "GET /api/connections": {
        connections: [gitlabConnection, { ...gitlabConnection, id: "c2", accountLogin: "old" }],
        availableApps: [],
      },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/connections/c2/status": { status: "revoked" },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    // By title, since the "Active" column header shares the badge's text.
    const active = await screen.findByTitle("The forge accepts the stored credentials")
    expect(active).toHaveTextContent("Active")
    expect(active).toHaveClass("text-emerald-700")
    const inactive = await screen.findByTitle(/rejected the stored credentials/)
    expect(inactive).toHaveTextContent("Inactive")
    expect(inactive).toHaveClass("text-destructive")
    const created = new Date(gitlabConnection.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })
    expect(screen.getAllByText(created)).toHaveLength(2)
    expect(screen.getAllByText("Dev")[0]).toHaveAttribute("title", "dev@example.com")
    expect(screen.getByRole("columnheader", { name: "Repositories" })).toBeInTheDocument()
    expect(screen.getAllByRole("cell", { name: "3" })).toHaveLength(2)
  })

  it("sorts the table by the clicked column", async () => {
    mockApi({
      "GET /api/connections": {
        connections: [
          { ...gitlabConnection, id: "c1", accountLogin: "bravo", createdAt: "2026-01-01T00:00:00.000Z", repositoryCount: 2 },
          { ...gitlabConnection, id: "c2", accountLogin: "alpha", createdAt: "2026-02-01T00:00:00.000Z", repositoryCount: 0 },
          { ...gitlabConnection, id: "c3", accountLogin: "charlie", createdAt: "2026-03-01T00:00:00.000Z", repositoryCount: 5 },
        ],
        availableApps: [],
      },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/connections/c2/status": { status: "active" },
      "GET /api/connections/c3/status": { status: "active" },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })
    const accounts = () => screen.getAllByRole("row").slice(1).map((row) => row.querySelector("td")?.textContent)

    await screen.findByText("alpha")
    // Unsorted keeps the API order.
    expect(accounts()).toEqual(["bravo", "alpha", "charlie"])

    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    expect(accounts()).toEqual(["alpha", "bravo", "charlie"])
    expect(screen.getByRole("columnheader", { name: "Account" })).toHaveAttribute("aria-sort", "ascending")

    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    expect(accounts()).toEqual(["charlie", "bravo", "alpha"])

    // A third click removes the sort.
    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    expect(accounts()).toEqual(["bravo", "alpha", "charlie"])
    expect(screen.getByRole("columnheader", { name: "Account" })).not.toHaveAttribute("aria-sort")

    await userEvent.click(screen.getByRole("button", { name: "Repositories" }))
    expect(accounts()).toEqual(["alpha", "bravo", "charlie"])
  })

  it("shows a connection's details in a sheet", async () => {
    let statusChecks = 0
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: [] },
      "GET /api/connections/c1/status": () => {
        statusChecks++
        return jsonResponse(200, { status: "active" })
      },
      "GET /api/connections/c1": {
        connection: { ...gitlabConnection, installationId: null, updatedAt: "2026-03-15T12:00:00.000Z" },
        repositories: [
          {
            id: "r1",
            fullPath: "acme/api",
            defaultBranch: "main",
            webUrl: "https://gitlab.com/acme/api",
            webhook: { active: true },
          },
        ],
        reviews: {
          total: 1,
          recent: [
            {
              id: "j1",
              number: 7,
              status: "completed",
              verdict: "pass",
              createdAt: "2026-03-15T12:00:00.000Z",
              repository: { fullPath: "acme/api", provider: "gitlab" },
            },
          ],
        },
      },
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    await openRowAction("dev", "Details")
    const sheet = await screen.findByRole("dialog")

    expect(await within(sheet).findByRole("link", { name: /acme\/api$/ })).toHaveAttribute(
      "href",
      "https://gitlab.com/acme/api",
    )
    expect(within(sheet).getByText("Webhook active")).toBeInTheDocument()
    expect(within(sheet).getByRole("link", { name: /acme\/api !7/ })).toHaveAttribute("href", "/reviews/j1")
    expect(within(sheet).getByText("gitlab.com")).toBeInTheDocument()

    await userEvent.click(within(sheet).getByRole("button", { name: "Copy connection id" }))
    expect(writeText).toHaveBeenCalledWith("c1")

    const checksBefore = statusChecks
    await userEvent.click(within(sheet).getByRole("button", { name: "Check again" }))
    await waitFor(() => expect(statusChecks).toBe(checksBefore + 1))
  })

  it("asks for confirmation before removing a connection", async () => {
    let deleted = false
    mockApi({
      "GET /api/connections": () => jsonResponse(200, { connections: deleted ? [] : [gitlabConnection], availableApps: ["github"] }),
      "GET /api/connections/c1/status": { status: "active" },
      "DELETE /api/connections/c1": () => {
        deleted = true
        return new Response(null, { status: 204 })
      },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    expect(await screen.findByText("GitLab token")).toBeInTheDocument()
    await openRowAction("dev", "Remove")
    let dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "Remove dev?" })).toBeInTheDocument()
    expect(deleted).toBe(false)

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(deleted).toBe(false)
    expect(screen.getByText("GitLab token")).toBeInTheDocument()

    await openRowAction("dev", "Remove")
    dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove connection" }))

    await waitFor(() => expect(deleted).toBe(true))
    expect(await screen.findByText("No connections yet")).toBeInTheDocument()
  })
  it("opens the Repositories tab filtered to the connection to manage", async () => {
    mockApi({
      "GET /api/connections": {
        connections: [gitlabConnection, { ...gitlabConnection, id: "c2", accountLogin: "old" }],
        availableApps: [],
      },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/connections/c2/status": { status: "active" },
      "GET /api/repos": {
        repos: [
          addedRepo("r1", "team/web"),
          addedRepo("r2", "old/api", { connectionId: "c2", account: { login: "old", provider: "gitlab", host: "gitlab.com" } }),
        ],
      },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    await openRowAction("old", "Manage repositories")

    expect(await screen.findByRole("tab", { name: "Repositories", selected: true })).toBeInTheDocument()
    expect(await screen.findByRole("link", { name: "old/api" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "team/web" })).not.toBeInTheDocument()

    const chip = screen.getByRole("button", { name: "Remove Account filter" })
    expect(chip.parentElement).toHaveTextContent("Account: old (gitlab.com)")
    await userEvent.click(chip)
    expect(screen.getByRole("link", { name: "team/web" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove Account filter" })).not.toBeInTheDocument()
  })

  it("shows the managed account as a filter even with one connection", async () => {
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: [] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": { repos: [addedRepo("r1", "team/web")] },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })

    await openRowAction("dev", "Manage repositories")

    const chip = await screen.findByRole("button", { name: "Remove Account filter" })
    expect(chip.parentElement).toHaveTextContent("Account: dev (gitlab.com)")
    expect(screen.getByRole("link", { name: "team/web" })).toBeInTheDocument()
  })

  it("offers every forge kind as a filter even with one connection", async () => {
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: [] },
      "GET /api/connections/c1/status": { status: "active" },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })
    await screen.findByText("GitLab token")

    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    await userEvent.click(await screen.findByRole("combobox", { name: "Forge" }))
    const options = screen.getAllByRole("option").map((option) => option.textContent)
    expect(options).toEqual(["All forges", "GitHub App", "GitHub token", "GitLab token", "GitLab OAuth"])
    expect(screen.getByRole("option", { name: "GitHub App" }).querySelector("svg")).toBeInTheDocument()
  })

  it("searches and filters the connections table", async () => {
    mockApi({
      "GET /api/connections": {
        connections: [
          gitlabConnection,
          { ...gitlabConnection, id: "c2", accountLogin: "old", host: "gitlab.example.com" },
          { ...gitlabConnection, id: "c3", provider: "github", host: "github.com", kind: "github_app", accountLogin: "acme" },
        ],
        availableApps: [],
      },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/connections/c2/status": { status: "revoked" },
      "GET /api/connections/c3/status": { status: "active" },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation" })
    const accounts = () => screen.getAllByRole("row").slice(1).map((row) => row.querySelector("td")?.textContent)
    await screen.findByText("acme")

    const search = screen.getByRole("searchbox", { name: "Search connections" })
    await userEvent.type(search, "gitlab.example")
    expect(accounts()).toEqual(["old"])
    await userEvent.type(search, "-nothing")
    expect(screen.getByText("No connections match your filters.")).toBeInTheDocument()
    await userEvent.clear(search)
    expect(accounts()).toEqual(["dev", "old", "acme"])

    await chooseFilter("Forge", "GitHub App")
    expect(accounts()).toEqual(["acme"])
    await userEvent.keyboard("{Escape}")
    const chip = screen.getByRole("button", { name: "Remove Forge filter" })
    expect(chip.parentElement).toHaveTextContent("Forge: GitHub App")
    await userEvent.click(chip)
    expect(accounts()).toEqual(["dev", "old", "acme"])
    expect(screen.queryByRole("button", { name: "Remove Forge filter" })).not.toBeInTheDocument()

    await screen.findByTitle(/rejected the stored credentials/)
    await chooseFilter("Status", "Inactive")
    expect(accounts()).toEqual(["old"])
  })
})

const addedRepo = (id: string, fullPath: string, extra: Record<string, unknown> = {}) => ({
  id,
  connectionId: "c1",
  account: { login: "dev", provider: "gitlab", host: "gitlab.com" },
  externalId: id,
  fullPath,
  defaultBranch: "main",
  webUrl: `https://gitlab.com/${fullPath}`,
  enabled: true,
  settings: {},
  ...extra,
})

describe("Repositories page", () => {
  it("points to Installation when nothing is connected", async () => {
    mockApi({ "GET /api/connections": { connections: [], availableApps: ["github"] } })
    renderWithProviders(<App />, { route: "/repositories?tab=repositories" })

    expect(await screen.findByText("No forge connected")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Connect a forge" })).toHaveAttribute(
      "href",
      "/repositories?tab=installation",
    )
  })

  it("opens on Installation when nothing is connected", async () => {
    mockApi({ "GET /api/connections": { connections: [], availableApps: ["github"] } })
    renderWithProviders(<App />, { route: "/repositories" })

    expect(await screen.findByRole("tab", { name: "Installation" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("No connections yet")).toBeInTheDocument()
  })

  it("has one sidebar entry and switches between its tabs", async () => {
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: ["github"] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": { repos: [] },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    expect(await screen.findByText("No repositories added")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Repositories" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("link", { name: "Repositories" })).toHaveAttribute("href", "/repositories")
    expect(screen.queryByRole("link", { name: "Connections" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("tab", { name: "Installation" }))
    expect(await screen.findByText("Connected accounts")).toBeInTheDocument()
  })

  it("sends the old /connections path to Installation and keeps the GitHub return toast", async () => {
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: ["github"] },
      "GET /api/connections/c1/status": { status: "active" },
    })
    renderWithProviders(<App />, { route: "/connections?connected=github" })

    expect(await screen.findByText("GitHub connected")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Installation" })).toHaveAttribute("aria-selected", "true")
  })

  it("toasts the forge that sent the browser back", async () => {
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: ["gitlab"] },
      "GET /api/connections/c1/status": { status: "active" },
    })
    renderWithProviders(<App />, { route: "/repositories?tab=installation&connected=gitlab" })

    expect(await screen.findByText("GitLab connected")).toBeInTheDocument()
  })

  it("explains a cancelled GitLab sign-in", async () => {
    mockApi({ "GET /api/connections": { connections: [], availableApps: ["gitlab"] } })
    renderWithProviders(<App />, { route: "/repositories?tab=installation&error=gitlab_oauth_denied" })

    expect(await screen.findByText("GitLab sign-in was cancelled")).toBeInTheDocument()
  })

  it("shows an empty state without asking the forge for every repository", async () => {
    const available = vi.fn(() => jsonResponse(200, { repos: [] }))
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: ["github"] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": { repos: [] },
      "GET /api/repos/available?connectionId=c1": available,
    })
    renderWithProviders(<App />, { route: "/repositories" })

    expect(await screen.findByText("No repositories added")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Add repository" })).toHaveLength(1)
    expect(available).not.toHaveBeenCalled()
  })

  it("adds the repositories picked from the forge", async () => {
    const posted: unknown[] = []
    let added = false
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: ["github"] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": () =>
        jsonResponse(200, {
          repos: added
            ? [
                {
                  id: "r1",
                  connectionId: "c1",
                  account: { login: "dev", provider: "gitlab", host: "gitlab.com" },
                  externalId: "9",
                  fullPath: "team/web",
                  defaultBranch: "main",
                  webUrl: "https://gitlab.com/team/web",
                  enabled: true,
                  settings: {},
                },
              ]
            : [],
        }),
      "GET /api/repos/available?connectionId=c1": {
        repos: [
          {
            id: null,
            externalId: "9",
            fullPath: "team/web",
            defaultBranch: "main",
            private: true,
            webUrl: "https://gitlab.com/team/web",
            enabled: false,
            settings: {},
          },
          {
            id: "r2",
            externalId: "10",
            fullPath: "team/api",
            defaultBranch: "main",
            private: false,
            webUrl: "https://gitlab.com/team/api",
            enabled: false,
            settings: {},
          },
        ],
      },
      "POST /api/repos": (init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)))
        added = true
        return jsonResponse(201, {
          repo: { id: "r1" },
          webhook: { active: false, error: "Automatic reviews are off: GitLab refused the webhook (403 Forbidden)" },
        })
      },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    await userEvent.click(await screen.findByRole("button", { name: "Add repository" }))
    const dialog = await screen.findByRole("dialog")
    expect(await within(dialog).findByRole("checkbox", { name: /team\/api/ })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /team\/web/ }))
    await userEvent.click(within(dialog).getByRole("button", { name: "Add 1 repository" }))

    await waitFor(() => expect(posted).toEqual([{ connectionId: "c1", externalId: "9" }]))
    expect(await screen.findByText(/GitLab refused the webhook/)).toBeInTheDocument()
    expect(await screen.findByRole("switch", { name: "Reviews for team/web" })).toBeChecked()
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("toggles an added repository", async () => {
    const patched: unknown[] = []
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: ["github"] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": {
        repos: [
          {
            id: "r1",
            connectionId: "c1",
            account: { login: "dev", provider: "gitlab", host: "gitlab.com" },
            externalId: "9",
            fullPath: "team/web",
            defaultBranch: "main",
            webUrl: "https://gitlab.com/team/web",
            enabled: true,
            settings: {},
          },
        ],
      },
      "PATCH /api/repos/r1": (init?: RequestInit) => {
        patched.push(JSON.parse(String(init?.body)))
        return jsonResponse(200, { repo: { id: "r1" } })
      },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    const row = (await screen.findByRole("switch", { name: "Reviews for team/web" })).closest("tr")!
    expect(within(row).getByText("dev (gitlab.com)")).toBeInTheDocument()
    // Review config is edited on the Review settings page, not here.
    expect(within(row).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument()
    await userEvent.click(within(row).getByRole("switch"))

    await waitFor(() => expect(patched).toEqual([{ enabled: false }]))
  })

  it("shows a loading skeleton while the account's repositories load", async () => {
    let respond!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => (respond = resolve))
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: [] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": { repos: [] },
      // Typed as a Response, but the fetch mock awaits whatever the handler returns.
      "GET /api/repos/available?connectionId=c1": () => pending as unknown as Response,
    })
    renderWithProviders(<App />, { route: "/repositories" })

    await userEvent.click(await screen.findByRole("button", { name: "Add repository" }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByRole("status", { name: "Loading repositories" })).toBeInTheDocument()

    respond(
      jsonResponse(200, {
        repos: [
          {
            id: null,
            externalId: "9",
            fullPath: "team/web",
            defaultBranch: "main",
            private: false,
            webUrl: "https://gitlab.com/team/web",
            enabled: false,
            settings: {},
          },
        ],
      }),
    )
    expect(await within(sheet).findByRole("checkbox", { name: /team\/web/ })).toBeInTheDocument()
    expect(within(sheet).queryByRole("status", { name: "Loading repositories" })).not.toBeInTheDocument()
  })

  it("adds repositories from the account chosen in the sheet", async () => {
    const posted: unknown[] = []
    const workRepo = {
      id: null,
      externalId: "20",
      fullPath: "acme/api",
      defaultBranch: "main",
      private: false,
      webUrl: "https://gitlab.acme.com/acme/api",
      enabled: false,
      settings: {},
    }
    mockApi({
      "GET /api/connections": {
        connections: [gitlabConnection, { ...gitlabConnection, id: "c2", host: "gitlab.acme.com", accountLogin: "work" }],
        availableApps: [],
      },
      "GET /api/repos": { repos: [] },
      "GET /api/repos/available?connectionId=c1": { repos: [] },
      "GET /api/repos/available?connectionId=c2": { repos: [workRepo] },
      "POST /api/repos": (init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)))
        return jsonResponse(201, { repo: { id: "r9" } })
      },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    await userEvent.click(await screen.findByRole("button", { name: "Add repository" }))
    const sheet = await screen.findByRole("dialog")
    expect(await within(sheet).findByText("This account can see no repositories.")).toBeInTheDocument()
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Account" }))
    await userEvent.click(screen.getByRole("option", { name: "work (gitlab.acme.com)" }))
    await userEvent.click(await within(sheet).findByRole("checkbox", { name: /acme\/api/ }))
    await userEvent.click(within(sheet).getByRole("button", { name: "Add 1 repository" }))

    await waitFor(() => expect(posted).toEqual([{ connectionId: "c2", externalId: "20" }]))
  })

  it("shows each repository's connection status", async () => {
    mockApi({
      "GET /api/connections": {
        connections: [gitlabConnection, { ...gitlabConnection, id: "c2", accountLogin: "old" }],
        availableApps: [],
      },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/connections/c2/status": { status: "revoked" },
      "GET /api/repos": {
        repos: [
          addedRepo("r1", "team/web"),
          addedRepo("r2", "old/api", { connectionId: "c2", account: { login: "old", provider: "gitlab", host: "gitlab.com" } }),
        ],
      },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    const row = (name: string) => screen.getByRole("link", { name }).closest("tr")!
    await waitFor(() => expect(within(row("team/web")).getByText("Active")).toBeInTheDocument())
    expect(within(row("old/api")).getByText("Inactive")).toBeInTheDocument()
  })

  it("says automatic reviews are paused for a connection whose credentials were refused", async () => {
    mockApi({
      "GET /api/connections": {
        connections: [
          gitlabConnection,
          { ...gitlabConnection, id: "c2", accountLogin: "old", credentialsRejectedAt: "2026-10-20T12:00:00.000Z" },
        ],
        availableApps: [],
      },
      "GET /api/connections/c1/status": { status: "active" },
      // Still being checked: the stored flag stands in for the answer.
      "GET /api/connections/c2/status": () => new Promise<Response>(() => undefined),
      "GET /api/repos": {
        repos: [
          addedRepo("r1", "team/web"),
          addedRepo("r2", "old/api", { connectionId: "c2", account: { login: "old", provider: "gitlab", host: "gitlab.com" } }),
        ],
      },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Automatic reviews are paused")
    expect(alert).toHaveTextContent("old (gitlab.com)")
    expect(alert).not.toHaveTextContent("dev (gitlab.com)")
    const row = screen.getByRole("link", { name: "old/api" }).closest("tr")!
    expect(within(row).getByText("Inactive")).toBeInTheDocument()
  })

  it("drops the paused notice once a live check accepts the credentials", async () => {
    mockApi({
      "GET /api/connections": {
        connections: [{ ...gitlabConnection, credentialsRejectedAt: "2026-10-20T12:00:00.000Z" }],
        availableApps: [],
      },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": { repos: [addedRepo("r1", "team/web")] },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    const row = () => screen.getByRole("link", { name: "team/web" }).closest("tr")!
    await waitFor(() => expect(within(row()).getByText("Active")).toBeInTheDocument())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("sorts the table by the clicked column", async () => {
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: [] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": {
        repos: [addedRepo("r1", "team/api", { enabled: false }), addedRepo("r2", "team/web")],
      },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    const paths = () => screen.getAllByRole("link", { name: /^team\// }).map((link) => link.textContent)
    await screen.findByRole("link", { name: "team/web" })
    expect(paths()).toEqual(["team/api", "team/web"])

    await userEvent.click(screen.getByRole("button", { name: "Reviews" }))
    expect(paths()).toEqual(["team/web", "team/api"])
    expect(screen.getByRole("columnheader", { name: "Reviews" })).toHaveAttribute("aria-sort", "ascending")

    await userEvent.click(screen.getByRole("button", { name: "Repository" }))
    await userEvent.click(screen.getByRole("button", { name: "Repository" }))
    expect(paths()).toEqual(["team/web", "team/api"])
    expect(screen.getByRole("columnheader", { name: "Repository" })).toHaveAttribute("aria-sort", "descending")
  })

  it("asks for confirmation before removing a repository", async () => {
    let removed = false
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: [] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": () =>
        jsonResponse(200, { repos: removed ? [addedRepo("r2", "team/api")] : [addedRepo("r2", "team/api"), addedRepo("r1", "team/web")] }),
      "DELETE /api/repos/r1": () => {
        removed = true
        return new Response(null, { status: 204 })
      },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    await openRowAction("team/web", "Remove")
    let dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "Remove team/web?" })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(removed).toBe(false)

    await openRowAction("team/web", "Remove")
    dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove repository" }))

    await waitFor(() => expect(screen.queryByRole("link", { name: "team/web" })).not.toBeInTheDocument())
    expect(removed).toBe(true)
    expect(screen.getByRole("link", { name: "team/api" })).toBeInTheDocument()
  })

  it("links a repository to its configuration from the row menu", async () => {
    mockApi({
      "GET /api/connections": { connections: [gitlabConnection], availableApps: [] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": { repos: [addedRepo("r1", "team/web")] },
    })
    renderWithProviders(<App />, { route: "/repositories" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for team/web" }))
    expect(await screen.findByRole("menuitem", { name: "Review settings" })).toHaveAttribute(
      "href",
      "/configuration?repo=r1",
    )
  })

  it("searches and filters the repositories table", async () => {
    mockApi({
      "GET /api/connections": {
        connections: [
          gitlabConnection,
          { ...gitlabConnection, id: "c2", accountLogin: "old" },
          { ...gitlabConnection, id: "c3", provider: "github", host: "github.com", kind: "github_app", accountLogin: "acme" },
        ],
        availableApps: [],
      },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/connections/c2/status": { status: "revoked" },
      "GET /api/connections/c3/status": { status: "active" },
      "GET /api/repos": {
        repos: [
          addedRepo("r4", "acme/site", { connectionId: "c3", account: { login: "acme", provider: "github", host: "github.com" } }),
          addedRepo("r1", "team/api", { enabled: false }),
          addedRepo("r2", "team/web", { defaultBranch: "develop" }),
          addedRepo("r3", "old/legacy", { connectionId: "c2", account: { login: "old", provider: "gitlab", host: "gitlab.com" } }),
        ],
      },
    })
    renderWithProviders(<App />, { route: "/repositories" })
    const paths = () => screen.getAllByRole("link", { name: /\// }).map((link) => link.textContent)
    await screen.findByRole("link", { name: "old/legacy" })

    const search = screen.getByRole("searchbox", { name: "Search repositories" })
    await userEvent.type(search, "develop")
    expect(paths()).toEqual(["team/web"])
    await userEvent.type(search, "-nothing")
    expect(screen.getByText("No repositories match your filters.")).toBeInTheDocument()
    await userEvent.clear(search)
    expect(paths()).toEqual(["acme/site", "team/api", "team/web", "old/legacy"])

    const forgeCell = (path: string) => screen.getByRole("link", { name: path }).closest("tr")!.querySelectorAll("td")[1]
    expect(forgeCell("acme/site")).toHaveTextContent("GitHub App")
    expect(forgeCell("team/api")).toHaveTextContent("GitLab token")
    await chooseFilter("Forge", "GitHub App")
    expect(paths()).toEqual(["acme/site"])
    await clearFilters()

    await chooseFilter("Reviews", "Enabled")
    expect(paths()).toEqual(["acme/site", "team/web", "old/legacy"])
    await userEvent.click(screen.getByRole("combobox", { name: "Account" }))
    await userEvent.click(screen.getByRole("option", { name: "dev (gitlab.com)" }))
    expect(paths()).toEqual(["team/web"])
    await clearFilters()
    expect(paths()).toEqual(["acme/site", "team/api", "team/web", "old/legacy"])

    await waitFor(() => expect(screen.getAllByText("Inactive")).toHaveLength(1))
    await chooseFilter("Connection status", "Inactive")
    expect(paths()).toEqual(["old/legacy"])
    // Every keystroke and filter click re-renders the table; on CI runners that
    // has crept past the 5s default.
  }, 15_000)

  describe("pagination", () => {
    const manyRepos = Array.from({ length: 12 }, (_, i) => addedRepo(`r${i + 1}`, `team/repo-${String(i + 1).padStart(2, "0")}`))
    const routes = {
      "GET /api/connections": { connections: [gitlabConnection], availableApps: [] },
      "GET /api/connections/c1/status": { status: "active" },
      "GET /api/repos": { repos: manyRepos },
    }
    const repoLinks = () => screen.getAllByRole("link", { name: /^team\/repo-/ }).map((link) => link.textContent)

    it("shows ten repositories per page and moves between pages", async () => {
      mockApi(routes)
      renderWithProviders(<App />, { route: "/repositories?tab=repositories" })

      expect(await screen.findByText("Showing 1-10 of 12")).toBeInTheDocument()
      expect(repoLinks()).toHaveLength(10)
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled()

      await userEvent.click(screen.getByRole("button", { name: "Next page" }))
      expect(screen.getByText("Showing 11-12 of 12")).toBeInTheDocument()
      expect(repoLinks()).toEqual(["team/repo-11", "team/repo-12"])
      expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled()
    })

    it("changes how many rows each page shows", async () => {
      mockApi(routes)
      renderWithProviders(<App />, { route: "/repositories?tab=repositories&page=2" })

      expect(await screen.findByText("Showing 11-12 of 12")).toBeInTheDocument()
      await userEvent.click(screen.getByRole("combobox", { name: "Rows per page" }))
      await userEvent.click(screen.getByRole("option", { name: "25" }))

      expect(screen.getByText("Showing 1-12 of 12")).toBeInTheDocument()
      expect(repoLinks()).toHaveLength(12)
    })

    it("goes back to the first page when searching", async () => {
      mockApi(routes)
      renderWithProviders(<App />, { route: "/repositories?tab=repositories&page=2" })

      expect(await screen.findByText("Showing 11-12 of 12")).toBeInTheDocument()
      await userEvent.type(screen.getByLabelText("Search repositories"), "repo-0")

      expect(screen.getByText("Showing 1-9 of 9")).toBeInTheDocument()
    })
  })
})
