import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"
import type { BacklogItem, BacklogStats } from "@/features/backlog/types"

const item: BacklogItem = {
  id: "b-1",
  state: "open",
  resolution: null,
  origin: "fix_later",
  title: "SQL built from input",
  file: "src/app.ts",
  startLine: 3,
  endLine: 5,
  severity: "critical",
  category: "security",
  kind: "potential_issue",
  baseBranch: "main",
  sourceNumber: 42,
  sourceChangeTitle: "Add search",
  author: "alice",
  ignoreNote: null,
  resolvedNumber: null,
  resolvedJobId: null,
  resolvedAt: null,
  dismissedAt: null,
  dismissNote: null,
  firstSeenAt: "2026-10-04T12:00:00Z",
  mergedAt: "2026-10-06T12:00:00Z",
  lastSeenAt: "2026-10-05T12:00:00Z",
  repository: { id: "repo-1", provider: "github", host: "github.com", fullPath: "acme/web" },
}

const fixed: BacklogItem = {
  ...item,
  id: "b-2",
  state: "resolved",
  resolution: "fixed",
  origin: "open",
  title: "Unchecked null",
  resolvedNumber: 51,
  resolvedJobId: "review-51",
  resolvedAt: "2026-10-09T12:00:00Z",
}

const stats: BacklogStats = {
  open: 3,
  bySeverity: [
    { severity: "critical", count: 1 },
    { severity: "minor", count: 2 },
  ],
  byAge: [
    { key: "week", count: 0 },
    { key: "month", count: 2 },
    { key: "quarter", count: 1 },
    { key: "older", count: 0 },
  ],
}

const page = (items: BacklogItem[]) => ({ items, total: items.length, page: 1, limit: 10 })
const OPEN = "GET /api/backlog?state=open&page=1&limit=10"

describe("Backlog page", () => {
  it("lists open items by default, with where they shipped and the stats", async () => {
    mockApi({ "GET /api/backlog/stats": stats, [OPEN]: page([item]) })
    renderWithProviders(<App />, { route: "/backlog" })

    const cards = await screen.findByRole("region", { name: "Backlog stats" })
    expect(within(cards).getByText("Open items").parentElement!.nextSibling).toHaveTextContent("3")
    expect(within(cards).getByText("Under a month").nextSibling).toHaveTextContent("2")

    const row = (await screen.findByText("SQL built from input")).closest("tr")!
    expect(within(row).getByText("src/app.ts:3-5")).toBeInTheDocument()
    expect(within(row).getByText("#42 into main")).toBeInTheDocument()
    expect(within(row).getByText(/Fix later/)).toBeInTheDocument()
    expect(within(row).getByText("web")).toBeInTheDocument()
    expect(within(row).getByText("Open")).toBeInTheDocument()
  })

  it("names the linked issue instead of an empty file", async () => {
    const gap: BacklogItem = { ...item, title: "#12: Log each export", file: "", startLine: 1, endLine: 1, kind: "requirement_gap" }
    mockApi({ "GET /api/backlog/stats": stats, [OPEN]: page([gap]) })
    renderWithProviders(<App />, { route: "/backlog" })

    const row = (await screen.findByText("#12: Log each export")).closest("tr")!
    expect(within(row).getByText("Linked issue")).toBeInTheDocument()
    expect(within(row).queryByText(":1")).not.toBeInTheDocument()
  })

  it("counts only the selected repository's items in the stats", async () => {
    mockApi({
      "GET /api/backlog/stats": stats,
      "GET /api/backlog/stats?repoId=repo-1": { ...stats, open: 7 },
      "GET /api/backlog?repoId=repo-1&state=open&page=1&limit=10": page([item]),
    })
    renderWithProviders(<App />, { route: "/backlog?repo=repo-1" })

    const cards = await screen.findByRole("region", { name: "Backlog stats" })
    expect(within(cards).getByText("Open items").parentElement!.nextSibling).toHaveTextContent("7")
  })

  it("dismisses an item with a note", async () => {
    const patch = vi.fn(() => jsonResponse(200, { item: { ...item, state: "dismissed" } }))
    mockApi({ "GET /api/backlog/stats": stats, [OPEN]: page([item]), "PATCH /api/backlog/b-1": patch })
    renderWithProviders(<App />, { route: "/backlog" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for SQL built from input" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Dismiss" }))
    const dialog = await screen.findByRole("dialog", { name: "Dismiss this backlog item?" })
    await userEvent.type(within(dialog).getByLabelText(/Why is it not worth fixing/), "Module is going away")
    await userEvent.click(within(dialog).getByRole("button", { name: "Dismiss item" }))

    await waitFor(() => expect(patch).toHaveBeenCalled())
    const [init] = patch.mock.calls[0] as unknown as [RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ state: "dismissed", note: "Module is going away" })
  })

  it("shows how a resolved item was resolved, and reopens it", async () => {
    const patch = vi.fn(() => jsonResponse(200, { item: { ...fixed, state: "open" } }))
    mockApi({
      "GET /api/backlog/stats": stats,
      "GET /api/backlog?state=resolved&page=1&limit=10": page([fixed]),
      "PATCH /api/backlog/b-2": patch,
    })
    renderWithProviders(<App />, { route: "/backlog?state=resolved" })

    const row = (await screen.findByText("Unchecked null")).closest("tr")!
    expect(within(row).getByText("Fixed")).toBeInTheDocument()
    expect(within(row).getByRole("link", { name: "#51" })).toHaveAttribute("href", "/reviews/review-51")
    // A state other than the default shows as a removable chip.
    expect(screen.getByText("Resolved", { selector: "*:not(option)" })).toBeInTheDocument()

    await userEvent.click(within(row).getByRole("button", { name: "Actions for Unchecked null" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reopen" }))
    await waitFor(() => expect(patch).toHaveBeenCalled())
    const [init] = patch.mock.calls[0] as unknown as [RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ state: "open" })
  })

  it("says when the backlog is empty", async () => {
    mockApi({ "GET /api/backlog/stats": { open: 0, bySeverity: [], byAge: [] }, [OPEN]: page([]) })
    renderWithProviders(<App />, { route: "/backlog" })
    expect(
      await screen.findByText("The backlog is empty. Findings still open when a change merges will show up here."),
    ).toBeInTheDocument()
  })
})
