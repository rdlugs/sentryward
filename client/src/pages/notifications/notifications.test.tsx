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
  repositoryIds: [],
  minSeverity: null,
  onlyVerdictChanges: false,
  delivery: { mode: "each", hour: null, weekday: null, timeZone: null, nextDigestAt: null, held: 0 },
  active: true,
  pausedReason: null,
  pauseCause: null,
  secretRotatedUntil: null,
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

const repos = [{ id: "r1", fullPath: "acme/payments" }]

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
    const sheet = await screen.findByRole("dialog")
    await userEvent.type(within(sheet).getByLabelText("Name"), "CI alerts")
    await userEvent.type(within(sheet).getByLabelText("URL"), "https://ci.example.com/hook")
    await userEvent.click(within(sheet).getByRole("button", { name: "Add target" }))

    expect(await within(sheet).findByLabelText("Signing secret")).toHaveValue("abc123")
    // The secret stays on screen once the table replaces the empty state (the
    // sheet hides the page behind it from role queries).
    expect(await screen.findByRole("cell", { name: "CI alerts", hidden: true })).toBeInTheDocument()
    expect(within(sheet).getByLabelText("Signing secret")).toHaveValue("abc123")
    const [, init] = calls(fetchSpy, "POST", "/api/notifications")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "webhook",
      name: "CI alerts",
      events: ["blocked", "failed"],
      url: "https://ci.example.com/hook",
      repositoryIds: [],
      minSeverity: null,
      onlyVerdictChanges: false,
      delivery: { mode: "each" },
    })
  })

  it("adds a target limited to chosen repositories, a severity and verdict changes", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [], mailConfigured: false, settings },
      "POST /api/notifications": () => jsonResponse(201, { target: webhook, secret: "abc123" }),
      "GET /api/repos": { repos: repos },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Add target" }))
    const sheet = await screen.findByRole("dialog")
    await userEvent.type(within(sheet).getByLabelText("Name"), "Payments")
    await userEvent.type(within(sheet).getByLabelText("URL"), "https://ci.example.com/hook")
    await userEvent.click(within(sheet).getByRole("checkbox", { name: "Resolved" }))
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Repositories" }))
    await userEvent.click(screen.getByRole("option", { name: "Only these" }))

    // "Only these" with nothing ticked is not a choice.
    await userEvent.click(within(sheet).getByRole("button", { name: "Add target" }))
    expect(await within(sheet).findByText("Choose at least one repository")).toBeInTheDocument()
    expect(calls(fetchSpy, "POST", "/api/notifications")).toHaveLength(0)

    await userEvent.click(await within(sheet).findByRole("checkbox", { name: "acme/payments" }))
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Minimum severity" }))
    await userEvent.click(screen.getByRole("option", { name: "Major or worse" }))
    await userEvent.click(within(sheet).getByRole("checkbox", { name: "Only when the verdict changes" }))
    await userEvent.click(within(sheet).getByRole("button", { name: "Add target" }))

    expect(await within(sheet).findByLabelText("Signing secret")).toBeInTheDocument()
    const [, init] = calls(fetchSpy, "POST", "/api/notifications")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "webhook",
      name: "Payments",
      events: ["blocked", "failed", "resolved"],
      url: "https://ci.example.com/hook",
      repositoryIds: ["r1"],
      minSeverity: "major",
      onlyVerdictChanges: true,
      delivery: { mode: "each" },
    })
  })

  it("shows a target's scope under its name and edits it back to everything", async () => {
    const scoped = { ...webhook, repositoryIds: ["r1"], minSeverity: "major", onlyVerdictChanges: true }
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [scoped], mailConfigured: false, settings },
      "PATCH /api/notifications/n1": { target: webhook },
      "GET /api/repos": { repos: repos },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const row = (await screen.findByText("CI alerts")).closest("tr")!
    expect(await within(row).findByText("acme/payments · ≥ major · verdict changes")).toBeInTheDocument()

    await userEvent.click(within(row).getByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByRole("checkbox", { name: "acme/payments" })).toBeChecked()
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Repositories" }))
    await userEvent.click(screen.getByRole("option", { name: "All repositories" }))
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Minimum severity" }))
    await userEvent.click(screen.getByRole("option", { name: "Any" }))
    await userEvent.click(within(sheet).getByRole("checkbox", { name: "Only when the verdict changes" }))
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }))

    await vi.waitFor(() => expect(calls(fetchSpy, "PATCH", "/api/notifications/n1")).toHaveLength(1))
    const [, init] = calls(fetchSpy, "PATCH", "/api/notifications/n1")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "CI alerts",
      events: ["failed", "blocked"],
      repositoryIds: [],
      minSeverity: null,
      onlyVerdictChanges: false,
    })
  })

  it("adds a weekly digest target and shows its schedule under its name", async () => {
    const digest = {
      ...webhook,
      delivery: {
        mode: "weekly",
        hour: 8,
        weekday: 5,
        timeZone: "UTC",
        nextDigestAt: "2026-11-13T08:00:00.000Z",
        held: 3,
      },
    }
    let created = false
    const fetchSpy = mockApi({
      "GET /api/notifications": () =>
        jsonResponse(200, { targets: created ? [digest] : [], mailConfigured: false, settings }),
      "POST /api/notifications": () => {
        created = true
        return jsonResponse(201, { target: digest, secret: "abc123" })
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Add target" }))
    const sheet = await screen.findByRole("dialog")
    await userEvent.type(within(sheet).getByLabelText("Name"), "CI alerts")
    await userEvent.type(within(sheet).getByLabelText("URL"), "https://ci.example.com/hook")
    // Digest-only fields stay hidden until a digest is chosen.
    expect(within(sheet).queryByRole("combobox", { name: "Time" })).not.toBeInTheDocument()
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Send" }))
    await userEvent.click(screen.getByRole("option", { name: "Weekly digest" }))
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Day" }))
    await userEvent.click(screen.getByRole("option", { name: "Friday" }))
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Time" }))
    await userEvent.click(screen.getByRole("option", { name: "08:00" }))
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Timezone" }))
    await userEvent.click(screen.getByRole("option", { name: "UTC" }))
    await userEvent.click(within(sheet).getByRole("button", { name: "Add target" }))

    expect(await within(sheet).findByLabelText("Signing secret")).toBeInTheDocument()
    const [, init] = calls(fetchSpy, "POST", "/api/notifications")[0]!
    expect(JSON.parse(String(init?.body)).delivery).toEqual({ mode: "weekly", hour: 8, weekday: 5, timeZone: "UTC" })
    expect(
      await screen.findByText("Weekly digest · Fri 08:00 UTC · 3 reviews held", undefined, { timeout: 3000 }),
    ).toBeInTheDocument()
    // Four selects to drive; slow under the full suite's load.
  }, 15_000)

  it("asks for repositories again when a target's were all removed", async () => {
    const reason = "Paused: its repositories were removed"
    mockApi({
      "GET /api/notifications": {
        targets: [{ ...webhook, active: false, pausedReason: reason, pauseCause: "scope" }],
        mailConfigured: false,
        settings,
      },
      "GET /api/repos": { repos: repos },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const row = (await screen.findByText("CI alerts")).closest("tr")!
    await userEvent.click(within(row).getByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText(/Choose repositories, or All, when editing it/)).toBeInTheDocument()
    expect(within(sheet).getByText(/Saving a choice here clears this notice/)).toBeInTheDocument()
    expect(within(sheet).getByRole("combobox", { name: "Repositories" })).toHaveTextContent("Only these")
  })

  it("does not offer Resume for a target whose repositories were all removed", async () => {
    const reason = "Paused: its repositories were removed"
    const scoped = { ...webhook, active: false, pausedReason: reason, pauseCause: "scope" }
    mockApi({
      "GET /api/notifications": { targets: [scoped], mailConfigured: false, settings },
      "GET /api/repos": { repos: repos },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    expect(await screen.findByRole("switch", { name: "Active: CI alerts" })).toBeDisabled()
    await userEvent.click(screen.getByRole("tab", { name: /Failing targets/ }))
    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    expect(await screen.findByRole("menuitem", { name: "View deliveries" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Resume" })).not.toBeInTheDocument()
  })

  it("shows why the server refused to switch a target on", async () => {
    mockApi({
      "GET /api/notifications": { targets: [{ ...webhook, active: false }], mailConfigured: false, settings },
      "PATCH /api/notifications/n1": () =>
        jsonResponse(400, { message: "Validation failed", errors: { repositoryIds: ["Choose repositories first"] } }),
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("switch", { name: "Active: CI alerts" }))
    expect(await screen.findByText("Choose repositories first")).toBeInTheDocument()
  })

  it("needs a URL and at least one event", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [], mailConfigured: false, settings },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Add target" }))
    const sheet = await screen.findByRole("dialog")
    await userEvent.type(within(sheet).getByLabelText("Name"), "CI")
    await userEvent.click(within(sheet).getByLabelText("Blocked"))
    await userEvent.click(within(sheet).getByLabelText("Failed"))
    await userEvent.click(within(sheet).getByRole("button", { name: "Add target" }))

    expect(await within(sheet).findByText("Enter an http or https URL")).toBeInTheDocument()
    expect(within(sheet).getByText("Choose at least one event")).toBeInTheDocument()
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
    for (const name of ["Send test", "Edit", "Rotate secret", "Remove"]) {
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
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText(reason)).toBeInTheDocument()
    expect(within(sheet).getByText(/The Slack webhook was deleted/)).toBeInTheDocument()
    expect(within(sheet).getByText(/Switching it back on in the list clears/)).toBeInTheDocument()
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
    await userEvent.click(within(failing).getByRole("button", { name: "Actions for CI alerts" }))
    expect(await screen.findByRole("menuitem", { name: "Send test" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Resume" })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("switch")).not.toBeInTheDocument()

    await userEvent.click(within(paused).getByRole("button", { name: "Actions for Team channel" }))
    expect(await screen.findByRole("menuitem", { name: "Resume" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("menuitem", { name: "View deliveries" }))
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

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Team channel" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Resume" }))
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

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Team channel" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Send test" }))
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
    // Members can only open the history.
    await userEvent.click(screen.getByRole("button", { name: "Actions for CI alerts" }))
    expect(await screen.findByRole("menuitem", { name: "View deliveries" })).toBeInTheDocument()
    expect(screen.getAllByRole("menuitem")).toHaveLength(1)
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
    await userEvent.click(within(cards[0]!).getByRole("button", { name: "Actions for Team channel" }))
    expect(await screen.findByRole("menuitem", { name: "Resume" })).toBeInTheDocument()
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

  it("changes a webhook's URL in place, sending it only when one is entered", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false, settings },
      "PATCH /api/notifications/n1": { target: { ...webhook, host: "new.example.com" } },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))
    const sheet = await screen.findByRole("dialog")
    const url = within(sheet).getByLabelText("New URL")
    expect(url).toHaveValue("")
    expect(within(sheet).getByText(/Sending to ci\.example\.com/)).toBeInTheDocument()
    await userEvent.type(url, "not a url")
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }))
    expect(await within(sheet).findByText("Enter an http or https URL")).toBeInTheDocument()
    expect(calls(fetchSpy, "PATCH", "/api/notifications/n1")).toHaveLength(0)

    await userEvent.clear(url)
    await userEvent.type(url, "https://new.example.com/hook")
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }))

    await vi.waitFor(() => expect(calls(fetchSpy, "PATCH", "/api/notifications/n1")).toHaveLength(1))
    const [, init] = calls(fetchSpy, "PATCH", "/api/notifications/n1")[0]!
    expect(JSON.parse(String(init?.body))).toMatchObject({ name: "CI alerts", url: "https://new.example.com/hook" })
  })

  it("shows the server's reason when it refuses a new URL", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false, settings },
      "PATCH /api/notifications/n1": () =>
        jsonResponse(400, { message: "Validation failed", errors: { url: ["Private addresses are not allowed"] } }),
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))
    const sheet = await screen.findByRole("dialog")
    await userEvent.type(within(sheet).getByLabelText("New URL"), "https://10.0.0.1/hook")
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }))

    expect(await within(sheet).findByText("Private addresses are not allowed")).toBeInTheDocument()
  })

  it("asks before rotating a webhook's secret, then shows the new one once", async () => {
    const until = "2026-11-12T09:30:00.000Z"
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [webhook, slackTarget], mailConfigured: false, settings },
      "POST /api/notifications/n1/rotate-secret": {
        target: { ...webhook, secretRotatedUntil: until },
        secret: "fresh-secret",
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    // Slack targets have no secret to rotate.
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Team channel" }))
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Rotate secret" })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    await userEvent.click(screen.getByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rotate secret" }))
    const sheet = await screen.findByRole("dialog")
    expect(calls(fetchSpy, "POST", "/api/notifications/n1/rotate-secret")).toHaveLength(0)
    await userEvent.click(within(sheet).getByRole("button", { name: "Rotate secret" }))

    expect(await within(sheet).findByLabelText("Signing secret")).toHaveValue("fresh-secret")
    expect(within(sheet).getByText("Secret rotated")).toBeInTheDocument()
    expect(within(sheet).getByText(/also carries a signature made with the previous secret/)).toBeInTheDocument()
    expect(calls(fetchSpy, "POST", "/api/notifications/n1/rotate-secret")).toHaveLength(1)
  })

  it("keeps the rotate sheet open while the rotation runs, so the new secret is not lost", async () => {
    let finish: (response: Response) => void = () => {}
    mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false, settings },
      "POST /api/notifications/n1/rotate-secret": () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rotate secret" }))
    const sheet = await screen.findByRole("dialog")
    await userEvent.click(within(sheet).getByRole("button", { name: "Rotate secret" }))

    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeDisabled()
    await userEvent.keyboard("{Escape}")
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    finish(jsonResponse(200, { target: webhook, secret: "fresh-secret" }))
    expect(await within(sheet).findByLabelText("Signing secret")).toHaveValue("fresh-secret")
  })
})

describe("Personal notifications", () => {
  const personal = {
    enabled: false,
    events: ["failed", "blocked", "resolved"],
    pausedReason: null,
    forges: [{ provider: "github", host: "github.com", linked: true }],
    mailConfigured: true,
  }

  it("lets a member switch on email about their own changes and choose events", async () => {
    const asMember = testWorkspaces.map((workspace) => ({ ...workspace, role: "member" }))
    let saved = personal
    const fetchSpy = mockApi({
      "GET /api/auth/me": { user: testUser, workspaces: asMember },
      "GET /api/workspaces": { workspaces: asMember },
      "GET /api/notifications": { targets: [], mailConfigured: true, settings },
      "GET /api/notifications/personal": () => jsonResponse(200, saved),
      "PUT /api/notifications/personal": (init?: RequestInit) => {
        saved = { ...saved, ...JSON.parse(String(init?.body)) }
        return jsonResponse(200, saved)
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const toggle = await screen.findByRole("switch", { name: "Email me about reviews of my changes" })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await vi.waitFor(() => expect(toggle).toBeChecked())
    await userEvent.click(screen.getByRole("checkbox", { name: "Resolved" }))

    await vi.waitFor(() => expect(calls(fetchSpy, "PUT", "/api/notifications/personal")).toHaveLength(2))
    const bodies = calls(fetchSpy, "PUT", "/api/notifications/personal").map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toEqual([
      { enabled: true, events: ["failed", "blocked", "resolved"] },
      { enabled: true, events: ["failed", "blocked"] },
    ])
  })

  it("keeps the last event chosen", async () => {
    mockApi({
      "GET /api/notifications": { targets: [], mailConfigured: true, settings },
      "GET /api/notifications/personal": { ...personal, enabled: true, events: ["blocked"] },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    expect(await screen.findByRole("checkbox", { name: "Blocked" })).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: "Failed" })).toBeEnabled()
  })

  it("points to Sign-in methods for a forge account that is not linked", async () => {
    mockApi({
      "GET /api/notifications": { targets: [], mailConfigured: true, settings },
      "GET /api/notifications/personal": {
        ...personal,
        forges: [
          { provider: "github", host: "github.com", linked: true },
          { provider: "gitlab", host: "gitlab.acme.com", linked: false },
        ],
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    expect(await screen.findByText(/Link GitLab \(gitlab\.acme\.com\) under/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Settings, Sign-in methods" })).toHaveAttribute("href", "/settings?tab=sign-in")
  })

  it("cannot be switched on without mail", async () => {
    mockApi({
      "GET /api/notifications": { targets: [], mailConfigured: false, settings },
      "GET /api/notifications/personal": { ...personal, mailConfigured: false },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    expect(await screen.findByRole("switch", { name: "Email me about reviews of my changes" })).toBeDisabled()
    expect(screen.getByText("Mail is not configured")).toBeInTheDocument()
  })
})
