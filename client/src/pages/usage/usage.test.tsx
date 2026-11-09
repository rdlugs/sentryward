import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"
import { bucketLabel } from "@/features/usage/format"
import type { RecentReviewUsage, UsageReport } from "@/features/usage/types"

const SONNET = "anthropic/claude-sonnet-5-5"
const PROXY = "openai/my-proxy"

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    period: "7d",
    unit: "day",
    totals: {
      reviews: 4,
      calls: 9,
      unpricedCalls: 0,
      inputTokens: 1_250_000,
      cachedInputTokens: 400_000,
      outputTokens: 120_000,
      cost: { usd: 3.28 },
    },
    series: [
      { start: "2026-10-22T00:00:00.000Z", calls: 4, tokens: 600_000, usd: 1.2 },
      { start: "2026-10-23T00:00:00.000Z", calls: 5, tokens: 770_000, usd: 2.08 },
    ],
    byModel: [
      {
        model: SONNET,
        provider: "anthropic",
        calls: 9,
        unpricedCalls: 0,
        inputTokens: 1_250_000,
        cachedInputTokens: 400_000,
        outputTokens: 120_000,
        lastUsed: "2026-10-23T10:00:00.000Z",
        cost: { input: 1.7, cached: 0.08, output: 1.2, total: 2.98 },
      },
    ],
    byProvider: [{ provider: "anthropic", calls: 9, tokens: 1_370_000, usd: 3.28 }],
    byRepository: [
      {
        repositoryId: "r1",
        fullPath: "acme/web",
        reviews: 4,
        calls: 9,
        unpricedCalls: 0,
        inputTokens: 1_250_000,
        cachedInputTokens: 400_000,
        outputTokens: 120_000,
        lastUsed: "2026-10-23T10:00:00.000Z",
        usd: 3.28,
      },
    ],
    ...overrides,
  }
}

const REVIEW: RecentReviewUsage = {
  id: "rev-1",
  number: 42,
  title: "Add b and c",
  fullPath: "acme/web",
  provider: "github",
  createdAt: "2026-10-23T10:00:00.000Z",
  models: [SONNET],
  calls: 3,
  unpricedCalls: 0,
  inputTokens: 300_000,
  outputTokens: 20_000,
  usd: 0.62,
}

// GET /usage/recent for each page of these reviews at the default page size,
// as the server pages them.
function recentRoutes(reviews: RecentReviewUsage[] = [REVIEW], period = "7d", size = 10) {
  const pages = Math.max(1, Math.ceil(reviews.length / size))
  return Object.fromEntries(
    Array.from({ length: pages }, (_, i) => [
      `GET /api/usage/recent?period=${period}&page=${i + 1}&limit=${size}`,
      { reviews: reviews.slice(i * size, (i + 1) * size), total: reviews.length, page: i + 1 },
    ]),
  )
}

const manyReviews = Array.from({ length: 12 }, (_, i) => ({ ...REVIEW, id: `rev-${i + 1}`, title: `Review ${i + 1}` }))

// Enough rows for two pages; listed out of order so a sort has work to do.
function manyRows() {
  const base = report()
  const order = [5, 12, 1, 9, 3, 11, 7, 2, 10, 4, 8, 6]
  return report({
    byModel: order.map((n) => ({ ...base.byModel[0]!, model: `openai/model-${String(n).padStart(2, "0")}`, calls: n })),
    byRepository: order.map((n) => ({ ...base.byRepository[0]!, repositoryId: `r${n}`, fullPath: `acme/repo-${n}` })),
  })
}

const recentCard = () => screen.getByRole("list", { name: "Recent reviews" }).parentElement!
const usageSection = () => screen.getByRole("region", { name: "Usage table" })

describe("Usage page", () => {
  it("is reachable from the sidebar and shows the totals", async () => {
    mockApi({ "GET /api/reviews": { reviews: [], total: 0 }, "GET /api/usage?period=7d": report(), ...recentRoutes() })
    renderWithProviders(<App />, { route: "/home" })

    await userEvent.click(await screen.findByRole("link", { name: "Usage" }))

    const totals = await screen.findByRole("region", { name: "Usage totals" })
    expect(within(totals).getByText("1,250,000")).toBeInTheDocument()
    expect(within(totals).getByText("400,000")).toBeInTheDocument()
    expect(within(totals).getByText("~$3.28 est.")).toBeInTheDocument()
    expect(within(totals).getByText("Estimated, not actual billing")).toBeInTheDocument()
  })

  it("refetches for another period and keeps it in the URL", async () => {
    const fetchSpy = mockApi({
      "GET /api/usage?period=7d": report(),
      "GET /api/usage?period=30d": report({ period: "30d", totals: { ...report().totals, reviews: 17 } }),
      ...recentRoutes(),
      ...recentRoutes([REVIEW], "30d"),
    })
    renderWithProviders(<App />, { route: "/usage" })
    await screen.findByRole("region", { name: "Usage totals" })

    await userEvent.click(screen.getByRole("tab", { name: "30D" }))

    expect(await within(screen.getByRole("region", { name: "Usage totals" })).findByText("17")).toBeInTheDocument()
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === "/api/usage?period=30d")).toBe(true)
  })

  it("switches the table between costs and tokens, and models and repositories", async () => {
    mockApi({ "GET /api/usage?period=7d": report(), ...recentRoutes() })
    renderWithProviders(<App />, { route: "/usage" })

    const byModel = await screen.findByRole("table", { name: "Usage by model" })
    expect(within(byModel).getByText(SONNET)).toBeInTheDocument()
    expect(within(byModel).getByRole("columnheader", { name: /Cached cost/ })).toBeInTheDocument()
    expect(within(byModel).getByText("$2.98")).toBeInTheDocument()

    await userEvent.click(within(screen.getByRole("tablist", { name: "Table values" })).getByRole("tab", { name: "Tokens" }))
    const tokens = screen.getByRole("table", { name: "Usage by model" })
    // Uncached input is shown apart from the cache reads.
    expect(within(tokens).getByText("850,000")).toBeInTheDocument()
    expect(within(tokens).getByText("1,370,000")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("combobox", { name: "Group usage by" }))
    await userEvent.click(await screen.findByRole("option", { name: "Usage by Repository" }))
    const byRepo = await screen.findByRole("table", { name: "Usage by repository" })
    expect(within(byRepo).getByText("acme/web")).toBeInTheDocument()
  })

  it("pages recent reviews past the first ten, a page at a time from the server", async () => {
    const fetchSpy = mockApi({ "GET /api/usage?period=7d": manyRows(), ...recentRoutes(manyReviews) })
    renderWithProviders(<App />, { route: "/usage" })

    await screen.findByRole("list", { name: "Recent reviews" })
    expect(within(recentCard()).getByText("Showing 1-10 of 12")).toBeInTheDocument()
    await userEvent.click(within(recentCard()).getByRole("button", { name: "Next page" }))

    expect(await within(recentCard()).findByText("Showing 11-12 of 12")).toBeInTheDocument()
    const titles = within(screen.getByRole("list", { name: "Recent reviews" })).getAllByRole("link").map((link) => link.textContent)
    expect(titles).toEqual(["Review 11", "Review 12"])
    const urls = fetchSpy.mock.calls.map(([url]) => String(url))
    expect(urls).toContain("/api/usage/recent?period=7d&page=2&limit=10")
    // Paging the recent list never refetches the report.
    expect(urls.filter((url) => url === "/api/usage?period=7d")).toHaveLength(1)
    // The usage table keeps its own page.
    expect(within(usageSection()).getByText("Showing 1-10 of 12")).toBeInTheDocument()
  })

  it("sorts the usage table across every row, then pages it", async () => {
    mockApi({ "GET /api/usage?period=7d": manyRows(), ...recentRoutes(manyReviews) })
    renderWithProviders(<App />, { route: "/usage" })

    const table = await screen.findByRole("table", { name: "Usage by model" })
    await userEvent.click(within(table).getByRole("button", { name: "Calls" }))
    await userEvent.click(within(usageSection()).getByRole("button", { name: "Next page" }))

    expect(await within(usageSection()).findByText("Showing 11-12 of 12")).toBeInTheDocument()
    const models = within(screen.getByRole("table", { name: "Usage by model" }))
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]!.textContent)
    expect(models).toEqual(["openai/model-11", "openai/model-12"])
  })

  it("returns both lists to the first page for another mode, view or period", async () => {
    mockApi({
      "GET /api/usage?period=7d": manyRows(),
      "GET /api/usage?period=30d": manyRows(),
      ...recentRoutes(manyReviews),
      ...recentRoutes(manyReviews, "30d"),
    })
    renderWithProviders(<App />, { route: "/usage" })
    await screen.findByRole("table", { name: "Usage by model" })

    const nextUsagePage = () => userEvent.click(within(usageSection()).getByRole("button", { name: "Next page" }))
    await nextUsagePage()
    await userEvent.click(within(screen.getByRole("tablist", { name: "Table values" })).getByRole("tab", { name: "Tokens" }))
    expect(await within(usageSection()).findByText("Showing 1-10 of 12")).toBeInTheDocument()

    await nextUsagePage()
    await userEvent.click(screen.getByRole("combobox", { name: "Group usage by" }))
    await userEvent.click(await screen.findByRole("option", { name: "Usage by Repository" }))
    await screen.findByRole("table", { name: "Usage by repository" })
    expect(within(usageSection()).getByText("Showing 1-10 of 12")).toBeInTheDocument()

    await nextUsagePage()
    await userEvent.click(within(recentCard()).getByRole("button", { name: "Next page" }))
    expect(await within(recentCard()).findByText("Showing 11-12 of 12")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "30D" }))

    await waitFor(() => expect(within(recentCard()).getByText("Showing 1-10 of 12")).toBeInTheDocument())
    expect(within(usageSection()).getByText("Showing 1-10 of 12")).toBeInTheDocument()
  })

  it("starts over at page 1 when the usage table is sorted", async () => {
    mockApi({ "GET /api/usage?period=7d": manyRows(), ...recentRoutes(manyReviews) })
    renderWithProviders(<App />, { route: "/usage" })

    const table = await screen.findByRole("table", { name: "Usage by model" })
    await userEvent.click(within(usageSection()).getByRole("button", { name: "Next page" }))
    expect(await within(usageSection()).findByText("Showing 11-12 of 12")).toBeInTheDocument()
    await userEvent.click(within(table).getByRole("button", { name: "Calls" }))

    expect(await within(usageSection()).findByText("Showing 1-10 of 12")).toBeInTheDocument()
    const first = within(screen.getByRole("table", { name: "Usage by model" })).getAllByRole("row")[1]!
    expect(within(first).getAllByRole("cell")[0]!.textContent).toBe("openai/model-01")
  })

  it("gives each list its own rows-per-page control", async () => {
    mockApi({ "GET /api/usage?period=7d": manyRows(), ...recentRoutes(manyReviews) })
    renderWithProviders(<App />, { route: "/usage" })
    await screen.findByRole("list", { name: "Recent reviews" })

    const selects = screen.getAllByRole("combobox", { name: "Rows per page" })
    expect(selects).toHaveLength(2)
    expect(selects[0]!.id).not.toBe(selects[1]!.id)
    expect(within(recentCard()).getByRole("combobox", { name: "Rows per page" })).toBe(selects[0])
  })

  it("shows a model without a price at $0", async () => {
    mockApi({
      ...recentRoutes(),
      "GET /api/usage?period=7d": report({
        byModel: [
          { ...report().byModel[0]!, model: PROXY, provider: "openai", cost: { input: 0, cached: 0, output: 0, total: 0 } },
        ],
      }),
    })
    renderWithProviders(<App />, { route: "/usage" })

    const row = (await screen.findByRole("table", { name: "Usage by model" })).querySelector("tbody tr")!
    expect(within(row as HTMLElement).getByText(PROXY)).toBeInTheDocument()
    expect(within(row as HTMLElement).getAllByText("$0.00")).toHaveLength(4)
  })

  it("shows the cost of a model no call had a price for as unknown", async () => {
    mockApi({
      ...recentRoutes(),
      "GET /api/usage?period=7d": report({
        byModel: [
          {
            ...report().byModel[0]!,
            model: PROXY,
            provider: "openai",
            unpricedCalls: 9,
            cost: { input: 0, cached: 0, output: 0, total: 0 },
          },
        ],
      }),
    })
    renderWithProviders(<App />, { route: "/usage" })

    const row = (await screen.findByRole("table", { name: "Usage by model" })).querySelector("tbody tr")!
    expect(within(row as HTMLElement).getAllByText("Unknown")).toHaveLength(4)
    expect(within(row as HTMLElement).queryByText("$0.00")).not.toBeInTheDocument()
  })

  it("shows the total and a review's cost as unknown when no call had a price", async () => {
    mockApi({
      ...recentRoutes([{ ...REVIEW, unpricedCalls: 3, usd: 0 }]),
      "GET /api/usage?period=7d": report({ totals: { ...report().totals, unpricedCalls: 9, cost: { usd: 0 } } }),
    })
    renderWithProviders(<App />, { route: "/usage" })

    const totals = await screen.findByRole("region", { name: "Usage totals" })
    expect(within(totals).getByText("Unknown")).toBeInTheDocument()
    const recent = await screen.findByRole("list", { name: "Recent reviews" })
    expect(within(recent).getByText("Unknown")).toBeInTheDocument()
    expect(within(recent).queryByText("~$0.00 est.")).not.toBeInTheDocument()
  })

  it("links recent reviews to their pages", async () => {
    mockApi({ "GET /api/usage?period=7d": report(), ...recentRoutes() })
    renderWithProviders(<App />, { route: "/usage" })

    const recent = await screen.findByRole("list", { name: "Recent reviews" })
    expect(within(recent).getByRole("link", { name: "Add b and c" })).toHaveAttribute("href", "/reviews/rev-1")
    expect(within(recent).getByText("~$0.62 est.")).toBeInTheDocument()
  })

  it.each([
    { provider: "github", label: "Pull request #42", line: "acme/web #42" },
    { provider: "gitlab", label: "Merge request !42", line: "acme/web !42" },
  ] as const)("names an untitled $provider review the forge's way", async ({ provider, label, line }) => {
    mockApi({ "GET /api/usage?period=7d": report(), ...recentRoutes([{ ...REVIEW, title: null, provider }]) })
    renderWithProviders(<App />, { route: "/usage" })

    const recent = await screen.findByRole("list", { name: "Recent reviews" })
    expect(within(recent).getByRole("link", { name: label })).toHaveAttribute("href", "/reviews/rev-1")
    expect(within(recent).getByRole("listitem")).toHaveTextContent(line)
  })

  it("shows empty states without usage", async () => {
    const empty = report({
      totals: { reviews: 0, calls: 0, unpricedCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: { usd: 0 } },
      series: [{ start: "2026-10-23T00:00:00.000Z", calls: 0, tokens: 0, usd: 0 }],
      byModel: [],
      byProvider: [],
      byRepository: [],
    })
    mockApi({ "GET /api/usage?period=7d": empty, ...recentRoutes([]) })
    renderWithProviders(<App />, { route: "/usage" })

    expect(await screen.findByText("No data for this period")).toBeInTheDocument()
    expect(screen.getByText("No provider usage yet")).toBeInTheDocument()
    expect(screen.getByText("No model usage yet")).toBeInTheDocument()
    expect(await screen.findByText("No reviews with model usage in this period.")).toBeInTheDocument()
    expect(screen.getByText("No usage recorded in this period.")).toBeInTheDocument()
  })

  it("draws the charts when there is data", async () => {
    mockApi({ "GET /api/usage?period=7d": report(), ...recentRoutes() })
    const { container } = renderWithProviders(<App />, { route: "/usage" })

    await screen.findByRole("region", { name: "Usage totals" })
    await waitFor(() => expect(container.querySelectorAll('[data-slot="chart"]')).toHaveLength(3))
  })
})

describe("bucketLabel", () => {
  it("labels hours in UTC, as the buckets are, whatever the viewer's time zone", () => {
    vi.stubEnv("TZ", "America/New_York")
    try {
      expect(bucketLabel("2026-01-15T14:00:00.000Z", "hour")).toMatch(/^(14:00|02:00\sPM)$/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
