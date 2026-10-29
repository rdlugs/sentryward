import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"
import { detail, listItem } from "@/test/fixtures"

describe("Reviews page", () => {
  it("lists reviews with their status, verdict and finding counts", async () => {
    mockApi({ "GET /api/reviews?view=changes&page=1&limit=10": { reviews: [listItem], total: 1, page: 1, limit: 10 } })
    renderWithProviders(<App />, { route: "/reviews" })

    const row = (await screen.findByRole("link", { name: "Add b and c" })).closest("tr")!
    expect(within(row).getByText("Completed")).toBeInTheDocument()
    expect(within(row).getByText("Blocked")).toBeInTheDocument()
    expect(within(row).getByText("critical")).toBeInTheDocument()
    expect(within(row).getByText("abcdef1")).toBeInTheDocument()
  })

  it("pages through reviews on the server", async () => {
    const reviewsPage = (n: number) => ({ ...listItem, id: `review-${n}`, title: `Review ${n}` })
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": { reviews: [reviewsPage(1)], total: 12, page: 1, limit: 10 },
      "GET /api/reviews?view=changes&page=2&limit=10": { reviews: [reviewsPage(11)], total: 12, page: 2, limit: 10 },
    })
    renderWithProviders(<App />, { route: "/reviews" })

    expect(await screen.findByText("Showing 1-10 of 12")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Next page" }))

    expect(await screen.findByRole("link", { name: "Review 11" })).toBeInTheDocument()
    expect(screen.getByText("Showing 11-12 of 12")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled()
  })

  it("shows the server's reason when a link cannot be reviewed", async () => {
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": { reviews: [], total: 0, page: 1, limit: 10 },
      "POST /api/reviews": () =>
        jsonResponse(404, { message: "acme/web is not connected; enable it under Repositories first" }),
    })
    renderWithProviders(<App />, { route: "/reviews" })

    expect(await screen.findByText("No reviews yet. Start a manual review to run the first one.")).toBeInTheDocument()
    await openManualReview()
    await userEvent.type(screen.getByLabelText("Review a pull or merge request"), "https://github.com/acme/web/pull/1")
    await userEvent.click(screen.getByRole("button", { name: "Review" }))

    expect(await screen.findByText(/is not connected/)).toBeInTheDocument()
  })

  it("opens the new review after queueing one", async () => {
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": { reviews: [], total: 0, page: 1, limit: 10 },
      "POST /api/reviews": () => jsonResponse(202, { review: { ...listItem, status: "queued", verdict: null } }),
      [`GET /api/reviews/${listItem.id}`]: { review: { ...detail, status: "queued", verdict: null, result: null } },
    })
    renderWithProviders(<App />, { route: "/reviews" })

    await openManualReview()
    await userEvent.type(await screen.findByLabelText("Review a pull or merge request"), "https://github.com/acme/web/pull/42")
    await userEvent.click(screen.getByRole("button", { name: "Review" }))

    expect(await screen.findByText("Waiting for a worker...")).toBeInTheDocument()
  })

  it("lists a repository's open changes and reviews the one picked", async () => {
    const queued = vi.fn((init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ repoId: "r1", number: 4 })
      return jsonResponse(202, { review: { ...listItem, status: "queued", verdict: null } })
    })
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": { reviews: [], total: 0, page: 1, limit: 10 },
      "GET /api/repos": { repos: [savedRepo("r1", "team/web"), savedRepo("r2", "team/off", { enabled: false })] },
      "GET /api/repos/r1/changes": {
        changes: [openChange(4, "Add search"), openChange(5, "Fix login", { isDraft: true })],
      },
      "POST /api/reviews": queued,
      [`GET /api/reviews/${listItem.id}`]: { review: { ...detail, status: "queued", verdict: null, result: null } },
    })
    renderWithProviders(<App />, { route: "/reviews" })

    await openManualReview()
    await userEvent.click(await screen.findByRole("combobox", { name: "Repository" }))
    expect(screen.queryByRole("option", { name: /team\/off/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("option", { name: /team\/web/ }))

    const list = await screen.findByRole("list", { name: "Open merge requests" })
    expect(within(list).getByText("Fix login")).toBeInTheDocument()
    expect(within(list).getByText("Draft")).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("Filter merge requests"), "search")
    expect(within(list).queryByText("Fix login")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Review !4" }))

    expect(await screen.findByText("Waiting for a worker...")).toBeInTheDocument()
    expect(queued).toHaveBeenCalledOnce()
  })
})

async function openManualReview() {
  await userEvent.click((await screen.findAllByRole("button", { name: "Manual review" }))[0]!)
}

const savedRepo = (id: string, fullPath: string, extra: Record<string, unknown> = {}) => ({
  id,
  connectionId: "c1",
  account: { login: "dev", provider: "gitlab", host: "gitlab.com" },
  externalId: id,
  fullPath,
  defaultBranch: "main",
  webUrl: `https://gitlab.com/${fullPath}`,
  enabled: true,
  settings: {},
  followGlobal: true,
  ...extra,
})

const openChange = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  author: "dev",
  isDraft: false,
  headSha: `h${number}`,
  sourceBranch: `feature-${number}`,
  targetBranch: "main",
  webUrl: `https://gitlab.com/team/web/-/merge_requests/${number}`,
  updatedAt: new Date().toISOString(),
  ...extra,
})

describe("Reviews page rows, filters and stats", () => {
  const firstPage = (reviews: unknown[], total = reviews.length) => ({ reviews, total, page: 1, limit: 10 })

  it("shows the trigger, duration, failure reason and forge link", async () => {
    const failed = {
      ...listItem,
      status: "failed",
      verdict: null,
      trigger: "webhook",
      error: "The model timed out",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:01:10Z",
      summary: { ...listItem.summary!, webUrl: "https://github.com/acme/web/pull/42" },
    }
    mockApi({ "GET /api/reviews?view=changes&page=1&limit=10": firstPage([failed]) })
    renderWithProviders(<App />, { route: "/reviews" })

    const row = (await screen.findByRole("link", { name: "Add b and c" })).closest("tr")!
    expect(within(row).getByLabelText("Started by a push or a new pull request")).toBeInTheDocument()
    expect(within(row).getByText("took 1m 10s")).toBeInTheDocument()
    expect(within(row).getByText("The model timed out")).toBeInTheDocument()
    expect(within(row).getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/web/pull/42",
    )
  })

  it("re-runs a review from the row menu", async () => {
    const rerun = vi.fn(() => jsonResponse(202, { review: { ...listItem, id: "new", status: "queued" } }))
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": firstPage([listItem]),
      [`POST /api/reviews/${listItem.id}/rerun`]: rerun,
    })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Add b and c" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Re-run" }))

    const dialog = await screen.findByRole("dialog", { name: "Re-run review of Add b and c?" })
    expect(rerun).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-run review" }))

    expect(await screen.findByText("Review queued")).toBeInTheDocument()
    expect(rerun).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("copies the markdown from the row menu", async () => {
    const markdown = "# Sentryward review\n"
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": firstPage([listItem]),
      [`GET /api/reviews/${listItem.id}/markdown`]: () => new Response(markdown, { status: 200 }),
    })
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
    renderWithProviders(<App />, { route: "/reviews" })

    await user.click(await screen.findByRole("button", { name: "Actions for Add b and c" }))
    await user.click(await screen.findByRole("menuitem", { name: "Copy markdown" }))

    expect(await screen.findByText("Markdown copied")).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(markdown)
  })

  it("does not re-run when the confirmation is cancelled", async () => {
    const rerun = vi.fn(() => jsonResponse(202, { review: { ...listItem, id: "new", status: "queued" } }))
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": firstPage([listItem]),
      [`POST /api/reviews/${listItem.id}/rerun`]: rerun,
    })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Add b and c" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Re-run" }))
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(rerun).not.toHaveBeenCalled()
  })

  it("cancels a running review from the row menu after confirming", async () => {
    const running = { ...listItem, status: "running" as const, verdict: null }
    const cancel = vi.fn(() => jsonResponse(200, { review: { ...running, status: "cancelled" } }))
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": firstPage([running]),
      [`POST /api/reviews/${listItem.id}/cancel`]: cancel,
    })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Add b and c" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Cancel review" }))

    const dialog = await screen.findByRole("dialog", { name: "Cancel review of Add b and c?" })
    expect(cancel).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel review" }))

    expect(await screen.findByText("Review cancelled")).toBeInTheDocument()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("offers no cancel for a review that has finished", async () => {
    mockApi({ "GET /api/reviews?view=changes&page=1&limit=10": firstPage([listItem]) })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Add b and c" }))

    expect(await screen.findByRole("menuitem", { name: "Re-run" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Cancel review" })).not.toBeInTheDocument()
  })

  it("filters on the server and starts over at page 1", async () => {
    mockApi({
      "GET /api/reviews?view=changes&page=2&limit=10": firstPage([listItem], 12),
      "GET /api/reviews?status=failed&view=changes&page=1&limit=10": firstPage([]),
    })
    renderWithProviders(<App />, { route: "/reviews?page=2" })

    await userEvent.click(await screen.findByRole("button", { name: "Filters" }))
    await userEvent.click(screen.getByLabelText("Status"))
    await userEvent.click(await screen.findByRole("option", { name: "Failed" }))

    expect(await screen.findByText("No reviews match your filters.")).toBeInTheDocument()
    expect(screen.getByText("Status:")).toBeInTheDocument()
  })

  it("searches after typing stops", async () => {
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": firstPage([listItem]),
      "GET /api/reviews?q=%2342&view=changes&page=1&limit=10": firstPage([{ ...listItem, id: "found", title: "Found it" }]),
    })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.type(await screen.findByLabelText("Search reviews"), "#42")

    expect(await screen.findByRole("link", { name: "Found it" })).toBeInTheDocument()
  })

  it("reads filters, search and view from the URL, ignoring values it does not know", async () => {
    mockApi({
      "GET /api/reviews?status=failed&q=fix&view=runs&includeSuperseded=true&page=1&limit=10": firstPage([listItem]),
    })
    renderWithProviders(<App />, { route: "/reviews?status=failed&verdict=bogus&view=runs&superseded=true&q=fix" })

    expect(await screen.findByRole("link", { name: "Add b and c" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "All runs", selected: true })).toBeInTheDocument()
    expect(screen.getByLabelText("Search reviews")).toHaveValue("fix")
    expect(screen.getByText("Status:")).toBeInTheDocument()
    expect(screen.queryByText("Verdict:")).not.toBeInTheDocument()
  })

  it("goes back from a review to the list as it was filtered", async () => {
    mockApi({
      "GET /api/reviews?status=failed&view=changes&page=1&limit=10": firstPage([listItem]),
      [`GET /api/reviews/${listItem.id}`]: { review: detail },
    })
    renderWithProviders(<App />, { route: "/reviews?status=failed" })

    await userEvent.click(await screen.findByRole("link", { name: "Add b and c" }))
    const back = await screen.findByRole("link", { name: "Back to reviews" })
    expect(back).toHaveAttribute("href", "/reviews?status=failed")

    await userEvent.click(back)
    expect(await screen.findByRole("link", { name: "Add b and c" })).toBeInTheDocument()
    expect(screen.getByText("Status:")).toBeInTheDocument()
  })

  it("keeps the filtered list to go back to after a re-run from the review", async () => {
    const failed = { ...detail, status: "failed", verdict: "error", result: null, error: "Model call timed out" }
    mockApi({
      "GET /api/reviews?status=failed&view=changes&page=1&limit=10": firstPage([listItem]),
      [`GET /api/reviews/${listItem.id}`]: { review: failed },
      [`POST /api/reviews/${listItem.id}/rerun`]: () =>
        jsonResponse(202, { review: { ...listItem, id: "new", status: "queued" } }),
      "GET /api/reviews/new": { review: { ...detail, id: "new", status: "queued", verdict: null, result: null } },
    })
    renderWithProviders(<App />, { route: "/reviews?status=failed" })

    await userEvent.click(await screen.findByRole("link", { name: "Add b and c" }))
    await userEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Re-run" }))

    expect(await screen.findByText("Waiting for a worker...")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Back to reviews" })).toHaveAttribute("href", "/reviews?status=failed")
  })

  it("expands a change to show its earlier runs", async () => {
    const earlier = { ...listItem, id: "earlier", headSha: "0123456789", status: "superseded", verdict: null }
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": firstPage([{ ...listItem, runCount: 2 }]),
      "GET /api/reviews?repoId=r1&number=42&view=runs&includeSuperseded=true&limit=20": firstPage([listItem, earlier]),
    })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.click(await screen.findByRole("button", { name: "2 runs" }))

    const history = await screen.findByRole("list", { name: "Earlier runs of Add b and c" })
    expect(within(history).getByText("0123456")).toBeInTheDocument()
    expect(within(history).getByText("Superseded")).toBeInTheDocument()
    expect(within(history).queryByText("abcdef1")).not.toBeInTheDocument()
  })

  it("switches to every run", async () => {
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": firstPage([listItem]),
      "GET /api/reviews?view=runs&page=1&limit=10": firstPage([{ ...listItem, id: "run", title: "A run" }]),
    })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.click(await screen.findByRole("tab", { name: "All runs" }))

    expect(await screen.findByRole("link", { name: "A run" })).toBeInTheDocument()
  })

  it("summarises the last days above the table", async () => {
    mockApi({
      "GET /api/reviews?view=changes&page=1&limit=10": firstPage([listItem]),
      "GET /api/reviews/stats": {
        days: 7,
        runs: 9,
        blocked: 2,
        passed: 6,
        failed: 1,
        duration: { median: 102_000, max: 245_000 },
        tokens: { calls: 18, inputTokens: 52_000, outputTokens: 9_400 },
        cost: { usd: 0.342 },
      },
    })
    renderWithProviders(<App />, { route: "/reviews" })

    const stats = await screen.findByRole("region", { name: "Review stats" })
    expect(within(stats).getByText("Reviews, last 7 days")).toBeInTheDocument()
    expect(within(stats).getByText("9")).toBeInTheDocument()
    expect(within(stats).getByText("25%")).toBeInTheDocument()
    expect(within(stats).getByText("2 of 8")).toBeInTheDocument()
    expect(within(stats).getByText("Median review time")).toBeInTheDocument()
    expect(within(stats).getByText("1m 42s")).toBeInTheDocument()
    expect(within(stats).getByText("slowest 4m 05s")).toBeInTheDocument()
    expect(within(stats).getByText("61.4K")).toBeInTheDocument()
    expect(within(stats).getByText("~$0.34 est.")).toBeInTheDocument()
    // The tile opens the Usage page on the window it sums.
    expect(within(stats).getByRole("link", { name: "Tokens, last 7 days: open usage" })).toHaveAttribute(
      "href",
      "/usage?period=7d",
    )
  })
})

describe("Review detail page", () => {
  it("shows the run's recorded cost, or a dash for a run from before costs were recorded", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: detail } })
    const { unmount } = renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const usage = await screen.findByText("Estimated cost")
    expect(usage.nextElementSibling).toHaveTextContent("<$0.01 est.")
    unmount()

    const { costUsd: _, ...older } = detail.result!.usageTotals
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: { ...detail, result: { ...detail.result!, usageTotals: older } } } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    expect((await screen.findByText("Estimated cost")).nextElementSibling).toHaveTextContent("-")
    expect(screen.getByTitle("Not recorded for this run")).toBeInTheDocument()
  })

  it("groups findings by bucket and shows walkthrough, notes and coverage", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: detail } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const actionable = await screen.findByRole("region", { name: "Actionable comments" })
    expect(within(actionable).getByText("SQL injection in search")).toBeInTheDocument()
    expect(within(actionable).getByText("db.query(sql, [q])")).toBeInTheDocument()
    expect(within(screen.getByRole("region", { name: "Nitpick comments" })).getByText("Rename c")).toBeInTheDocument()
    expect(
      within(screen.getByRole("region", { name: "Outside diff range comments" })).getByText("Caller ignores result"),
    ).toBeInTheDocument()

    expect(screen.getByText("Adds b and c.")).toBeInTheDocument()
    expect(screen.getByText(/unknown setting nope/)).toBeInTheDocument()
    expect(screen.getByText(/ignored by configuration/)).toBeInTheDocument()
    expect(within(actionable).getByRole("link", { name: /src\/app\.ts:11/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/web/blob/abcdef1234/src/app.ts#L11",
    )
  })

  it("labels confidence as self-reported and shows verification, impact and fix rationale", async () => {
    const [first, ...rest] = detail.result!.findings
    const findings = [
      {
        ...first!,
        impact: "Any visitor can read every row.",
        fixRationale: "A bound parameter cannot change the query.",
        verification: "verified" as const,
      },
      ...rest,
    ]
    const review = { ...detail, result: { ...detail.result!, findings } }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const actionable = await screen.findByRole("region", { name: "Actionable comments" })
    expect(within(actionable).getByText(/Self-reported confidence 90%/)).toBeInTheDocument()
    expect(within(actionable).queryByText(/^Confidence/)).toBeNull()
    expect(within(actionable).getByText("Verified")).toBeInTheDocument()
    expect(within(actionable).getByText("Any visitor can read every row.")).toBeInTheDocument()
    expect(within(actionable).getByText("A bound parameter cannot change the query.")).toBeInTheDocument()
  })

  it("names the rule of a rule finding, with no confidence for a pattern match", async () => {
    const [first, ...rest] = detail.result!.findings
    const findings = [{ ...first!, source: "rule" as const, ruleId: "no-db-in-controllers", model: undefined }, ...rest]
    const review = { ...detail, result: { ...detail.result!, findings } }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const actionable = await screen.findByRole("region", { name: "Actionable comments" })
    expect(within(actionable).getByText("Rule no-db-in-controllers")).toBeInTheDocument()
    expect(within(actionable).queryByText(/Self-reported confidence/)).toBeNull()
  })

  it("collapses a long walkthrough file list until expanded", async () => {
    const fileSummaries = Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.ts`, summary: `Changes f${i}` }))
    const walkthrough = { ...detail.result!.walkthrough!, fileSummaries }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: { ...detail, result: { ...detail.result!, walkthrough } } } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const trigger = await screen.findByRole("button", { name: /Changed files\s*\(6\)/ })
    expect(screen.getByRole("img", { name: "Review effort 2 of 5" })).toBeInTheDocument()
    expect(screen.queryByText("Changes f0")).not.toBeInTheDocument()
    await userEvent.click(trigger)
    expect(screen.getByText("Changes f0")).toBeInTheDocument()
  })

  it("lists the risky areas a change touches or reaches", async () => {
    const riskyAreas = [
      { kind: "auth" as const, path: "src/middleware/auth.ts", reason: "removes an authorization check", removesCheck: true },
      { kind: "api" as const, path: "src/routes/users.ts", reason: "calls run, 2 hops from the change", via: "main -> run" },
    ]
    const walkthrough = { ...detail.result!.walkthrough!, riskyAreas }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: { ...detail, result: { ...detail.result!, walkthrough } } } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const section = await screen.findByRole("region", { name: "Risky areas" })
    expect(within(section).getByText("Authorization")).toBeInTheDocument()
    expect(within(section).getByText("removes an authorization check")).toBeInTheDocument()
    expect(within(section).getByText("src/routes/users.ts")).toBeInTheDocument()
    expect(within(section).getByText("(main -> run)")).toBeInTheDocument()
  })

  it("says what was posted to the forge", async () => {
    const publication = {
      inlinePosted: [{ fingerprint: "a", forgeCommentId: "1" }, { fingerprint: "b", forgeCommentId: "2" }],
      inlineSkipped: 1,
      inlineFailed: [],
      summaryCommentId: "9",
      statusState: "failure",
      errors: [],
    }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: { ...detail, publication } } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    expect(
      await screen.findByText("Posted to GitHub: 2 inline comments, 1 already posted, summary, commit status (failure)"),
    ).toBeInTheDocument()
  })

  it("lists failed inline comments and usage in the sidebar", async () => {
    const publication = {
      inlinePosted: [],
      inlineSkipped: 0,
      inlineFailed: [{ fingerprint: "a", error: "line outside diff" }],
      summaryCommentId: null,
      statusState: null,
      errors: ["Commit status: 403"],
    }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: { ...detail, publication } } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const sidebar = await screen.findByRole("complementary", { name: "Review details" })
    expect(within(sidebar).getByText("1 inline comment failed to post")).toBeInTheDocument()
    expect(within(sidebar).getByText("Commit status: 403")).toBeInTheDocument()
    expect(within(sidebar).getByText("1,200")).toBeInTheDocument()
    expect(within(sidebar).getByText("abcdef1")).toBeInTheDocument()
  })

  it("counts filtered and demoted findings in the sidebar", async () => {
    const validation = { dropped: { duplicate: 1, low_confidence: 2, off_diff: 0 }, demoted: 1 }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: { ...detail, result: { ...detail.result!, validation } } } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const sidebar = await screen.findByRole("complementary", { name: "Review details" })
    expect(within(sidebar).getByText("Validation")).toBeInTheDocument()
    expect(within(sidebar).getByText("Left out of the review")).toBeInTheDocument()
    expect(within(sidebar).getByText("Low confidence").closest("div")).toHaveTextContent(/^Low confidence\s*2$/)
    expect(within(sidebar).getByText("Duplicate").closest("div")).toHaveTextContent(/^Duplicate\s*1$/)
    expect(within(sidebar).queryByText("Outside changed lines")).not.toBeInTheDocument()
    expect(
      within(sidebar).getByText("1 finding downgraded because evidence was missing or unverified"),
    ).toBeInTheDocument()
    expect(within(sidebar).getByText("A downgraded finding can also be counted above.")).toBeInTheDocument()
  })

  it("shows only the downgrade line when nothing was dropped", async () => {
    const validation = { dropped: { low_confidence: 0 }, demoted: 2 }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: { ...detail, result: { ...detail.result!, validation } } } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const sidebar = await screen.findByRole("complementary", { name: "Review details" })
    expect(
      within(sidebar).getByText("2 findings downgraded because evidence was missing or unverified"),
    ).toBeInTheDocument()
    expect(within(sidebar).queryByText("Left out of the review")).not.toBeInTheDocument()
    expect(within(sidebar).queryByText(/can also be counted above/)).not.toBeInTheDocument()
  })

  it("hides the validation summary when nothing was filtered or demoted", async () => {
    const validation = { dropped: { low_confidence: 0 }, demoted: 0 }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: { ...detail, result: { ...detail.result!, validation } } } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const sidebar = await screen.findByRole("complementary", { name: "Review details" })
    expect(within(sidebar).getByText("Coverage")).toBeInTheDocument()
    expect(within(sidebar).queryByText("Validation")).not.toBeInTheDocument()
  })

  it("names an unfamiliar drop reason readably", async () => {
    const validation = { dropped: { some_new_reason: 3 }, demoted: 0 }
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: { ...detail, result: { ...detail.result!, validation } } } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const sidebar = await screen.findByRole("complementary", { name: "Review details" })
    expect(within(sidebar).getByText("Some new reason").closest("div")).toHaveTextContent(/^Some new reason\s*3$/)
    expect(within(sidebar).queryByText(/downgraded/)).not.toBeInTheDocument()
  })

  it("starts nitpicks collapsed and expands them on demand", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: detail } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const nitpicks = await screen.findByRole("region", { name: "Nitpick comments" })
    const trigger = within(nitpicks).getByRole("button", { name: /Rename c/ })
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    await userEvent.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")

    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }))
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(
      within(screen.getByRole("region", { name: "Actionable comments" })).getByRole("button", { name: /SQL injection/ }),
    ).toHaveAttribute("aria-expanded", "false")
  })

  it("filters findings by severity and clears the filter", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: detail } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const toolbar = await screen.findByRole("toolbar", { name: "Filter findings" })
    await userEvent.click(within(toolbar).getByRole("button", { name: /critical/ }))

    expect(within(toolbar).getByRole("button", { name: /critical/ })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText("SQL injection in search")).toBeInTheDocument()
    expect(screen.queryByText("Rename c")).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Outside diff range comments" })).not.toBeInTheDocument()

    await userEvent.click(within(toolbar).getByRole("button", { name: "Clear filters" }))
    expect(screen.getByText("Rename c")).toBeInTheDocument()
  })

  it("reads severity filters from the URL", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: detail } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}?severity=minor` })

    expect(await screen.findByText("Rename c")).toBeInTheDocument()
    expect(screen.queryByText("SQL injection in search")).not.toBeInTheDocument()
  })

  const FILE_BY_TITLE: Record<string, string> = {
    "SQL injection in search": "src/auth/Login.ts",
    "Rename c": "src/app.ts",
    "Caller ignores result": "src/auth/session.ts",
  }
  const spreadAcrossFiles = {
    ...detail,
    result: {
      ...detail.result!,
      findings: detail.result!.findings.map((f) => ({ ...f, file: FILE_BY_TITLE[f.title] })),
    },
  }

  it("filters findings by a case-insensitive file path substring", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: spreadAcrossFiles } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    await userEvent.type(await screen.findByRole("searchbox", { name: "Filter by file path" }), "  AUTH/ ")

    expect(screen.getByText("SQL injection in search")).toBeInTheDocument()
    expect(screen.getByText("Caller ignores result")).toBeInTheDocument()
    expect(screen.queryByText("Rename c")).not.toBeInTheDocument()
  })

  it("combines the file path filter with severity", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: spreadAcrossFiles } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}?file=auth&severity=critical` })

    expect(await screen.findByText("SQL injection in search")).toBeInTheDocument()
    expect(screen.queryByText("Caller ignores result")).not.toBeInTheDocument()
    expect(screen.queryByText("Rename c")).not.toBeInTheDocument()
  })

  it("reads the file path filter from the URL", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: spreadAcrossFiles } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}?file=app.ts` })

    expect(await screen.findByText("Rename c")).toBeInTheDocument()
    expect(screen.getByRole("searchbox", { name: "Filter by file path" })).toHaveValue("app.ts")
    expect(screen.queryByText("SQL injection in search")).not.toBeInTheDocument()
  })

  it("shows the filtered empty state when no path matches and clears the query", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: spreadAcrossFiles } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const search = await screen.findByRole("searchbox", { name: "Filter by file path" })
    await userEvent.type(search, "nope")
    expect(screen.getByText("No findings match these filters.")).toBeInTheDocument()

    const toolbar = screen.getByRole("toolbar", { name: "Filter findings" })
    await userEvent.click(within(toolbar).getByRole("button", { name: "Clear filters" }))
    expect(search).toHaveValue("")
    expect(screen.getByText("SQL injection in search")).toBeInTheDocument()
    expect(screen.getByText("Rename c")).toBeInTheDocument()
    expect(screen.getByText("Caller ignores result")).toBeInTheDocument()
  })

  it("copies an agent prompt for one finding", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: detail } })
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const actionable = await screen.findByRole("region", { name: "Actionable comments" })
    await user.click(within(actionable).getByRole("button", { name: "Copy agent prompt" }))

    expect(writeText).toHaveBeenCalledWith(
      expect.stringMatching(/^In src\/app\.ts around line 11: SQL injection in search\n\nWhy it matters\./),
    )
    expect(writeText.mock.calls[0][0]).toContain("Suggested replacement for those lines:\n\ndb.query(sql, [q])")
  })

  it("keeps markdown copying pending until the clipboard write finishes", async () => {
    const markdown = "# Sentryward review\n"
    let resolveMarkdown!: (value: string) => void
    const response = new Response()
    vi.spyOn(response, "text").mockReturnValue(new Promise((resolve) => {
      resolveMarkdown = resolve
    }))
    const fetchMarkdown = vi.fn(() => response)
    mockApi({
      [`GET /api/reviews/${detail.id}`]: { review: detail },
      [`GET /api/reviews/${detail.id}/markdown`]: fetchMarkdown,
    })
    const user = userEvent.setup()
    let finishCopy!: () => void
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(
      new Promise((resolve) => {
        finishCopy = resolve
      }),
    )
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const button = await screen.findByRole("button", { name: "Copy markdown" })
    await user.click(button)

    expect(button).toBeDisabled()
    expect(button.querySelector(".animate-spin")).toBeInTheDocument()
    await user.click(button)
    expect(fetchMarkdown).toHaveBeenCalledOnce()
    expect(writeText).not.toHaveBeenCalled()

    resolveMarkdown(markdown)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown))
    expect(button).toBeDisabled()

    finishCopy()
    expect(await screen.findByText("Markdown copied")).toBeInTheDocument()
    expect(button).toBeEnabled()
    expect(button.querySelector(".animate-spin")).not.toBeInTheDocument()
  })

  it.each(["Copy", "Download"])("keeps %s markdown pending and recovers from a failed request", async (action) => {
    const showError = vi.spyOn(toast, "error").mockReturnValue("markdown-error")
    let rejectMarkdown!: (error: Error) => void
    const response = new Response()
    vi.spyOn(response, "text").mockReturnValue(new Promise((_, reject) => {
      rejectMarkdown = reject
    }))
    const fetchMarkdown = vi.fn(() => response)
    mockApi({
      [`GET /api/reviews/${detail.id}`]: { review: detail },
      [`GET /api/reviews/${detail.id}/markdown`]: fetchMarkdown,
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const button = await screen.findByRole("button", { name: `${action} markdown` })
    await userEvent.click(button)

    expect(button).toBeDisabled()
    expect(button.querySelector(".animate-spin")).toBeInTheDocument()
    await userEvent.click(button)
    expect(fetchMarkdown).toHaveBeenCalledOnce()

    rejectMarkdown(new Error("Connection lost"))
    await waitFor(() => expect(showError).toHaveBeenCalledWith(`Could not ${action.toLowerCase()} the markdown`))
    expect(button).toBeEnabled()
    expect(button.querySelector(".animate-spin")).not.toBeInTheDocument()
  })

  // Keep downloads from creating real object URLs or navigating on the anchor click.
  function stubDownload() {
    const blobs: Blob[] = []
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return "blob:review"
    })
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    return { blobs, click }
  }

  it("downloads the review markdown as a file", async () => {
    const markdown = "# Sentryward review\n\n- SQL injection in search\n"
    mockApi({
      [`GET /api/reviews/${detail.id}`]: { review: detail },
      [`GET /api/reviews/${detail.id}/markdown`]: () => new Response(markdown, { status: 200 }),
    })
    const { blobs, click } = stubDownload()
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    await userEvent.click(await screen.findByRole("button", { name: "Download markdown" }))

    await waitFor(() => expect(click).toHaveBeenCalledOnce())
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(`sentryward-review-${detail.id}.md`)
    expect(await blobs[0].text()).toBe(markdown)
    await waitFor(() => expect(screen.getByRole("button", { name: "Download markdown" })).toBeEnabled())
  })

  it("offers no markdown download without a result", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: { review: { ...detail, status: "failed", verdict: "error", result: null } },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    expect(await screen.findByRole("button", { name: "Download markdown" })).toBeDisabled()
  })

  it("says when the full result has expired under retention", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: { ...detail, result: null, publication: null, resultExpiredAt: "2026-01-01T00:00:00.000Z" },
      },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    expect(await screen.findByText("The full result has expired")).toBeInTheDocument()
    expect(screen.queryByText("The review did not run")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy markdown" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Download markdown" })).toBeDisabled()
  })

  it("keeps the error of an expired failed review", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: {
          ...detail,
          status: "failed",
          verdict: "error",
          error: "Model call timed out",
          result: null,
          publication: null,
          resultExpiredAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    expect(await screen.findByText("The full result has expired")).toBeInTheDocument()
    expect(screen.getByText("Model call timed out")).toBeInTheDocument()
    expect(screen.queryByText(/Findings page/)).not.toBeInTheDocument()
  })

  it("reports a failed markdown download without saving a file", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: { review: detail },
      [`GET /api/reviews/${detail.id}/markdown`]: () => jsonResponse(500, { message: "boom" }),
    })
    const { click } = stubDownload()
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    await userEvent.click(await screen.findByRole("button", { name: "Download markdown" }))

    expect(await screen.findByText("Could not download the markdown")).toBeInTheDocument()
    expect(click).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Download markdown" })).toBeEnabled()
  })

  it.each([
    ["completed", "No findings. Nothing in this change needs attention."],
    ["partial", "No findings were reported; review coverage was incomplete."],
    ["failed", "No findings were reported; review coverage was incomplete."],
  ] as const)("words the empty findings state for a %s result", async (status, message) => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: { review: { ...detail, result: { ...detail.result!, status, findings: [] } } },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    expect(await screen.findByRole("region", { name: "Findings" })).toHaveTextContent(message)
    if (status !== "completed") {
      expect(screen.queryByText(/Nothing in this change needs attention/)).not.toBeInTheDocument()
    }
  })

  it("explains a review that failed before producing a result", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: { ...detail, status: "failed", verdict: "error", result: null, error: "No API key for anthropic" },
      },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    expect(await screen.findByText("The review did not run")).toBeInTheDocument()
    expect(screen.getByText("No API key for anthropic")).toBeInTheDocument()
  })

  it("offers a re-run and the page that fixes a failure", async () => {
    const rerun = vi.fn(() => jsonResponse(202, { review: { ...listItem, id: "new", status: "queued" } }))
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: {
          ...detail,
          status: "failed",
          verdict: "error",
          result: null,
          error: "No API key for anthropic",
          errorKind: "llm_connection",
        },
      },
      [`POST /api/reviews/${detail.id}/rerun`]: rerun,
      "GET /api/reviews/new": { review: { ...detail, id: "new", status: "queued", verdict: null, result: null } },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByRole("link", { name: "Check LLM connections" })).toHaveAttribute("href", "/llm-connections")

    await userEvent.click(within(alert).getByRole("button", { name: "Re-run" }))
    await waitFor(() => expect(rerun).toHaveBeenCalledOnce())
    expect(await screen.findByText("Waiting for a worker...")).toBeInTheDocument()
  })

  it("links a skipped run to the repository's trigger settings", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: {
          ...detail,
          status: "skipped",
          verdict: null,
          result: null,
          error: "Draft changes are not reviewed automatically",
          errorKind: "trigger",
          resolvedConfig: { sources: { "triggers.review": "global" }, repoFile: null },
        },
      },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText(/A trigger setting kept this run from starting/)).toBeInTheDocument()
    expect(within(alert).getByRole("link", { name: "Change trigger settings" })).toHaveAttribute(
      "href",
      `/configuration?repo=${detail.repository.id}&tab=triggers`,
    )
    expect(within(alert).getByRole("button", { name: "Re-run" })).toBeInTheDocument()
  })

  it("says when the repository file set the trigger that skipped a run", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: {
          ...detail,
          status: "skipped",
          verdict: null,
          result: null,
          error: "Draft changes are not reviewed automatically",
          errorKind: "trigger",
          resolvedConfig: { sources: { "triggers.review": "repoFile" }, repoFile: ".sentryward.yaml" },
        },
      },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    expect(await screen.findByText(/\.sentryward\.yaml sets some of its trigger settings/)).toBeInTheDocument()
  })

  it("offers no re-run while the repository's reviews are turned off", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: {
          ...detail,
          status: "skipped",
          verdict: null,
          result: null,
          error: "Reviews were turned off for this repository",
          errorKind: "repo_disabled",
          repository: { ...detail.repository, enabled: false },
        },
      },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByRole("link", { name: "Turn reviews back on" })).toHaveAttribute("href", "/repositories")
    expect(within(alert).queryByRole("button", { name: "Re-run" })).not.toBeInTheDocument()
  })

  it("offers no re-run after losing access, which turns the repository off", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: {
          ...detail,
          status: "skipped",
          verdict: null,
          result: null,
          error: "Sentryward lost access to this repository",
          errorKind: "forge_access",
          repository: { ...detail.repository, enabled: false },
        },
      },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByRole("link", { name: "Check the installation" })).toBeInTheDocument()
    expect(within(alert).queryByRole("button", { name: "Re-run" })).not.toBeInTheDocument()
  })

  it("offers a re-run once the repository's reviews are back on", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: {
          ...detail,
          status: "skipped",
          verdict: null,
          result: null,
          error: "Reviews were turned off for this repository",
          errorKind: "repo_disabled",
        },
      },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByRole("button", { name: "Re-run" })).toBeInTheDocument()
    expect(within(alert).queryByRole("link", { name: "Turn reviews back on" })).not.toBeInTheDocument()
  })

  it("links back to every review when one is not found", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: () => jsonResponse(404, { message: "Review not found" }) })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText("Review not found.")).toBeInTheDocument()
    expect(within(alert).getByRole("link", { name: "View all reviews" })).toHaveAttribute("href", "/reviews")
  })

  it("cancels a queued review from the header", async () => {
    const cancel = vi.fn(() => jsonResponse(200, { review: { ...detail, status: "cancelled" } }))
    mockApi({
      [`GET /api/reviews/${detail.id}`]: { review: { ...detail, status: "queued", verdict: null, result: null } },
      [`POST /api/reviews/${detail.id}/cancel`]: cancel,
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }))
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel review" }))

    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })

  it("has no cancel button once a review has finished", async () => {
    mockApi({ [`GET /api/reviews/${detail.id}`]: { review: detail } })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    expect(await screen.findByRole("button", { name: "Re-run" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("says why a review was cancelled", async () => {
    mockApi({
      [`GET /api/reviews/${detail.id}`]: {
        review: { ...detail, status: "cancelled", verdict: null, result: null, error: "Cancelled by Dev" },
      },
    })
    renderWithProviders(<App />, { route: `/reviews/${detail.id}` })

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText("Cancelled")).toBeInTheDocument()
    expect(within(alert).getByText("Cancelled by Dev")).toBeInTheDocument()
  })
})
