import { describe, expect, it } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"
import { listItem } from "@/test/fixtures"

const connection = {
  id: "c1",
  provider: "github",
  host: "github.com",
  kind: "github_app",
  accountLogin: "acme",
  createdAt: new Date().toISOString(),
  user: { name: "Ada Lovelace", email: "ada@example.com" },
  repositoryCount: 1,
}

const repo = (enabled: boolean) => ({
  id: "r1",
  connectionId: "c1",
  account: { login: "acme", provider: "github", host: "github.com" },
  externalId: "1",
  fullPath: "acme/web",
  defaultBranch: "main",
  webUrl: "https://github.com/acme/web",
  enabled,
  settings: {},
  followGlobal: true,
})

const globalConfig = (review: string) => ({
  settings: {},
  warnings: [],
  sources: {},
  config: { profile: "balanced", review: { blockOn: "major" }, triggers: { review } },
})

const apiKey = { provider: "anthropic", stored: true, last4: "abcd", undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false, blocked: false }

// Defaults to a fully set up account with automatic reviews on.
function stubHome({
  connections = [connection],
  repos = [repo(true)],
  trigger = "published",
  reviews = [listItem],
  keys = [apiKey],
  keyStatuses = { anthropic: "active" },
  keysFail = false,
}: {
  connections?: unknown[]
  repos?: unknown[]
  trigger?: string
  reviews?: unknown[]
  keys?: unknown[]
  keyStatuses?: Record<string, string>
  keysFail?: boolean
} = {}) {
  mockApi({
    "GET /api/connections": { connections, availableApps: ["github"] },
    "GET /api/repos": { repos },
    "GET /api/config/global": globalConfig(trigger),
    "GET /api/settings/api-keys": keysFail ? () => jsonResponse(500, { message: "Internal Server Error" }) : { keys },
    ...Object.fromEntries(
      Object.entries(keyStatuses).map(([provider, status]) => [`GET /api/settings/api-keys/${provider}/status`, { status }]),
    ),
    "GET /api/reviews?limit=5": { reviews, total: reviews.length, page: 1, limit: 5 },
  })
  renderWithProviders(<App />, { route: "/home" })
}

describe("Home page", () => {
  it.each([
    { name: "no connection", setup: { connections: [] }, title: "Connect a Git provider", button: "Connect a provider", href: "/repositories?tab=installation" },
    { name: "no enabled repository", setup: { repos: [repo(false)] }, title: "Reviews are off", button: "Add repositories", href: "/repositories" },
    { name: "manual-only triggers", setup: { trigger: "manual" }, title: "Automatic reviews are off", button: "Configure reviews", href: "/configuration" },
    { name: "everything set up", setup: {}, title: "Reviews are on", button: "View repositories", href: "/repositories" },
  ])("shows the hero for $name", async ({ setup, title, button, href }) => {
    stubHome(setup)

    const hero = (await screen.findByText(title)).closest("[data-slot=card]") as HTMLElement
    expect(within(hero).getByRole("link", { name: button })).toHaveAttribute("href", href)
  })

  it("asks for an LLM connection when none is usable", async () => {
    stubHome({ keys: [], keyStatuses: {} })

    const hero = (await screen.findByRole("heading", { name: "Connect an LLM provider" })).closest("[data-slot=card]") as HTMLElement
    expect(within(hero).getByRole("link", { name: "Add an LLM connection" })).toHaveAttribute("href", "/llm-connections")
  })

  it("counts a server-provided LLM key as usable", async () => {
    stubHome({
      keys: [{ ...apiKey, stored: false, last4: null, serverDefault: true }],
      keyStatuses: {},
    })

    expect(await screen.findByText("Reviews are on")).toBeInTheDocument()
  })

  it("treats a revoked LLM connection as missing", async () => {
    stubHome({ keyStatuses: { anthropic: "revoked" } })

    expect(await screen.findByRole("heading", { name: "Connect an LLM provider" })).toBeInTheDocument()
  })

  it("judges a stored key on its own even when the server has a key", async () => {
    // Reviews use the stored key over the server's, so the revoked one decides.
    stubHome({ keys: [{ ...apiKey, serverDefault: true }], keyStatuses: { anthropic: "revoked" } })

    expect(await screen.findByRole("heading", { name: "Connect an LLM provider" })).toBeInTheDocument()
  })

  it("treats a server key the privacy policy blocks as missing", async () => {
    stubHome({
      keys: [{ ...apiKey, stored: false, last4: null, serverDefault: true, blocked: true }],
      keyStatuses: {},
    })

    expect(await screen.findByRole("heading", { name: "Connect an LLM provider" })).toBeInTheDocument()
  })

  it("says the provider can't be reached instead of asking for a connection", async () => {
    stubHome({ keyStatuses: { anthropic: "unreachable" } })

    const hero = (await screen.findByRole("heading", { name: "Can't reach your LLM provider" })).closest("[data-slot=card]") as HTMLElement
    expect(within(hero).getByRole("link", { name: "Check LLM connections" })).toHaveAttribute("href", "/llm-connections")
  })

  it("does not check an undecryptable key and treats it as missing", async () => {
    // No status route is stubbed: a request would 404 and read as unreachable.
    stubHome({ keys: [{ ...apiKey, last4: null, undecryptable: true }], keyStatuses: {} })

    expect(await screen.findByRole("heading", { name: "Connect an LLM provider" })).toBeInTheDocument()
  })

  it("skips the LLM step when the key list fails to load", async () => {
    stubHome({ keysFail: true, keyStatuses: {} })

    expect(await screen.findByText("Reviews are on")).toBeInTheDocument()
  })

  it("summarises repositories and the review configuration", async () => {
    stubHome()

    expect(await screen.findByText("1 repository enabled across 1 connection.")).toBeInTheDocument()
    expect(await screen.findByText("Balanced profile, blocks on major or worse findings.")).toBeInTheDocument()
  })

  it("marks the connected Git and LLM providers", async () => {
    stubHome()

    expect(await screen.findByRole("link", { name: "GitHub, connected" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "GitLab" })).toBeInTheDocument()
    expect(await screen.findByRole("link", { name: "Anthropic, connected" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "OpenAI" })).toBeInTheDocument()
  })

  it("lists recent reviews as links to their pages", async () => {
    stubHome()

    expect(await screen.findByRole("link", { name: "Add b and c" })).toHaveAttribute("href", `/reviews/${listItem.id}`)
    expect(screen.getByText("acme/web · Blocked")).toBeInTheDocument()
  })

  it("opens the manual review sheet from the suggested actions", async () => {
    stubHome()

    await userEvent.click(await screen.findByRole("button", { name: /Review a change/ }))

    expect(await screen.findByRole("dialog", { name: "Manual review" })).toBeInTheDocument()
  })
})
