import { plural } from "@/lib/plural"
import { timeAgo } from "@/lib/time"
import {
  MAX_DELIVERY_ATTEMPTS,
  type LastDelivery,
  type NotificationTarget,
  type TargetDelivery,
  type TargetFilters,
} from "./api"

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

// A retry still queued behind a newer delivery, which the last delivery's own
// detail says nothing about. Null when there is none, or when the last
// delivery is itself being retried and already shows it.
export function pendingRetryDetail(target: NotificationTarget, now = Date.now()) {
  const retry = target.pending.retry
  const last = target.lastDelivery
  if (!retry || (last?.status === "pending" && last.attempts > 0)) return null
  const parts = [
    `Earlier delivery: attempt ${retry.attempts} of ${MAX_DELIVERY_ATTEMPTS} failed`,
    retry.httpStatus ? `HTTP ${retry.httpStatus}` : retry.error,
    nextTry(retry.nextAttemptAt, now),
  ]
  return parts.filter(Boolean).join(" · ")
}

export type FailingStatus = "paused" | "retrying" | "failing"

// Why a target is on the Failing targets tab, most urgent first: the server
// paused it, a delivery is being retried, or deliveries failed in a row. Any
// queued retry counts, not only the newest delivery: a test or a later review
// going through leaves an older one still retrying.
export function failingStatus(target: NotificationTarget): FailingStatus | null {
  if (target.pausedReason !== null) return "paused"
  if (target.pending.retry) return "retrying"
  if (target.consecutiveFailures > 0) return "failing"
  return null
}

// What to do about a paused target, in plain words.
export function causeHint(target: NotificationTarget) {
  if (target.pauseCause === "gone") {
    if (target.kind === "slack") return "The Slack webhook was deleted. Remove this target and add a new webhook URL."
    if (target.kind === "google_chat") {
      return "The Google Chat webhook or its space was deleted. Remove this target and add a new webhook URL."
    }
    if (target.kind === "discord") {
      return "The Discord webhook or its channel was deleted. Remove this target and add a new webhook URL."
    }
    return "The endpoint says it no longer exists. Check it, then remove and add the target again."
  }
  if (target.pauseCause === "failures") return "Check the delivery errors, send a test, then resume."
  if (target.pauseCause === "scope") {
    return "Every repository it was limited to was removed. Choose repositories, or All, when editing it and save, then resume."
  }
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

// "acme/payments · ≥ major · verdict changes", or null for a target that hears
// about everything. Repositories the list does not know (still loading, or
// just removed) are counted ("acme/a +2") rather than shown as ids, so the
// summary never reads narrower than the target is.
export function scopeSummary(target: TargetFilters, repoNames: Map<string, string>) {
  const parts: string[] = []
  if (target.repositoryIds.length) {
    const names = target.repositoryIds.flatMap((id) => repoNames.get(id) ?? [])
    const count = target.repositoryIds.length
    const unknown = count - names.length
    if (!names.length) parts.push(`${count} ${count === 1 ? "repository" : "repositories"}`)
    else parts.push(unknown ? `${names.join(", ")} +${unknown}` : names.join(", "))
  }
  if (target.minSeverity) parts.push(`≥ ${target.minSeverity}`)
  if (target.onlyVerdictChanges) parts.push("verdict changes")
  return parts.length ? parts.join(" · ") : null
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

export function hourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`
}

// "Weekly digest · Mon 09:00 Europe/Berlin · 3 reviews held", or null for a
// target that sends each review on its own.
export function deliverySummary(target: { delivery: TargetDelivery }) {
  const { mode, hour, weekday, timeZone, held } = target.delivery
  if (mode === "each" || hour === null) return null
  const day = mode === "weekly" && weekday !== null ? `${WEEKDAYS[weekday]!.slice(0, 3)} ` : ""
  const parts = [`${mode === "daily" ? "Daily" : "Weekly"} digest`, `${day}${hourLabel(hour)} ${timeZone ?? "UTC"}`]
  if (held > 0) parts.push(`${plural(held, "review")} held`)
  return parts.join(" · ")
}
