import { describe, expect, it, vi } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi, personalWorkspace, testUser, testWorkspaces } from "@/test/apiRoutes"
import { setViewportWidth } from "@/test/viewport"

const settings = { autoPauseAfter: 5 }

const webhook = {
  id: "n1",
  kind: "webhook",
  name: "CI alerts",
  events: ["failed", "blocked"],
  host: "ci.example.com",
  undecryptable: false,
  recipientIds: [],
  active: true,
  pausedReason: null,
  pauseCause: null,
  consecutiveFailures: 0,
  lastDelivery: null,
  pending: { count: 0, retry: null },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}

const emailTarget = {
  ...webhook,
  id: "n2",
  kind: "email",
  name: "Leads",
  events: ["completed"],
  host: null,
  recipientIds: [testUser.id, "gone"],
}

const members = {
  members: [{ id: testUser.id, name: testUser.name, email: testUser.email, role: "owner", joinedAt: "" }],
}
const MEMBERS_ROUTE = `GET /api/workspaces/${personalWorkspace.id}/members`

const slackTarget = {
  ...webhook,
  id: "n3",
  kind: "slack",
  name: "Team channel",
  events: ["blocked"],
  host: "hooks.slack.com",
}

async function chooseFilter(label: string, option: string) {
  await userEvent.click(screen.getByRole("button", { name: "Filters" }))
  await userEvent.click(await screen.findByRole("combobox", { name: label }))
  await userEvent.click(screen.getByRole("option", { name: option }))
  await userEvent.keyboard("{Escape}")
}

function rowNames() {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]!.textContent)
}

function calls(fetchSpy: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchSpy.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? "GET") === method)
}

describe("Notifications", () => {
  it("lists targets with their destination and events", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook, emailTarget], mailConfigured: true, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const ci = (await screen.findByRole("cell", { name: "CI alerts" })).closest("tr")!
    expect(within(ci).getByText("ci.example.com")).toBeInTheDocument()
    expect(within(ci).getByText("Failed")).toBeInTheDocument()
    expect(within(ci).getByText("Blocked")).toBeInTheDocument()
    const leads = screen.getByRole("cell", { name: "Leads" }).closest("tr")!
    // A recipient who left the workspace is not emailed, so is not listed.
    expect(await within(leads).findByText(testUser.name)).toBeInTheDocument()
    expect(within(leads).getByText("Completed")).toBeInTheDocument()
  })

  it("adds a webhook and shows its signing secret once", async () => {
    let created = false
    const fetchSpy = mockApi({
      // The refetch after adding returns the new target, which swaps the empty state for the table.
      "GET /api/notifications": () => jsonResponse(200, { targets: created ? [webhook] : [], mailConfigured: false, settings }),
      "POST /api/notifications": () => {
        created = true
        return jsonResponse(201, { target: webhook, secret: "abc123" })
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    expect(await screen.findByText("No notification targets")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Add target" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI alerts")
    await userEvent.type(within(dialog).getByLabelText("URL"), "https://ci.example.com/hook")
    await userEvent.click(within(dialog).getByRole("button", { name: "Add target" }))

    expect(await within(dialog).findByLabelText("Signing secret")).toHaveValue("abc123")
    // The secret stays on screen once the table replaces the empty state (the
    // modal hides the page behind it from role queries).
    expect(await screen.findByRole("cell", { name: "CI alerts", hidden: true })).toBeInTheDocument()
    expect(within(dialog).getByLabelText("Signing secret")).toHaveValue("abc123")
    const [, init] = calls(fetchSpy, "POST", "/api/notifications")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "webhook",
      name: "CI alerts",
      events: ["blocked", "failed"],
      url: "https://ci.example.com/hook",
    })
  })

  it("needs a URL and at least one event", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [], mailConfigured: false, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Add target" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI")
    await userEvent.click(within(dialog).getByLabelText("Blocked"))
    await userEvent.click(within(dialog).getByLabelText("Failed"))
    await userEvent.click(within(dialog).getByRole("button", { name: "Add target" }))

    expect(await within(dialog).findByText("Enter an http or https URL")).toBeInTheDocument()
    expect(within(dialog).getByText("Choose at least one event")).toBeInTheDocument()
    expect(calls(fetchSpy, "POST", "/api/notifications")).toHaveLength(0)
  })

  it("sends a test and reports a failed delivery", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false, settings },
      "POST /api/notifications/n1/test": { result: { ok: false, error: "Responded with 404" } },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Send test" }))

    expect(await screen.findByText("Test to CI alerts failed: Responded with 404")).toBeInTheDocument()
  })

  it("searches targets by name, host and recipient", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook, emailTarget, slackTarget], mailConfigured: true, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const search = await screen.findByRole("searchbox", { name: "Search notification targets" })
    await userEvent.type(search, "slack.com")
    expect(rowNames()).toEqual(["Team channel"])

    await userEvent.clear(search)
    await userEvent.type(search, testUser.name)
    expect(rowNames()).toEqual(["Leads"])

    await userEvent.clear(search)
    await userEvent.type(search, "nothing like this")
    expect(screen.getByText("No notification targets match your filters.")).toBeInTheDocument()
  })

  it("filters by type and event, with a chip to remove the filter", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook, emailTarget, slackTarget], mailConfigured: true, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await screen.findByRole("cell", { name: "CI alerts" })
    await chooseFilter("Type", "Slack")
    expect(rowNames()).toEqual(["Team channel"])

    await userEvent.click(screen.getByRole("button", { name: "Remove Type filter" }))
    expect(rowNames()).toHaveLength(3)

    await chooseFilter("Event", "Blocked")
    expect(rowNames()).toEqual(["CI alerts", "Team channel"])
  })

  it("pages through many targets", async () => {
    const targets = Array.from({ length: 12 }, (_, i) => ({
      ...webhook,
      id: `p${i}`,
      name: `Target ${String(i + 1).padStart(2, "0")}`,
    }))
    mockApi({
      "GET /api/notifications": { targets, mailConfigured: false, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    expect(await screen.findByText("Showing 1-10 of 12")).toBeInTheDocument()
    expect(rowNames()).toHaveLength(10)
    await userEvent.click(screen.getByRole("button", { name: "Next page" }))
    expect(await screen.findByText("Showing 11-12 of 12")).toBeInTheDocument()
    expect(rowNames()).toEqual(["Target 11", "Target 12"])
  })

  it("pauses a target from the list without opening the edit dialog", async () => {
    let active = true
    const fetchSpy = mockApi({
      "GET /api/notifications": () => jsonResponse(200, { targets: [{ ...webhook, active }], mailConfigured: false, settings }),
      "PATCH /api/notifications/n1": (init?: RequestInit) => {
        active = JSON.parse(String(init?.body)).active
        return jsonResponse(200, { target: { ...webhook, active } })
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const toggle = await screen.findByRole("switch", { name: "Active: CI alerts" })
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)

    expect(await screen.findByText("Paused CI alerts")).toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    const [[, init]] = calls(fetchSpy, "PATCH", "/api/notifications/n1")
    expect(JSON.parse(String(init?.body))).toEqual({ active: false })
    expect(screen.getByRole("switch", { name: "Active: CI alerts" })).not.toBeChecked()
  })

  it("moves the switch as soon as it is clicked, and back if saving fails", async () => {
    let fail!: () => void
    mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false, settings },
      // Held open, so the switch is checked while the request is in flight.
      "PATCH /api/notifications/n1": (() =>
        new Promise<Response>((resolve) => {
          fail = () => resolve(jsonResponse(500, { message: "Could not save" }))
        })) as unknown as () => Response,
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const toggle = await screen.findByRole("switch", { name: "Active: CI alerts" })
    await userEvent.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeDisabled()

    fail()
    expect(await screen.findByText("Could not save")).toBeInTheDocument()
    expect(toggle).toBeChecked()
  })

  it("sorts and filters targets by whether they are active", async () => {
    mockApi({
      "GET /api/notifications": {
        targets: [webhook, { ...emailTarget, active: false }, slackTarget],
        mailConfigured: true,
        settings,
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await screen.findByRole("cell", { name: "CI alerts" })
    await userEvent.click(screen.getByRole("button", { name: "Active" }))
    expect(rowNames()).toEqual(["CI alerts", "Team channel", "Leads"])
    await userEvent.click(screen.getByRole("button", { name: "Active" }))
    expect(rowNames()[0]).toBe("Leads")

    await chooseFilter("Status", "Paused")
    expect(rowNames()).toEqual(["Leads"])
    await userEvent.click(screen.getByRole("button", { name: "Remove Status filter" }))
    await chooseFilter("Status", "Active")
    expect(rowNames()).toEqual(["CI alerts", "Team channel"])
  })

  it("shows members whether a target is active but does not let them change it", async () => {
    const asMember = testWorkspaces.map((workspace) => ({ ...workspace, role: "member" }))
    mockApi({
      "GET /api/auth/me": { user: testUser, workspaces: asMember },
      "GET /api/workspaces": { workspaces: asMember },
      "GET /api/notifications": { targets: [{ ...webhook, active: false }], mailConfigured: false, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const toggle = await screen.findByRole("switch", { name: "Active: CI alerts" })
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeDisabled()
    // The menu is there for the delivery history only.
    await userEvent.click(screen.getByRole("button", { name: "Actions for CI alerts" }))
    expect(await screen.findByRole("menuitem", { name: "View deliveries" })).toBeInTheDocument()
    for (const name of ["Send test", "Edit", "Remove"]) {
      expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument()
    }
  })

  it("shows each target's last delivery", async () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    mockApi({
      "GET /api/notifications": {
        targets: [
          { ...webhook, lastDelivery: { status: "sent", event: "blocked", httpStatus: null, error: null, createdAt: minutesAgo(4) } },
          {
            ...slackTarget,
            lastDelivery: {
              status: "failed",
              event: "test",
              httpStatus: 503,
              error: null,
              createdAt: minutesAgo(60),
            },
          },
          { ...emailTarget, lastDelivery: null },
        ],
        mailConfigured: true,
        settings,
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const cell = (name: string, column: number) => {
      const row = screen.getAllByRole("row").find((r) => within(r).queryByText(name))!
      return within(row).getAllByRole("cell")[column]!.textContent
    }
    expect(await screen.findByRole("columnheader", { name: "Last delivery" })).toBeInTheDocument()
    expect(cell("CI alerts", 4)).toBe("Sent · 4 minutes ago")
    expect(cell("Team channel", 4)).toBe("Failed · 503 · 1 hour ago")
    expect(cell("Leads", 4)).toBe("Never")
  })

  it("opens a target's delivery history and pages through it", async () => {
    const delivery = {
      id: "d1",
      event: "failed",
      status: "failed",
      httpStatus: null,
      error: "getaddrinfo ENOTFOUND ci.example.com",
      attempts: 1,
      jobId: "job-1",
      createdAt: "2026-11-01T10:00:00.000Z",
      finishedAt: "2026-11-01T10:00:01.000Z",
    }
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false, settings },
      "GET /api/notifications/n1/deliveries?page=1&limit=20": {
        deliveries: [
          delivery,
          { ...delivery, id: "d2", event: "test", status: "sent", error: null, jobId: null },
        ],
        total: 21,
        page: 1,
        limit: 20,
      },
      "GET /api/notifications/n1/deliveries?page=2&limit=20": {
        deliveries: [{ ...delivery, id: "d3", event: "completed", status: "sent", error: null }],
        total: 21,
        page: 2,
        limit: 20,
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "View deliveries" }))

    const sheet = await screen.findByRole("dialog", { name: "Deliveries to CI alerts" })
    expect(await within(sheet).findByText("getaddrinfo ENOTFOUND ci.example.com")).toBeInTheDocument()
    expect(within(sheet).getByText("Test")).toBeInTheDocument()
    expect(within(sheet).getAllByRole("link", { name: "View review" })[0]).toHaveAttribute("href", "/reviews/job-1")

    await userEvent.click(within(sheet).getByRole("button", { name: /next/i }))
    expect(await within(sheet).findByText("Completed")).toBeInTheDocument()
    expect(calls(fetchSpy, "GET", "/api/notifications/n1/deliveries?page=2&limit=20")).toHaveLength(1)
  })

  it("refreshes the last delivery after a test", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false, settings },
      "POST /api/notifications/n1/test": { result: { ok: true } },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Send test" }))

    expect(await screen.findByText("Test sent to CI alerts")).toBeInTheDocument()
    await vi.waitFor(() => expect(calls(fetchSpy, "GET", "/api/notifications")).toHaveLength(2))
  })

  it("shows why a target was auto-paused, in the list and when editing it", async () => {
    const reason = "Auto-paused: HTTP 410 Gone"
    mockApi({
      "GET /api/notifications": {
        targets: [{ ...slackTarget, active: false, pausedReason: reason, pauseCause: "gone" }],
        mailConfigured: false,
        settings,
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const row = (await screen.findByText("Team channel")).closest("tr")!
    expect(within(row).getByText(reason)).toBeInTheDocument()
    expect(within(row).getByRole("switch", { name: "Active: Team channel" })).not.toBeChecked()

    await userEvent.click(within(row).getByRole("button", { name: "Actions for Team channel" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(reason)).toBeInTheDocument()
    expect(within(dialog).getByText(/The Slack webhook was deleted/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Switching it back on in the list clears/)).toBeInTheDocument()
  })

  it("shows a delivery waiting for its first send or a retry", async () => {
    const now = Date.now()
    const pending = { status: "pending", event: "failed", error: null, createdAt: new Date(now - 4 * 60_000).toISOString() }
    mockApi({
      "GET /api/notifications": {
        targets: [
          {
            ...webhook,
            lastDelivery: { ...pending, httpStatus: null, attempts: 0, nextAttemptAt: pending.createdAt },
            pending: { count: 1, retry: null },
          },
          {
            ...slackTarget,
            lastDelivery: {
              ...pending,
              httpStatus: 503,
              attempts: 2,
              nextAttemptAt: new Date(now + 5 * 60_000).toISOString(),
            },
            pending: {
              count: 1,
              retry: {
                attempts: 2,
                httpStatus: 503,
                error: null,
                nextAttemptAt: new Date(now + 5 * 60_000).toISOString(),
              },
            },
          },
        ],
        mailConfigured: false,
        settings,
      },
      "GET /api/notifications/n3/deliveries?page=1&limit=20": {
        deliveries: [
          {
            ...pending,
            id: "d1",
            httpStatus: 503,
            attempts: 2,
            nextAttemptAt: new Date(now + 5 * 60_000).toISOString(),
            jobId: "job-1",
            finishedAt: null,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const lastDelivery = async (name: string) =>
      within((await screen.findByText(name)).closest("tr")!).getAllByRole("cell")[4]!
    expect((await lastDelivery("CI alerts")).textContent).toBe("Queued · 4 minutes ago")
    const retrying = await lastDelivery("Team channel")
    expect(retrying.textContent).toBe("Retrying · 503 · 4 minutes ago")
    expect(retrying.firstElementChild).toHaveAttribute("title", "Attempt 2 of 5 failed; next try in 5 minutes")

    await userEvent.click(screen.getByRole("button", { name: "Actions for Team channel" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "View deliveries" }))
    const sheet = await screen.findByRole("dialog", { name: "Deliveries to Team channel" })
    expect(await within(sheet).findByText("Retrying · 503")).toBeInTheDocument()
    expect(within(sheet).getByText("Attempt 2 of 5 failed; next try in 5 minutes")).toBeInTheDocument()
  })

  // One target of each kind of trouble, plus a healthy one that stays off the tab.
  function failingFixture() {
    const now = Date.now()
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
    const failed = { status: "failed", event: "failed", error: null, attempts: 5, nextAttemptAt: null, createdAt: at(-60) }
    return [
      { ...webhook, consecutiveFailures: 2, lastDelivery: { ...failed, httpStatus: 500 } },
      {
        ...slackTarget,
        active: false,
        pausedReason: "Auto-paused: HTTP 410 Gone",
        pauseCause: "gone",
        consecutiveFailures: 1,
        lastDelivery: { ...failed, httpStatus: 410, attempts: 1 },
      },
      {
        ...webhook,
        id: "n4",
        name: "Ops hook",
        lastDelivery: { ...failed, status: "pending", httpStatus: 502, attempts: 2, nextAttemptAt: at(25) },
        pending: { count: 1, retry: { attempts: 2, httpStatus: 502, error: null, nextAttemptAt: at(25) } },
      },
      {
        ...emailTarget,
        lastDelivery: { ...failed, status: "sent", event: "completed", httpStatus: null, attempts: 1 },
      },
    ]
  }

  it("lists failing targets in their own tab with their status, count and what went wrong", async () => {
    mockApi({
      "GET /api/notifications": { targets: failingFixture(), mailConfigured: true, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const tab = await screen.findByRole("tab", { name: /Failing targets/ })
    // Something is paused, so the count is in the urgent colour.
    expect(within(tab).getByText("3")).toHaveAttribute("data-urgent", "true")
    expect(screen.queryByLabelText("Auto-pause after")).not.toBeInTheDocument()
    await userEvent.click(tab)

    expect(await screen.findByText("1 paused · 1 failing · 1 retrying")).toBeInTheDocument()
    const rows = screen.getAllByRole("row").slice(1)
    const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((cell) => cell.textContent)
    // Paused first, then failing, then retrying; the healthy target is left out.
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.querySelector(".font-medium")!.textContent)).toEqual([
      "Team channel",
      "CI alerts",
      "Ops hook",
    ])
    const [paused, failing, retrying] = rows as [HTMLElement, HTMLElement, HTMLElement]
    expect(cells(paused)[0]).toContain("The Slack webhook was deleted. Remove this target and add a new webhook URL.")
    expect(cells(paused)[1]).toBe("Paused")
    expect(cells(paused)[3]).toBe("Endpoint gone")
    expect(cells(failing)[1]).toBe("Failing")
    expect(within(failing).getByRole("meter", { name: "Failures in a row for CI alerts" })).toHaveAttribute(
      "aria-valuenow",
      "2",
    )
    expect(cells(failing)[3]).toBe("2 of 5")
    expect(within(failing).getByText("HTTP 500")).toBeInTheDocument()
    expect(cells(retrying)[1]).toBe("Retrying")
    expect(within(retrying).getByText("HTTP 502 · next try in 25 minutes")).toBeInTheDocument()

    // Only the paused one offers Resume; the switch stays on the Targets tab.
    expect(within(paused).getByRole("button", { name: "Resume Team channel" })).toBeInTheDocument()
    expect(within(failing).queryByRole("button", { name: /^Resume/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("switch")).not.toBeInTheDocument()

    await userEvent.click(within(paused).getByRole("button", { name: "View deliveries to Team channel" }))
    expect(await screen.findByRole("dialog", { name: "Deliveries to Team channel" })).toBeInTheDocument()
  })

  it("keeps a target retrying when a newer delivery went through", async () => {
    const now = Date.now()
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
    mockApi({
      "GET /api/notifications": {
        targets: [
          {
            ...webhook,
            lastDelivery: {
              status: "sent",
              event: "test",
              httpStatus: null,
              error: null,
              attempts: 1,
              nextAttemptAt: null,
              createdAt: at(-1),
            },
            pending: { count: 1, retry: { attempts: 1, httpStatus: 503, error: null, nextAttemptAt: at(4) } },
          },
        ],
        mailConfigured: false,
        settings,
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("tab", { name: /Failing targets/ }))

    expect(await screen.findByText("1 retrying")).toBeInTheDocument()
    const [row] = screen.getAllByRole("row").slice(1) as [HTMLElement]
    expect(within(row).getAllByRole("cell")[1]!.textContent).toBe("Retrying")
    expect(
      within(row).getByText("Earlier delivery: attempt 1 of 5 failed · HTTP 503 · next try in 4 minutes"),
    ).toBeInTheDocument()
  })

  it("uses a neutral count when nothing is paused", async () => {
    mockApi({
      "GET /api/notifications": { targets: [{ ...webhook, consecutiveFailures: 1 }], mailConfigured: false, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const tab = await screen.findByRole("tab", { name: /Failing targets/ })
    expect(within(tab).getByText("1")).toHaveAttribute("data-urgent", "false")
  })

  it("asks before resuming a paused target", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: failingFixture(), mailConfigured: false, settings },
      "PATCH /api/notifications/n3": { target: { ...slackTarget, active: true } },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications?tab=failing" })

    await userEvent.click(await screen.findByRole("button", { name: "Resume Team channel" }))
    const dialog = await screen.findByRole("dialog", { name: "Resume Team channel?" })
    expect(within(dialog).getByText(/the failure count resets/)).toBeInTheDocument()
    expect(calls(fetchSpy, "PATCH", "/api/notifications/n3")).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole("button", { name: "Resume" }))

    expect(await screen.findByText("Resumed Team channel")).toBeInTheDocument()
    const [, init] = calls(fetchSpy, "PATCH", "/api/notifications/n3")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({ active: true })
  })

  it("offers to resume a paused target once its test passes", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: failingFixture(), mailConfigured: false, settings },
      "POST /api/notifications/n3/test": { result: { ok: true } },
      "PATCH /api/notifications/n3": { target: { ...slackTarget, active: true } },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications?tab=failing" })

    await userEvent.click(await screen.findByRole("button", { name: "Send test to Team channel" }))
    expect(await screen.findByText("Test to Team channel passed")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Resume" }))

    await vi.waitFor(() => expect(calls(fetchSpy, "PATCH", "/api/notifications/n3")).toHaveLength(1))
    // Sonner can briefly render a toast twice while the previous one animates out.
    expect((await screen.findAllByText("Resumed Team channel")).length).toBeGreaterThan(0)
  })

  it("saves the auto-pause limit as soon as an admin picks one", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: failingFixture(), mailConfigured: false, settings },
      "PATCH /api/notifications/settings": { settings: { autoPauseAfter: 0 } },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications?tab=failing" })

    const select = await screen.findByRole("combobox", { name: "Auto-pause after" })
    expect(select).toHaveTextContent("5 failures")
    await userEvent.click(select)
    await userEvent.click(screen.getByRole("option", { name: "Never" }))

    expect(await screen.findByText("Targets will never be paused")).toBeInTheDocument()
    const [, init] = calls(fetchSpy, "PATCH", "/api/notifications/settings")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({ autoPauseAfter: 0 })
  })

  it("explains auto-pause on request", async () => {
    mockApi({
      "GET /api/notifications": { targets: failingFixture(), mailConfigured: false, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications?tab=failing" })

    await userEvent.click(await screen.findByRole("button", { name: "How auto-pause works" }))
    expect(await screen.findByText(/Each delivery is tried up to 5 times/)).toBeInTheDocument()
  })

  it("shows members the limit in a line and leaves them only the history", async () => {
    const asMember = testWorkspaces.map((workspace) => ({ ...workspace, role: "member" }))
    mockApi({
      "GET /api/auth/me": { user: testUser, workspaces: asMember },
      "GET /api/workspaces": { workspaces: asMember },
      "GET /api/notifications": {
        targets: [{ ...webhook, consecutiveFailures: 3 }, ...failingFixture().slice(1, 2)],
        mailConfigured: false,
        settings: { autoPauseAfter: 0 },
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications?tab=failing" })

    expect(await screen.findByText("Never pauses (set by admins)")).toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Auto-pause after" })).not.toBeInTheDocument()
    // With no limit the count stands alone.
    expect(screen.getByText("(no limit)")).toBeInTheDocument()
    // Row buttons name their target ("Resume Team channel"); a bare "Resume" is a toast's.
    expect(screen.queryByRole("button", { name: /^(Resume |Send test)/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "View deliveries to CI alerts" })).toBeInTheDocument()
  })

  it("celebrates when no target is failing", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications?tab=failing" })

    expect(await screen.findByText("All targets are delivering")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Failing targets" })).toHaveAttribute("aria-selected", "true")
    // The limit is there even with nothing failing.
    expect(screen.getByRole("combobox", { name: "Auto-pause after" })).toBeInTheDocument()
  })

  it("stacks failing targets as cards on a phone", async () => {
    setViewportWidth(390)
    mockApi({
      "GET /api/notifications": { targets: failingFixture(), mailConfigured: false, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications?tab=failing" })

    const list = await screen.findByRole("list", { name: "Failing targets" })
    const cards = within(list).getAllByRole("listitem")
    expect(cards).toHaveLength(3)
    expect(within(cards[0]!).getByText("Team channel")).toBeInTheDocument()
    expect(within(cards[0]!).getByText("Endpoint gone")).toBeInTheDocument()
    expect(within(cards[0]!).getByRole("button", { name: "Resume Team channel" })).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("asks before removing a target", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false, settings },
      "DELETE /api/notifications/n1": () => new Response(null, { status: 204 }),
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))
    const dialog = await screen.findByRole("dialog")
    expect(calls(fetchSpy, "DELETE", "/api/notifications/n1")).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove target" }))

    expect(await screen.findByText("Removed CI alerts")).toBeInTheDocument()
    expect(calls(fetchSpy, "DELETE", "/api/notifications/n1")).toHaveLength(1)
  })
})
