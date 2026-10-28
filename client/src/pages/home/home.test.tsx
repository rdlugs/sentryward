import { describe, expect, it } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { renderWithProviders } from "@/test/renderWithProviders"
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

const apiKey = { provider: "anthropic", stored: true, last4: "abcd", undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false }

const serverKey = { ...apiKey, stored: false, last4: null, serverDefault: true }

// Defaults to a fully set up account with automatic reviews on.
function stubHome({
  connections = [connection],
  repos = [repo(true)],
  trigger = "published",
  reviews = [listItem],
  keys = [apiKey],
  keyStatus = "active",
}: {
  connections?: unknown[]
  repos?: unknown[]
  trigger?: string
  reviews?: unknown[]
  keys?: unknown[]
  keyStatus?: string
} = {}) {
  mockApi({
    "GET /api/connections": { connections, availableApps: ["github"] },
    "GET /api/repos": { repos },
    "GET /api/config/global": globalConfig(trigger),
    "GET /api/settings/api-keys": { keys },
    "GET /api/settings/api-keys/anthropic/status": { status: keyStatus },
    "GET /api/reviews?limit=5": { reviews, total: reviews.length, page: 1, limit: 5 },
  })
  renderWithProviders(<App />, { route: "/home" })
}

describe("Home page", () => {
  it.each([
    { name: "no connection", setup: { connections: [] }, title: "Connect a Git provider", button: "Connect a provider", href: "/repositories?tab=installation" },
    { name: "no LLM connection", setup: { keys: [] }, title: "Connect an LLM provider", button: "Add an LLM connection", href: "/llm-connections" },
    { name: "a revoked LLM key", setup: { keyStatus: "revoked" }, title: "Connect an LLM provider", button: "Add an LLM connection", href: "/llm-connections" },
    { name: "an LLM key blocked by policy", setup: { keyStatus: "blocked" }, title: "Connect an LLM provider", button: "Add an LLM connection", href: "/llm-connections" },
    { name: "a server LLM key", setup: { keys: [serverKey] }, title: "Reviews are on", button: "View repositories", href: "/repositories" },
    { name: "no enabled repository", setup: { repos: [repo(false)] }, title: "Reviews are off", button: "Add repositories", href: "/repositories" },
    { name: "manual-only triggers", setup: { trigger: "manual" }, title: "Automatic reviews are off", button: "Configure reviews", href: "/configuration" },
    { name: "everything set up", setup: {}, title: "Reviews are on", button: "View repositories", href: "/repositories" },
  ])("shows the hero for $name", async ({ setup, title, button, href }) => {
    stubHome(setup)

    const hero = (await screen.findByRole("heading", { name: title })).closest("[data-slot=card]") as HTMLElement
    expect(within(hero).getByRole("link", { name: button })).toHaveAttribute("href", href)
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
