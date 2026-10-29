import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"
import type { FindingCalibration, FindingDetail, FindingRow, FindingStats } from "@/features/findings/types"
import { detail as reviewDetail } from "@/test/fixtures"

const finding: FindingRow = {
  id: "f-1",
  number: 42,
  state: "open",
  lifecycle: "new",
  title: "SQL built from input",
  file: "src/app.ts",
  startLine: 3,
  severity: "critical",
  category: "security",
  kind: "potential_issue",
  changeTitle: "Add b and c",
  author: "alice",
  lastJobId: "review-1",
  firstSeenAt: "2026-10-04T12:00:00Z",
  lastSeenAt: "2026-10-04T12:00:00Z",
  resolvedAt: null,
  ignoredAt: null,
  ignoreReason: null,
  ignoreNote: null,
  repository: { id: "repo-1", provider: "github", host: "github.com", fullPath: "acme/web" },
}

const stats: FindingStats = {
  days: 30,
  open: 5,
  openBySeverity: { critical: 1, major: 2, minor: 1, info: 1 },
  resolved: 3,
  total: 8,
  resolutionRate: 38,
  staleOpen: 2,
  medianTimeToResolve: 52 * 3_600_000,
  falsePositives: 1,
  found: 9,
  falsePositiveRate: 11,
  falsePositivesBy: {
    category: [
      { key: "security", found: 5, falsePositives: 1, rate: 20 },
      { key: "bug", found: 4, falsePositives: 0, rate: 0 },
    ],
    severity: [
      { key: "critical", found: 5, falsePositives: 1, rate: 20 },
      { key: "major", found: 4, falsePositives: 0, rate: 0 },
    ],
    model: [{ key: "anthropic/claude-sonnet-5-5", found: 9, falsePositives: 1, rate: 11 }],
    rule: [],
  },
}

const page = (findings: FindingRow[]) => ({ findings, total: findings.length, page: 1, limit: 10 })

const falsePositive: FindingRow = {
  ...finding,
  id: "f-9",
  state: "ignored",
  title: "Unused import flagged",
  ignoredAt: "2026-10-05T12:00:00Z",
  ignoreReason: "false_positive",
  ignoreNote: "It is used by the decorator.",
}
const FP = "GET /api/findings?state=ignored&ignoreReason=false_positive"

describe("Findings page", () => {
  it("shows the stat cards and findings with every column", async () => {
    mockApi({
      "GET /api/findings/stats": stats,
      "GET /api/findings?page=1&limit=10": page([finding]),
    })
    renderWithProviders(<App />, { route: "/findings" })

    const cards = await screen.findByRole("region", { name: "Finding stats" })
    expect(within(cards).getByText("Open findings").parentElement!.nextSibling).toHaveTextContent("5")
    expect(within(cards).getByText("38%")).toBeInTheDocument()
    expect(within(cards).getByText("3 of 8")).toBeInTheDocument()
    expect(within(cards).getByText("2 older than 30 days")).toBeInTheDocument()
    expect(within(cards).getByText("Median time to resolve").parentElement!.nextSibling).toHaveTextContent("2d 04h")
    expect(within(cards).getByText("11%")).toBeInTheDocument()
    expect(within(cards).getByText("1 of 9")).toBeInTheDocument()

    const row = (await screen.findByRole("button", { name: "SQL built from input" })).closest("tr")!
    expect(within(row).getByText("src/app.ts:3")).toBeInTheDocument()
    expect(within(row).getByText("#42")).toBeInTheDocument()
    // The repository name only, without its owner.
    expect(within(row).getByText("web")).toBeInTheDocument()
    expect(within(row).getByText("Open")).toBeInTheDocument()
    expect(within(row).getByText("critical")).toBeInTheDocument()
    expect(within(row).getByText("Security")).toBeInTheDocument()
    expect(within(row).getByText("Potential issue")).toBeInTheDocument()
    expect(within(row).getByText("alice")).toBeInTheDocument()
  })

  it("breaks false positives down, hiding thin rows and hinting at the noisy ones", async () => {
    mockApi({
      "GET /api/findings/stats": {
        ...stats,
        falsePositivesBy: {
          category: [
            { key: "style", found: 8, falsePositives: 4, rate: 50 },
            { key: "bug", found: 7, falsePositives: 3, rate: 43 },
            { key: "security", found: 6, falsePositives: 0, rate: 0 },
            { key: "docs", found: 2, falsePositives: 2, rate: 100 },
          ],
          severity: [
            { key: "major", found: 6, falsePositives: 2, rate: 33 },
            { key: "minor", found: 10, falsePositives: 4, rate: 40 },
          ],
          model: [{ key: null, found: 16, falsePositives: 6, rate: 38 }],
          rule: [{ key: "no-db-in-controllers", found: 6, falsePositives: 3, rate: 50 }],
        },
      },
      "GET /api/findings?page=1&limit=10": page([finding]),
      [`${FP}&page=1&limit=10`]: page([]),
    })
    renderWithProviders(<App />, { route: "/findings" })
    await userEvent.click(await screen.findByRole("tab", { name: "False positives" }))

    const byCategory = await screen.findByRole("table", { name: "False positives by category" })
    const style = within(byCategory).getByText("Style").closest("tr")!
    expect(within(style).getByText("50%")).toBeInTheDocument()
    expect(within(style).getByRole("link", { name: "Drop Style from the reviewed categories" })).toHaveAttribute(
      "href",
      "/configuration?tab=findings",
    )
    expect(within(within(byCategory).getByText("Security").closest("tr")!).queryByRole("link")).toBeNull()
    // Noise in a category a review exists for points at confidence, not at dropping it.
    const bug = within(byCategory).getByText("Bug").closest("tr")!
    expect(within(bug).getByRole("link", { name: "Raise the minimum confidence" })).toBeInTheDocument()
    expect(within(bug).queryByRole("link", { name: /Drop/ })).toBeNull()
    // Two findings is too few to call docs noisy, whatever the rate says.
    expect(within(byCategory).queryByText("Docs")).toBeNull()
    expect(screen.getByText("1 row with fewer than 5 findings hidden")).toBeInTheDocument()

    // A noisy major gets no settings hint; a noisy minor does.
    const bySeverity = screen.getByRole("table", { name: "False positives by severity" })
    expect(within(within(bySeverity).getByText("major").closest("tr")!).queryByRole("link")).toBeNull()
    expect(within(bySeverity).getByRole("link", { name: "Raise the minimum confidence or severity floor" })).toBeInTheDocument()

    const byModel = screen.getByRole("table", { name: "False positives by model" })
    expect(within(byModel).getByText("Analyzer or unrecorded")).toBeInTheDocument()
    expect(within(byModel).queryByRole("link")).toBeNull()

    // Findings per .sentryward.yaml rule; a rule has no setting here to point at.
    const byRule = screen.getByRole("table", { name: "False positives by rule" })
    expect(within(within(byRule).getByText("no-db-in-controllers").closest("tr")!).getByText("50%")).toBeInTheDocument()
    expect(within(byRule).queryByRole("link")).toBeNull()
  })

  it("shows no rule table without rule findings", async () => {
    mockApi({
      "GET /api/findings/stats": stats,
      "GET /api/findings?page=1&limit=10": page([finding]),
      [`${FP}&page=1&limit=10`]: page([]),
    })
    renderWithProviders(<App />, { route: "/findings?tab=false-positives" })
    await screen.findByRole("table", { name: "False positives by category" })
    expect(screen.queryByRole("table", { name: "False positives by rule" })).toBeNull()
  })

  it("shows how self-reported confidence matched outcomes, overall and by model", async () => {
    const bucket = (min: number, found: number, confirmed: number, falsePositives: number) => {
      const decided = confirmed + falsePositives
      const pct = (n: number) => (decided ? Math.round((n / decided) * 100) : null)
      return { min, max: min + 0.1, found, confirmed, falsePositives, decided, confirmedRate: pct(confirmed), falsePositiveRate: pct(falsePositives) }
    }
    const calibration = (groupBy: FindingCalibration["groupBy"], groups: FindingCalibration["groups"]): FindingCalibration => ({
      days: 30,
      groupBy,
      selfReported: true,
      note: "",
      groups,
    })
    mockApi({
      "GET /api/findings/stats": stats,
      "GET /api/findings?page=1&limit=10": page([finding]),
      [`${FP}&page=1&limit=10`]: page([]),
      "GET /api/findings/calibration": calibration("none", [
        { key: null, found: 14, buckets: [bucket(0.6, 4, 1, 1), bucket(0.9, 10, 6, 2)] },
      ]),
      "GET /api/findings/calibration?groupBy=model": calibration("model", [
        { key: "anthropic/claude", found: 10, buckets: [bucket(0.9, 10, 6, 2)] },
        { key: null, found: 4, buckets: [bucket(0.6, 4, 1, 1)] },
      ]),
    })
    renderWithProviders(<App />, { route: "/findings?tab=false-positives" })

    const card = await screen.findByRole("region", { name: "Confidence calibration" })
    expect(within(card).getByText(/Confidence is self-reported by the model/)).toBeInTheDocument()
    const table = await within(card).findByRole("table", { name: "Calibration" })
    const high = within(table).getByText("90-100%").closest("tr")!
    expect(within(high).getByText("75%")).toBeInTheDocument()
    expect(within(high).getByText("25%")).toBeInTheDocument()
    // Two decided findings is too few to trust; the row is muted.
    expect(within(table).getByText("60-70%").closest("tr")).toHaveClass("text-muted-foreground")
    expect(high).not.toHaveClass("text-muted-foreground")

    await userEvent.click(within(card).getByRole("combobox", { name: "Group calibration" }))
    await userEvent.click(await screen.findByRole("option", { name: "By model" }))
    expect(await within(card).findByRole("table", { name: "Calibration for anthropic/claude" })).toBeInTheDocument()
    expect(within(card).getByRole("table", { name: "Calibration for Unrecorded model" })).toBeInTheDocument()
  })

  it("scopes the breakdown and its hints to the selected repository", async () => {
    const repo = (id: string, fullPath: string) => ({ id, fullPath, provider: "gitlab", host: "gitlab.com", enabled: true })
    const scoped: FindingStats = {
      ...stats,
      found: 6,
      falsePositivesBy: {
        category: [{ key: "style", found: 6, falsePositives: 3, rate: 50 }],
        severity: [],
        model: [{ key: "openai/gpt-5", found: 6, falsePositives: 3, rate: 50 }],
        rule: [],
      },
    }
    mockApi({
      "GET /api/repos": { repos: [repo("r1", "team/web"), repo("r2", "team/api")] },
      "GET /api/findings/stats": stats,
      "GET /api/findings/stats?repoId=r2": scoped,
      "GET /api/findings?page=1&limit=10": page([finding]),
      [`${FP}&page=1&limit=10`]: page([falsePositive]),
      [`GET /api/findings?repoId=r2&state=ignored&ignoreReason=false_positive&page=1&limit=10`]: page([]),
    })
    renderWithProviders(<App />, { route: "/findings?tab=false-positives" })
    await screen.findByRole("table", { name: "False positives by category" })
    await screen.findByRole("button", { name: "Unused import flagged" })

    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    await userEvent.click(await screen.findByRole("combobox", { name: "Repository" }))
    await userEvent.click(screen.getByRole("option", { name: "team/api" }))

    const region = await screen.findByRole("region", { name: "False positive breakdown" })
    await within(region).findByText(/in team\/api/)
    expect(within(region).getByRole("link", { name: "Drop Style from the reviewed categories" })).toHaveAttribute(
      "href",
      "/configuration?tab=findings&repo=r2",
    )
    expect(within(region).getByRole("link", { name: "Try another model" })).toHaveAttribute(
      "href",
      "/configuration?tab=llm&repo=r2",
    )

    // The list below the breakdown follows the same repository.
    expect(await screen.findByRole("cell", { name: "No false positives match your filters." })).toBeInTheDocument()

    // Each tab keeps its own filters, so the findings list is not narrowed.
    await userEvent.click(screen.getByRole("tab", { name: "Findings" }))
    expect(await screen.findByRole("button", { name: "SQL built from input" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Remove Repository filter/i })).toBeNull()
  })

  it("keeps the breakdown and the findings list on separate tabs", async () => {
    mockApi({
      "GET /api/findings/stats": stats,
      "GET /api/findings?page=1&limit=10": page([finding]),
      [`${FP}&page=1&limit=10`]: page([falsePositive]),
    })
    renderWithProviders(<App />, { route: "/findings" })

    await screen.findByRole("button", { name: "SQL built from input" })
    expect(screen.getByRole("tab", { name: "Findings" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("region", { name: "False positive breakdown" })).toBeNull()

    await userEvent.click(screen.getByRole("tab", { name: "False positives" }))
    expect(await screen.findByRole("region", { name: "False positive breakdown" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "SQL built from input" })).toBeNull()
    // The cards sit above the tabs, so they stay on both.
    expect(screen.getByRole("region", { name: "Finding stats" })).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "Unused import flagged" })).toBeInTheDocument()
    expect(screen.getByRole("searchbox", { name: "Search false positives" })).toBeInTheDocument()
    expect(screen.queryByRole("searchbox", { name: "Search findings" })).toBeNull()
  })

  it("filters by what the last review found, telling a fix from a refactor", async () => {
    const invalidated = { ...finding, id: "f-2", state: "resolved" as const, lifecycle: "invalidated" as const, title: "Moved helper" }
    mockApi({
      "GET /api/findings/stats": stats,
      "GET /api/findings?page=1&limit=10": page([finding, invalidated]),
      "GET /api/findings?lifecycle=invalidated&page=1&limit=10": page([invalidated]),
      [`${FP}&page=1&limit=10`]: page([]),
    })
    renderWithProviders(<App />, { route: "/findings" })

    await screen.findByRole("button", { name: "SQL built from input" })
    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    await userEvent.click(screen.getByRole("combobox", { name: "Last review" }))
    await userEvent.click(await screen.findByRole("option", { name: "Invalidated" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "SQL built from input" })).toBeNull())
    expect(screen.getByRole("button", { name: "Moved helper" })).toBeInTheDocument()
  })

  it("filters by findings a review reported again after a fix", async () => {
    const reopened = { ...finding, id: "f-2", lifecycle: "reopened" as const, title: "Back again" }
    mockApi({
      "GET /api/findings/stats": stats,
      "GET /api/findings?page=1&limit=10": page([finding, reopened]),
      "GET /api/findings?lifecycle=reopened&page=1&limit=10": page([reopened]),
      [`${FP}&page=1&limit=10`]: page([]),
    })
    renderWithProviders(<App />, { route: "/findings" })

    await screen.findByRole("button", { name: "SQL built from input" })
    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    await userEvent.click(screen.getByRole("combobox", { name: "Last review" }))
    await userEvent.click(await screen.findByRole("option", { name: "Reopened" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "SQL built from input" })).toBeNull())
    expect(screen.getByRole("button", { name: "Back again" })).toBeInTheDocument()
  })

  it("keeps the findings filters when switching tabs and back", async () => {
    const resolved = { ...finding, id: "f-2", state: "resolved" as const, title: "Old bug" }
    mockApi({
      "GET /api/findings/stats": stats,
      "GET /api/findings?page=1&limit=10": page([finding, resolved]),
      "GET /api/findings?state=resolved&page=1&limit=10": page([resolved]),
      [`${FP}&page=1&limit=10`]: page([]),
    })
    renderWithProviders(<App />, { route: "/findings" })

    await screen.findByRole("button", { name: "SQL built from input" })
    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    await userEvent.click(screen.getByRole("combobox", { name: "State" }))
    await userEvent.click(await screen.findByRole("option", { name: "Resolved" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "SQL built from input" })).toBeNull())

    await userEvent.click(screen.getByRole("tab", { name: "False positives" }))
    await screen.findByRole("region", { name: "False positive breakdown" })
    // The false-positive list has filters of its own.
    expect(screen.queryByRole("button", { name: /Remove State filter/i })).toBeNull()
    await userEvent.click(screen.getByRole("tab", { name: "Findings" }))

    expect(await screen.findByRole("button", { name: "Old bug" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Remove State filter/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "SQL built from input" })).toBeNull()
  })

  it("reads each tab's filters and sort from the URL", async () => {
    const resolved = { ...finding, id: "f-2", state: "resolved" as const, title: "Old bug" }
    const fpRequest = vi.fn(() => jsonResponse(200, page([])))
    mockApi({
      "GET /api/findings/stats": stats,
      "GET /api/findings?state=resolved&sort=severity&dir=desc&page=1&limit=10": page([resolved]),
      [`${FP}&severity=critical&page=1&limit=10`]: fpRequest,
    })
    renderWithProviders(<App />, {
      route: "/findings?state=resolved&sort=severity&dir=desc&fpSeverity=critical&kind=bogus",
    })

    expect(await screen.findByRole("button", { name: "Old bug" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Severity" })).toHaveAttribute("aria-sort", "descending")
    expect(screen.getByRole("button", { name: /Remove State filter/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Remove Type filter/i })).toBeNull()

    await userEvent.click(screen.getByRole("tab", { name: "False positives" }))
    await waitFor(() => expect(fpRequest).toHaveBeenCalled())
    await userEvent.click(screen.getByRole("tab", { name: "Findings" }))
    expect(await screen.findByRole("button", { name: "Old bug" })).toBeInTheDocument()
  })

  it("shows an empty state on the false positives tab when there are no findings", async () => {
    mockApi({
      "GET /api/findings/stats": { ...stats, found: 0, falsePositives: 0, falsePositiveRate: null },
      "GET /api/findings?page=1&limit=10": page([]),
      [`${FP}&page=1&limit=10`]: page([]),
    })
    renderWithProviders(<App />, { route: "/findings?tab=false-positives" })

    expect(await screen.findByText("No findings yet")).toBeInTheDocument()
    expect(screen.getByText(/nothing to break down/)).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "False positive breakdown" })).toBeNull()
    expect(await screen.findByRole("cell", { name: /^No false positives yet/ })).toBeInTheDocument()
  })

  it("lists findings in every state on first load", async () => {
    const resolved = { ...finding, id: "f-2", state: "resolved" as const, title: "Old bug", author: null }
    mockApi({ "GET /api/findings?page=1&limit=10": page([finding, resolved]) })
    renderWithProviders(<App />, { route: "/findings" })

    const row = (await screen.findByRole("button", { name: "Old bug" })).closest("tr")!
    expect(within(row).getByText("Resolved")).toBeInTheDocument()
    // A finding from before authors were stored.
    expect(within(row).getByText("-")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Remove State filter/i })).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    expect(screen.getByRole("combobox", { name: "State" })).toHaveTextContent("All states")
  })

  it("narrows by state and goes back to every state once the filters are cleared", async () => {
    const resolved = { ...finding, id: "f-2", state: "resolved" as const, title: "Old bug" }
    mockApi({
      "GET /api/findings?page=1&limit=10": page([finding, resolved]),
      "GET /api/findings?state=open&page=1&limit=10": page([finding]),
    })
    renderWithProviders(<App />, { route: "/findings" })

    await screen.findByRole("button", { name: "Old bug" })
    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    await userEvent.click(screen.getByRole("combobox", { name: "State" }))
    await userEvent.click(await screen.findByRole("option", { name: "Open" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Old bug" })).toBeNull())
    expect(screen.getByRole("button", { name: "Remove State filter" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(await screen.findByRole("button", { name: "Old bug" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove State filter" })).toBeNull()
  })

  it("asks why before ignoring a finding from its row menu", async () => {
    let sent: unknown
    mockApi({
      "GET /api/findings?page=1&limit=10": page([finding]),
      "PATCH /api/findings/f-1": (init?: RequestInit) => {
        sent = JSON.parse(String(init?.body))
        return jsonResponse(200, { finding: { ...finding, state: "ignored" } })
      },
    })
    renderWithProviders(<App />, { route: "/findings" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for SQL built from input" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Ignore" }))
    const dialog = await screen.findByRole("dialog", { name: "Ignore this finding?" })

    // A reason is required.
    await userEvent.click(within(dialog).getByRole("button", { name: "Ignore finding" }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Choose a reason")
    expect(sent).toBeUndefined()

    await userEvent.click(within(dialog).getByRole("combobox", { name: "Why are you dismissing this?" }))
    const option = await screen.findByRole("option", { name: /^False positive/ })
    expect(option).toHaveTextContent("The finding is wrong")
    await userEvent.click(option)
    // The trigger shows the label alone, not the description.
    expect(within(dialog).getByRole("combobox", { name: "Why are you dismissing this?" })).toHaveTextContent(
      /^False positive$/,
    )
    await userEvent.type(within(dialog).getByLabelText(/Explain your reasoning/), "Validated upstream.")
    await userEvent.click(within(dialog).getByRole("button", { name: "Ignore finding" }))

    await waitFor(() => expect(sent).toEqual({ state: "ignored", reason: "false_positive", note: "Validated upstream." }))
    expect(await screen.findByText("Finding ignored")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ignore this finding?" })).not.toBeInTheDocument())
  })

  it("leaves the finding alone when the ignore dialog is cancelled", async () => {
    let patched = false
    mockApi({
      "GET /api/findings?page=1&limit=10": page([finding]),
      "PATCH /api/findings/f-1": () => {
        patched = true
        return jsonResponse(200, { finding })
      },
    })
    renderWithProviders(<App />, { route: "/findings" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for SQL built from input" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Ignore" }))
    const dialog = await screen.findByRole("dialog", { name: "Ignore this finding?" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ignore this finding?" })).not.toBeInTheDocument())
    expect(patched).toBe(false)
  })

  it("confirms before reopening an ignored finding from its row menu", async () => {
    let sent: unknown
    const ignored: FindingRow = {
      ...finding,
      state: "ignored",
      ignoreReason: "intentional",
      ignoreNote: "Kept for the legacy importer.",
    }
    mockApi({
      // The row's own state drives its menu.
      "GET /api/findings?page=1&limit=10": page([ignored]),
      "PATCH /api/findings/f-1": (init?: RequestInit) => {
        sent = JSON.parse(String(init?.body))
        return jsonResponse(200, { finding })
      },
    })
    renderWithProviders(<App />, { route: "/findings" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for SQL built from input" }))
    expect(screen.queryByRole("menuitem", { name: "Ignore" })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reopen" }))

    const dialog = await screen.findByRole("dialog", { name: "Reopen this finding?" })
    expect(sent).toBeUndefined()
    // What reopening throws away is on screen before confirming.
    expect(within(dialog).getByText("Intentional")).toBeInTheDocument()
    expect(within(dialog).getByText("Kept for the legacy importer.")).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "Reopen finding" }))

    await waitFor(() => expect(sent).toEqual({ state: "open" }))
    expect(await screen.findByText("Finding reopened")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reopen this finding?" })).not.toBeInTheDocument())
  })

  it("leaves the finding ignored when the reopen dialog is cancelled", async () => {
    let patched = false
    mockApi({
      "GET /api/findings?page=1&limit=10": page([{ ...finding, state: "ignored" }]),
      "PATCH /api/findings/f-1": () => {
        patched = true
        return jsonResponse(200, { finding })
      },
    })
    renderWithProviders(<App />, { route: "/findings" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for SQL built from input" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reopen" }))
    const dialog = await screen.findByRole("dialog", { name: "Reopen this finding?" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reopen this finding?" })).not.toBeInTheDocument())
    expect(patched).toBe(false)
  })

  it("keeps the table and says there are no findings yet when nothing is filtered", async () => {
    mockApi({ "GET /api/findings?page=1&limit=10": page([]) })
    renderWithProviders(<App />, { route: "/findings" })

    const cell = await screen.findByRole("cell", { name: /^No findings yet/ })
    expect(cell.closest("table")).toBe(screen.getByRole("table"))
    expect(screen.getByRole("columnheader", { name: "Severity" })).toBeInTheDocument()
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument()
    expect(screen.queryByText("No open findings.")).toBeNull()
  })

  it("says the filters missed when a state filter finds nothing", async () => {
    mockApi({
      "GET /api/findings?page=1&limit=10": page([finding]),
      "GET /api/findings?state=resolved&page=1&limit=10": page([]),
    })
    renderWithProviders(<App />, { route: "/findings" })

    await screen.findByRole("button", { name: "SQL built from input" })
    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    await userEvent.click(screen.getByRole("combobox", { name: "State" }))
    await userEvent.click(await screen.findByRole("option", { name: "Resolved" }))

    expect(await screen.findByRole("cell", { name: "No findings match your filters." })).toBeInTheDocument()
  })

  it("says the filters missed when a search finds nothing", async () => {
    mockApi({
      "GET /api/findings?page=1&limit=10": page([finding]),
      "GET /api/findings?q=nothing&page=1&limit=10": page([]),
    })
    renderWithProviders(<App />, { route: "/findings" })

    await screen.findByRole("button", { name: "SQL built from input" })
    await userEvent.type(screen.getByRole("searchbox", { name: "Search findings" }), "nothing")

    expect(await screen.findByRole("cell", { name: "No findings match your filters." })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "PR/MR Author" })).toBeInTheDocument()
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument()
  })
})

const full = reviewDetail.result!.findings[0]!
const findingDetail: FindingDetail = {
  finding,
  detail: { ...full, title: finding.title, body: "The query concatenates user input.", suggestion: "db.query(sql, [b]);" },
  change: reviewDetail.result!.change,
}

describe("Findings sorting", () => {
  it("asks the server to sort by a column, then the other way, then not at all", async () => {
    const requested: string[] = []
    const answer = (url: string) => () => {
      requested.push(url)
      return jsonResponse(200, page([finding]))
    }
    const base = "GET /api/findings?"
    mockApi({
      [`${base}page=1&limit=10`]: answer("default"),
      [`${base}sort=severity&dir=asc&page=1&limit=10`]: answer("asc"),
      [`${base}sort=severity&dir=desc&page=1&limit=10`]: answer("desc"),
    })
    renderWithProviders(<App />, { route: "/findings" })

    await screen.findByRole("button", { name: "SQL built from input" })
    const header = () => screen.getByRole("button", { name: "Severity" })
    await userEvent.click(header())
    await waitFor(() => expect(requested).toContain("asc"))
    expect(screen.getByRole("columnheader", { name: "Severity" })).toHaveAttribute("aria-sort", "ascending")
    await userEvent.click(header())
    await waitFor(() => expect(requested).toContain("desc"))
    expect(screen.getByRole("columnheader", { name: "Severity" })).toHaveAttribute("aria-sort", "descending")
    await userEvent.click(header())
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "Severity" })).not.toHaveAttribute("aria-sort"))
  })
})

describe("Finding details sheet", () => {
  it("opens the finding in a sheet instead of leaving the page", async () => {
    mockApi({
      "GET /api/findings?page=1&limit=10": page([finding]),
      "GET /api/findings/f-1": findingDetail,
    })
    renderWithProviders(<App />, { route: "/findings" })

    await userEvent.click(await screen.findByRole("button", { name: "SQL built from input" }))

    const sheet = await screen.findByRole("dialog", { name: "SQL built from input" })
    expect(await within(sheet).findByText("The query concatenates user input.")).toBeInTheDocument()
    expect(within(sheet).getByText("db.query(sql, [b]);")).toBeInTheDocument()
    expect(within(sheet).getByText("acme/web")).toBeInTheDocument()
    expect(within(sheet).getByText("alice")).toBeInTheDocument()
    expect(within(sheet).getByRole("link", { name: "Open review" })).toHaveAttribute("href", "/reviews/review-1")
    // Still on the findings page underneath.
    expect(screen.getByRole("table", { hidden: true })).toBeInTheDocument()
  })

  it("explains when the full text is gone", async () => {
    mockApi({
      "GET /api/findings?page=1&limit=10": page([finding]),
      "GET /api/findings/f-1": { finding: { ...finding, lastJobId: null }, detail: null, change: null },
    })
    renderWithProviders(<App />, { route: "/findings" })

    await userEvent.click(await screen.findByRole("button", { name: "SQL built from input" }))

    const sheet = await screen.findByRole("dialog", { name: "SQL built from input" })
    expect(await within(sheet).findByText("Full details are no longer available for this finding.")).toBeInTheDocument()
    expect(within(sheet).queryByRole("link", { name: "Open review" })).not.toBeInTheDocument()
  })

  it("ignores the finding from the sheet", async () => {
    let sent: unknown
    mockApi({
      "GET /api/findings?page=1&limit=10": page([finding]),
      "GET /api/findings/f-1": findingDetail,
      "PATCH /api/findings/f-1": (init?: RequestInit) => {
        sent = JSON.parse(String(init?.body))
        return jsonResponse(200, { finding: { ...finding, state: "ignored" } })
      },
    })
    renderWithProviders(<App />, { route: "/findings" })

    await userEvent.click(await screen.findByRole("button", { name: "SQL built from input" }))
    const sheet = await screen.findByRole("dialog", { name: "SQL built from input" })
    await userEvent.click(within(sheet).getByRole("button", { name: "Ignore" }))
    const dialog = await screen.findByRole("dialog", { name: "Ignore this finding?" })
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Why are you dismissing this?" }))
    await userEvent.click(await screen.findByRole("option", { name: /^Fix later/ }))
    await userEvent.click(within(dialog).getByRole("button", { name: "Ignore finding" }))

    // No note typed, so none is sent.
    await waitFor(() => expect(sent).toEqual({ state: "ignored", reason: "fix_later" }))
  })

  it("shows why an ignored finding was dismissed", async () => {
    const ignored: FindingRow = {
      ...finding,
      state: "ignored",
      ignoredAt: "2026-10-04T12:00:00Z",
      ignoreReason: "false_positive",
      ignoreNote: "Validated upstream.",
    }
    mockApi({
      "GET /api/findings?page=1&limit=10": page([ignored]),
      "GET /api/findings/f-1": { ...findingDetail, finding: ignored },
    })
    renderWithProviders(<App />, { route: "/findings" })

    await userEvent.click(await screen.findByRole("button", { name: "SQL built from input" }))
    const sheet = await screen.findByRole("dialog", { name: "SQL built from input" })

    expect(await within(sheet).findByText("False positive")).toBeInTheDocument()
    expect(within(sheet).getByText("Validated upstream.")).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "Reopen" })).toBeInTheDocument()
    expect(within(sheet).queryByRole("button", { name: "Ignore" })).not.toBeInTheDocument()
  })

  it("confirms before reopening from the sheet", async () => {
    let sent: unknown
    const ignored: FindingRow = { ...finding, state: "ignored", ignoreReason: "fix_later" }
    mockApi({
      "GET /api/findings?page=1&limit=10": page([ignored]),
      "GET /api/findings/f-1": { ...findingDetail, finding: ignored },
      "PATCH /api/findings/f-1": (init?: RequestInit) => {
        sent = JSON.parse(String(init?.body))
        return jsonResponse(200, { finding })
      },
    })
    renderWithProviders(<App />, { route: "/findings" })

    await userEvent.click(await screen.findByRole("button", { name: "SQL built from input" }))
    const sheet = await screen.findByRole("dialog", { name: "SQL built from input" })
    await userEvent.click(await within(sheet).findByRole("button", { name: "Reopen" }))
    const dialog = await screen.findByRole("dialog", { name: "Reopen this finding?" })
    expect(sent).toBeUndefined()
    await userEvent.click(within(dialog).getByRole("button", { name: "Reopen finding" }))

    await waitFor(() => expect(sent).toEqual({ state: "open" }))
  })
})

describe("False positives list", () => {
  it("lists findings dismissed as false positives under the breakdown", async () => {
    mockApi({
      "GET /api/findings/stats": stats,
      [`${FP}&page=1&limit=10`]: page([falsePositive]),
    })
    renderWithProviders(<App />, { route: "/findings?tab=false-positives" })

    await screen.findByRole("region", { name: "False positive breakdown" })
    const row = (await screen.findByRole("button", { name: "Unused import flagged" })).closest("tr")!
    expect(within(row).getByText("Ignored")).toBeInTheDocument()
    // Every list here is ignored, so there is no state to pick.
    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    expect(screen.queryByRole("combobox", { name: "State" })).toBeNull()
    expect(screen.getByRole("combobox", { name: "Severity" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Category" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Type" })).toBeInTheDocument()
  })

  it("searches and filters, with chips and a clear action", async () => {
    mockApi({
      "GET /api/findings/stats": stats,
      [`${FP}&page=1&limit=10`]: page([falsePositive]),
      [`${FP}&q=nothing&page=1&limit=10`]: page([]),
      [`${FP}&severity=minor&page=1&limit=10`]: page([]),
    })
    renderWithProviders(<App />, { route: "/findings?tab=false-positives" })

    await screen.findByRole("button", { name: "Unused import flagged" })
    const search = screen.getByRole("searchbox", { name: "Search false positives" })
    await userEvent.type(search, "nothing")
    expect(await screen.findByRole("cell", { name: "No false positives match your filters." })).toBeInTheDocument()
    await userEvent.clear(search)
    await screen.findByRole("button", { name: "Unused import flagged" })

    await userEvent.click(screen.getByRole("button", { name: "Filters" }))
    await userEvent.click(screen.getByRole("combobox", { name: "Severity" }))
    await userEvent.click(await screen.findByRole("option", { name: "Minor" }))
    expect(await screen.findByRole("button", { name: "Remove Severity filter" })).toBeInTheDocument()
    expect(await screen.findByRole("cell", { name: "No false positives match your filters." })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(await screen.findByRole("button", { name: "Unused import flagged" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove Severity filter" })).toBeNull()
  })

  it("starts over at the first page on a new search", async () => {
    const requested: string[] = []
    const answer = (name: string, body: unknown) => () => {
      requested.push(name)
      return jsonResponse(200, body)
    }
    mockApi({
      "GET /api/findings/stats": stats,
      [`${FP}&page=2&limit=10`]: answer("page 2", { findings: [falsePositive], total: 15, page: 2, limit: 10 }),
      [`${FP}&q=unused&page=1&limit=10`]: answer("search", page([falsePositive])),
    })
    renderWithProviders(<App />, { route: "/findings?tab=false-positives&fpPage=2" })

    await screen.findByRole("button", { name: "Unused import flagged" })
    expect(requested).toEqual(["page 2"])
    await userEvent.type(screen.getByRole("searchbox", { name: "Search false positives" }), "unused")
    await waitFor(() => expect(requested).toContain("search"))
  })

  it("falls back to the last page when the page is past the end", async () => {
    mockApi({
      "GET /api/findings/stats": stats,
      [`${FP}&page=5&limit=10`]: { findings: [], total: 3, page: 5, limit: 10 },
      [`${FP}&page=1&limit=10`]: page([falsePositive]),
    })
    renderWithProviders(<App />, { route: "/findings?tab=false-positives&fpPage=5" })

    expect(await screen.findByRole("button", { name: "Unused import flagged" })).toBeInTheDocument()
  })

  it("opens a false positive in the sheet, where it can be reopened", async () => {
    mockApi({
      "GET /api/findings/stats": stats,
      [`${FP}&page=1&limit=10`]: page([falsePositive]),
      "GET /api/findings/f-9": { ...findingDetail, finding: falsePositive },
    })
    renderWithProviders(<App />, { route: "/findings?tab=false-positives" })

    await userEvent.click(await screen.findByRole("button", { name: "Unused import flagged" }))
    const sheet = await screen.findByRole("dialog", { name: "Unused import flagged" })
    expect(await within(sheet).findByText("It is used by the decorator.")).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "Reopen" })).toBeInTheDocument()
  })
})
