import { describe, expect, it } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
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
  connectionsFail = false,
}: {
  connections?: unknown[]
  repos?: unknown[]
  trigger?: string
  reviews?: unknown[]
  keys?: unknown[]
  keyStatuses?: Record<string, string>
  keysFail?: boolean
  connectionsFail?: boolean
} = {}) {
  const completed = (reviews as { status?: string }[]).filter((r) => r.status === "completed")
  mockApi({
    "GET /api/connections": connectionsFail
      ? () => jsonResponse(500, { message: "Internal Server Error" })
      : { connections, availableApps: ["github"] },
    "GET /api/repos": { repos },
    "GET /api/config/global": globalConfig(trigger),
    "GET /api/settings/api-keys": keysFail ? () => jsonResponse(500, { message: "Internal Server Error" }) : { keys },
    ...Object.fromEntries(
      Object.entries(keyStatuses).map(([provider, status]) => [`GET /api/settings/api-keys/${provider}/status`, { status }]),
    ),
    "GET /api/reviews?limit=5": { reviews, total: reviews.length, page: 1, limit: 5 },
    "GET /api/reviews?status=completed&limit=1": { reviews: completed.slice(0, 1), total: completed.length, page: 1, limit: 1 },
  })
  renderWithProviders(<App />, { route: "/home" })
}

// The checklist step that holds the primary button.
async function nextStep() {
  const list = await screen.findByRole("list", { name: "Setup steps" })
  let step: HTMLElement | null = null
  await waitFor(() => {
    step = list.querySelector<HTMLElement>("[aria-current=step]")
    expect(step).not.toBeNull()
  })
  return step!
}

describe("Home page", () => {
  it.each([
    { name: "no connection", setup: { connections: [] }, title: "Connect GitHub or GitLab", button: "Connect a provider", href: "/repositories?tab=installation" },
    { name: "no enabled repository", setup: { repos: [repo(false)] }, title: "Enable a repository", button: "Add repositories", href: "/repositories" },
    { name: "no LLM connection", setup: { keys: [], keyStatuses: {} }, title: "Connect an LLM provider", button: "Add an LLM connection", href: "/llm-connections" },
  ])("puts the primary button on the next step for $name", async ({ setup, title, button, href }) => {
    stubHome(setup)

    const step = await nextStep()
    expect(within(step).getByRole("heading", { name: title })).toBeInTheDocument()
    expect(within(step).getByRole("link", { name: button })).toHaveAttribute("href", href)
  })

  it("ticks finished steps and asks for a first review last", async () => {
    stubHome({ reviews: [] })

    const step = await nextStep()
    expect(within(step).getByRole("heading", { name: "Run a first review" })).toBeInTheDocument()
    expect(screen.getByText("3 of 4 steps done")).toBeInTheDocument()
    for (const done of ["Connect GitHub or GitLab", "Enable a repository", "Connect an LLM provider"])
      expect(screen.getByRole("heading", { name: `${done} (done)` })).toBeInTheDocument()
  })

  it("ticks steps finished out of order", async () => {
    stubHome({ connections: [], reviews: [] })

    await nextStep()
    expect(screen.getByRole("heading", { name: "Enable a repository (done)" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Connect an LLM provider (done)" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Run a first review" })).toBeInTheDocument()
  })

  it("holds back the review action until the steps before it are done", async () => {
    stubHome({ connections: [], reviews: [] })

    await nextStep()
    expect(screen.getByText("Available once the steps above are done.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Review a change" })).not.toBeInTheDocument()
  })

  it("does not count a review that never finished as the first one", async () => {
    stubHome({ reviews: [{ ...listItem, status: "failed" }, { ...listItem, id: "skipped", status: "skipped" }] })

    expect(within(await nextStep()).getByRole("heading", { name: "Run a first review" })).toBeInTheDocument()
  })

  it("counts a partial review as the first one", async () => {
    stubHome({ reviews: [{ ...listItem, status: "partial" }] })

    expect(await screen.findByRole("button", { name: /Review a change/ })).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "Setup steps" })).not.toBeInTheDocument()
  })

  it("counts the Git provider step as done when connections fail to load", async () => {
    stubHome({ connectionsFail: true, reviews: [] })

    expect(await screen.findByRole("heading", { name: "Connect GitHub or GitLab (done)" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Connect a provider" })).not.toBeInTheDocument()
  })

  it("opens the manual review sheet from the first review step", async () => {
    stubHome({ reviews: [] })

    await userEvent.click(within(await nextStep()).getByRole("button", { name: "Review a change" }))

    expect(await screen.findByRole("dialog", { name: "Manual review" })).toBeInTheDocument()
  })

  it("hides the checklist once setup is complete", async () => {
    stubHome()

    expect(await screen.findByRole("button", { name: /Review a change/ })).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "Setup steps" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Turn on automatic reviews/ })).not.toBeInTheDocument()
  })

  it("counts a server-provided LLM key as usable", async () => {
    stubHome({
      keys: [{ ...apiKey, stored: false, last4: null, serverDefault: true }],
      keyStatuses: {},
      reviews: [],
    })

    expect(await screen.findByRole("heading", { name: "Connect an LLM provider (done)" })).toBeInTheDocument()
  })

  it("treats a revoked LLM connection as missing", async () => {
    stubHome({ keyStatuses: { anthropic: "revoked" } })

    expect(within(await nextStep()).getByRole("heading", { name: "Connect an LLM provider" })).toBeInTheDocument()
  })

  it("judges a stored key on its own even when the server has a key", async () => {
    // Reviews use the stored key over the server's, so the revoked one decides.
    stubHome({ keys: [{ ...apiKey, serverDefault: true }], keyStatuses: { anthropic: "revoked" } })

    expect(within(await nextStep()).getByRole("heading", { name: "Connect an LLM provider" })).toBeInTheDocument()
  })

  it("treats a server key the privacy policy blocks as missing", async () => {
    stubHome({
      keys: [{ ...apiKey, stored: false, last4: null, serverDefault: true, blocked: true }],
      keyStatuses: {},
    })

    expect(within(await nextStep()).getByRole("heading", { name: "Connect an LLM provider" })).toBeInTheDocument()
  })

  it("flags an unreachable provider without reopening setup", async () => {
    stubHome({ keyStatuses: { anthropic: "unreachable" } })

    expect(await screen.findByRole("link", { name: /Can't reach your LLM provider/ })).toHaveAttribute("href", "/llm-connections")
    expect(screen.queryByRole("list", { name: "Setup steps" })).not.toBeInTheDocument()
  })

  it("does not check an undecryptable key and treats it as missing", async () => {
    // No status route is stubbed: a request would 404 and read as unreachable.
    stubHome({ keys: [{ ...apiKey, last4: null, undecryptable: true }], keyStatuses: {} })

    expect(within(await nextStep()).getByRole("heading", { name: "Connect an LLM provider" })).toBeInTheDocument()
  })

  it("counts the LLM step as done when the key list fails to load", async () => {
    stubHome({ keysFail: true, keyStatuses: {}, reviews: [] })

    expect(await screen.findByRole("heading", { name: "Connect an LLM provider (done)" })).toBeInTheDocument()
  })

  it("never suggests a setup step as an action", async () => {
    stubHome({ keys: [], keyStatuses: {}, reviews: [] })

    await nextStep()
    expect(screen.queryByText("Suggested actions")).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Connect an LLM provider/ })).not.toBeInTheDocument()
  })

  it("suggests automatic reviews when only requested reviews run", async () => {
    stubHome({ trigger: "manual" })

    expect(await screen.findByRole("link", { name: /Turn on automatic reviews/ })).toHaveAttribute("href", "/configuration")
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
