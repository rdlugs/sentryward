import { describe, expect, it } from "vitest"
import type { LastDelivery, NotificationTarget, PendingRetry } from "./api"
import { causeHint, deliveryDetail, failingStatus, failingTargets, pendingRetryDetail, retryNote } from "./delivery"

const NOW = Date.parse("2026-11-10T12:00:00Z")
const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

const delivery = (overrides: Partial<LastDelivery> = {}): LastDelivery => ({
  status: "failed",
  event: "failed",
  httpStatus: null,
  error: null,
  attempts: 1,
  nextAttemptAt: null,
  createdAt: inMinutes(-10),
  ...overrides,
})

const retry = (overrides: Partial<PendingRetry> = {}): PendingRetry => ({
  attempts: 1,
  httpStatus: 503,
  error: null,
  nextAttemptAt: inMinutes(5),
  ...overrides,
})
const retrying = { count: 1, retry: retry() }

const target = (overrides: Partial<NotificationTarget> = {}): NotificationTarget => ({
  id: "t1",
  kind: "webhook",
  name: "Hook",
  events: ["failed"],
  host: "hooks.example.com",
  undecryptable: false,
  recipientIds: [],
  active: true,
  pausedReason: null,
  pauseCause: null,
  consecutiveFailures: 0,
  lastDelivery: null,
  pending: { count: 0, retry: null },
  createdAt: inMinutes(-1000),
  updatedAt: inMinutes(-1000),
  ...overrides,
})

describe("deliveryDetail", () => {
  it("names the HTTP status, or the error when there is none", () => {
    expect(deliveryDetail(delivery({ httpStatus: 503, error: null }), NOW)).toBe("HTTP 503")
    expect(deliveryDetail(delivery({ error: "getaddrinfo ENOTFOUND" }), NOW)).toBe("getaddrinfo ENOTFOUND")
  })

  it("adds when a retry is due, or that it is due now", () => {
    const retrying = delivery({ status: "pending", attempts: 2, httpStatus: 502, nextAttemptAt: inMinutes(25) })
    expect(deliveryDetail(retrying, NOW)).toBe("HTTP 502 · next try in 25 minutes")
    expect(deliveryDetail({ ...retrying, nextAttemptAt: inMinutes(-3) }, NOW)).toBe("HTTP 502 · retrying now")
  })

  it("has nothing to say about a sent or queued delivery", () => {
    expect(deliveryDetail(delivery({ status: "sent" }), NOW)).toBeNull()
    expect(deliveryDetail(delivery({ status: "pending", attempts: 0, nextAttemptAt: inMinutes(0) }), NOW)).toBeNull()
    expect(deliveryDetail(null, NOW)).toBeNull()
  })
})

describe("retryNote", () => {
  it("says a retry is under way once its time has passed", () => {
    const retrying = delivery({ status: "pending", attempts: 3, nextAttemptAt: inMinutes(-1) })
    expect(retryNote(retrying, NOW)).toBe("Attempt 3 of 5 failed; retrying now")
  })
})

describe("failingStatus", () => {
  it("puts paused before retrying before failing", () => {
    expect(failingStatus(target({ pausedReason: "Auto-paused: HTTP 410 Gone", pending: retrying }))).toBe("paused")
    expect(failingStatus(target({ consecutiveFailures: 2, pending: retrying }))).toBe("retrying")
    expect(failingStatus(target({ consecutiveFailures: 2 }))).toBe("failing")
  })

  it("keeps a target retrying when a newer delivery went through", () => {
    const sent = delivery({ status: "sent", event: "test" })
    expect(failingStatus(target({ lastDelivery: sent, pending: retrying }))).toBe("retrying")
  })

  it("leaves out healthy and merely queued targets", () => {
    expect(failingStatus(target())).toBeNull()
    expect(
      failingStatus(
        target({ lastDelivery: delivery({ status: "pending", attempts: 0 }), pending: { count: 1, retry: null } }),
      ),
    ).toBeNull()
  })
})

describe("pendingRetryDetail", () => {
  it("describes a retry queued behind a newer delivery", () => {
    const t = target({
      lastDelivery: delivery({ status: "sent" }),
      pending: { count: 2, retry: retry({ attempts: 2 }) },
    })
    expect(pendingRetryDetail(t, NOW)).toBe("Earlier delivery: attempt 2 of 5 failed · HTTP 503 · next try in 5 minutes")
    const errored = target({
      pending: { count: 1, retry: retry({ httpStatus: null, error: "ECONNRESET", nextAttemptAt: inMinutes(-1) }) },
    })
    expect(pendingRetryDetail(errored, NOW)).toBe("Earlier delivery: attempt 1 of 5 failed · ECONNRESET · retrying now")
  })

  it("stays quiet when there is no retry or the last delivery already shows it", () => {
    expect(pendingRetryDetail(target(), NOW)).toBeNull()
    const last = delivery({ status: "pending", attempts: 1, httpStatus: 503, nextAttemptAt: inMinutes(5) })
    expect(pendingRetryDetail(target({ lastDelivery: last, pending: retrying }), NOW)).toBeNull()
  })
})

describe("failingTargets", () => {
  it("orders paused, failing, then retrying, most failures first", () => {
    const rows = failingTargets([
      target({ id: "r", name: "Retrying", pending: retrying }),
      target({ id: "f1", name: "One failure", consecutiveFailures: 1 }),
      target({ id: "ok", name: "Healthy" }),
      target({ id: "p", name: "Paused", pausedReason: "x", pauseCause: "failures", consecutiveFailures: 5 }),
      target({ id: "f3", name: "Three failures", consecutiveFailures: 3 }),
    ])
    expect(rows.map((row) => [row.target.id, row.status])).toEqual([
      ["p", "paused"],
      ["f3", "failing"],
      ["f1", "failing"],
      ["r", "retrying"],
    ])
  })
})

describe("causeHint", () => {
  it("tells a deleted Slack webhook from a gone endpoint and a failing one", () => {
    expect(causeHint(target({ kind: "slack", pauseCause: "gone" }))).toMatch(/Slack webhook was deleted/)
    expect(causeHint(target({ pauseCause: "gone" }))).toMatch(/no longer exists/)
    expect(causeHint(target({ pauseCause: "failures" }))).toBe("Check the delivery errors, send a test, then resume.")
    expect(causeHint(target())).toBeNull()
  })
})
