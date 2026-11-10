import { timeAgo } from "@/lib/time"
import { MAX_DELIVERY_ATTEMPTS, type LastDelivery, type NotificationTarget } from "./api"

// "Sent", "Failed · 503", "Queued" or "Retrying · 503"; the error text is
// shown separately, since it can be long.
export function deliveryOutcome(delivery: LastDelivery) {
  const status = delivery.httpStatus ? ` · ${delivery.httpStatus}` : ""
  switch (delivery.status) {
    case "sent":
      return "Sent"
    case "failed":
      return `Failed${status}`
    case "pending":
      // Nothing has been tried yet, or the last try failed and another is due.
      return delivery.attempts === 0 ? "Queued" : `Retrying${status}`
  }
}

// "next try in 25 minutes", or "retrying now" once that moment has passed and
// the list has not caught up with the worker yet.
function nextTry(nextAttemptAt: string | null, now: number) {
  if (!nextAttemptAt) return null
  return Date.parse(nextAttemptAt) <= now ? "retrying now" : `next try ${timeAgo(nextAttemptAt, now)}`
}

// When a pending delivery that already failed is tried next.
export function retryNote(delivery: LastDelivery, now = Date.now()) {
  if (delivery.status !== "pending" || delivery.attempts === 0) return null
  const next = nextTry(delivery.nextAttemptAt, now)
  return `Attempt ${delivery.attempts} of ${MAX_DELIVERY_ATTEMPTS} failed${next ? `; ${next}` : ""}`
}

// One line under a failing delivery's outcome: what went wrong and, while it is
// being retried, when the next try is. Null for a delivery that went through.
export function deliveryDetail(delivery: LastDelivery | null, now = Date.now()) {
  if (!delivery || delivery.status === "sent") return null
  if (delivery.status === "pending" && delivery.attempts === 0) return null
  const parts = [delivery.httpStatus ? `HTTP ${delivery.httpStatus}` : delivery.error]
  if (delivery.status === "pending") parts.push(nextTry(delivery.nextAttemptAt, now))
  const detail = parts.filter(Boolean).join(" · ")
  return detail || null
}

export type FailingStatus = "paused" | "retrying" | "failing"

// Why a target is on the Failing targets tab, most urgent first: the server
// paused it, a delivery is being retried, or deliveries failed in a row.
export function failingStatus(target: NotificationTarget): FailingStatus | null {
  if (target.pausedReason !== null) return "paused"
  const last = target.lastDelivery
  if (last?.status === "pending" && last.attempts > 0) return "retrying"
  if (target.consecutiveFailures > 0) return "failing"
  return null
}

// What to do about a paused target, in plain words.
export function causeHint(target: NotificationTarget) {
  if (target.pauseCause === "gone") {
    return target.kind === "slack"
      ? "The Slack webhook was deleted. Remove this target and add a new webhook URL."
      : "The endpoint says it no longer exists. Check it, then remove and add the target again."
  }
  if (target.pauseCause === "failures") return "Check the delivery errors, send a test, then resume."
  return null
}

const STATUS_ORDER: Record<FailingStatus, number> = { paused: 0, failing: 1, retrying: 2 }

// The Failing targets tab's rows: paused first, then failing, then retrying,
// and within each the most failures in a row first.
export function failingTargets(targets: NotificationTarget[]) {
  return targets
    .flatMap((target) => {
      const status = failingStatus(target)
      return status ? [{ target, status }] : []
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        b.target.consecutiveFailures - a.target.consecutiveFailures ||
        a.target.name.localeCompare(b.target.name),
    )
}

export type FailingRow = ReturnType<typeof failingTargets>[number]
