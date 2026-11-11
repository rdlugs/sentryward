import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError } from "@/lib/api"

// Also invalidated by removing a repository or connection, which edits targets
// on the server (their repositories, and a pause when none are left).
export const NOTIFICATIONS_KEY = ["notifications"]

// A field error says why a save was refused (e.g. a scope-paused target cannot
// be resumed); the top-level message is only "Validation failed".
export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    const first = Object.values(error.fieldErrors ?? {}).flat()[0]
    return first ?? error.message
  }
  return error instanceof Error ? error.message : fallback
}

export type NotificationKind = "webhook" | "slack" | "email"
export type NotificationEvent = "blocked" | "failed" | "resolved" | "completed"

export const EVENT_OPTIONS: { value: NotificationEvent; label: string; description: string }[] = [
  { value: "blocked", label: "Blocked", description: "A review found blocking issues" },
  {
    value: "resolved",
    label: "Resolved",
    description: "A review passes after the previous review of the same pull or merge request was blocked",
  },
  { value: "failed", label: "Failed", description: "A review could not run or finish" },
  { value: "completed", label: "Completed", description: "Any finished review, blocked or not" },
]

// The least severe finding a review needs for a target to hear about it; null
// is any. Failed and resolved deliveries ignore it.
export type MinSeverity = "minor" | "major" | "critical"

export const MIN_SEVERITY_LABELS: Record<MinSeverity, string> = {
  minor: "Minor",
  major: "Major",
  critical: "Critical",
}

// Which reviews a target hears about, beyond its events.
export interface TargetFilters {
  // Empty means every repository in the workspace.
  repositoryIds: string[]
  minSeverity: MinSeverity | null
  // Blocked and completed deliveries only when the verdict differs from the
  // previous review of the same change.
  onlyVerdictChanges: boolean
}

export const KIND_LABELS: Record<NotificationKind, string> = {
  webhook: "Webhook",
  slack: "Slack",
  email: "Email",
}

// How a target gets reviews: one delivery each, or a digest at hour:00 in its
// own timezone, every day or once a week (weekday 0 is Sunday).
export type DeliveryMode = "each" | "daily" | "weekly"

export type DeliverySettings =
  | { mode: "each" }
  | { mode: "daily"; hour: number; timeZone: string }
  | { mode: "weekly"; hour: number; weekday: number; timeZone: string }

export interface TargetDelivery {
  mode: DeliveryMode
  // Kept after switching back to each review, so the form can offer them again.
  hour: number | null
  weekday: number | null
  timeZone: string | null
  // When the next digest is built; null when sending each review.
  nextDigestAt: string | null
  // Reviews waiting for the next digest.
  held: number
}

// Pending: queued, or waiting to be retried after a failed attempt.
export type DeliveryStatus = "pending" | "sent" | "failed"

// The server's MAX_DELIVERY_ATTEMPTS: a delivery is sent at most this often.
export const MAX_DELIVERY_ATTEMPTS = 5
// A NotificationEvent, "test" for a delivery sent from the dashboard, or
// "digest" for a daily or weekly digest.
export type DeliveryEvent = NotificationEvent | "test" | "digest"

export interface LastDelivery {
  status: DeliveryStatus
  event: DeliveryEvent
  // Set when the far end answered with a non-2xx status.
  httpStatus: number | null
  // Never contains the target URL; the server redacts it before storing.
  error: string | null
  // Sends started so far; 0 while a delivery is queued for its first.
  attempts: number
  // When a pending delivery is next tried; null once it is sent or failed.
  nextAttemptAt: string | null
  createdAt: string
}

// A queued delivery that already failed at least once and is due again.
export interface PendingRetry {
  attempts: number
  httpStatus: number | null
  error: string | null
  nextAttemptAt: string | null
}

// What a target still has queued. Kept apart from lastDelivery, since a newer
// delivery (a test, or a later review) can go through while an older one is
// still being retried.
export interface PendingDeliveries {
  count: number
  // The retry due soonest; null when every queued delivery is still untried.
  retry: PendingRetry | null
}

export interface NotificationDelivery extends LastDelivery {
  id: string
  // Null for test deliveries, and once the review itself was pruned.
  jobId: string | null
  // Null while pending.
  finishedAt: string | null
}

export interface NotificationTarget extends TargetFilters {
  id: string
  kind: NotificationKind
  name: string
  events: NotificationEvent[]
  // Only the host of a URL leaves the server; null for email targets.
  host: string | null
  // Saved under a different server ENCRYPTION_KEY; only adding it again helps.
  undecryptable: boolean
  recipientIds: string[]
  delivery: TargetDelivery
  // A paused target keeps its settings but gets no deliveries.
  active: boolean
  // Why the server paused it after failed deliveries; null otherwise, and
  // cleared when an admin switches the target.
  pausedReason: string | null
  // "gone" when the endpoint said it no longer exists, "failures" when the
  // limit was reached, "scope" when every repository it was limited to was
  // removed; null when not auto-paused.
  pauseCause: "gone" | "failures" | "scope" | null
  // Deliveries in a row that failed for good; a success resets it.
  consecutiveFailures: number
  // Null until the target gets its first delivery (tests included).
  lastDelivery: LastDelivery | null
  pending: PendingDeliveries
  createdAt: string
  updatedAt: string
}

export type NotificationTargetInput = TargetFilters & { delivery: DeliverySettings } &
  (
    | { kind: "webhook" | "slack"; name: string; events: NotificationEvent[]; url: string }
    | { kind: "email"; name: string; events: NotificationEvent[]; recipientIds: string[] }
  )

export interface NotificationTargetUpdate extends Partial<TargetFilters> {
  name?: string
  events?: NotificationEvent[]
  recipientIds?: string[]
  delivery?: DeliverySettings
  active?: boolean
}

export interface NotificationSettings {
  // Failed deliveries in a row that pause a target; 0 never does.
  autoPauseAfter: number
}

export type TestResult = { ok: true } | { ok: false; error: string }

// How often the list refreshes while a delivery is waiting to be sent, so a
// retry's outcome shows up without a reload.
const PENDING_POLL_MS = 30_000

export function useNotificationTargets() {
  return useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () =>
      api<{ targets: NotificationTarget[]; mailConfigured: boolean; settings: NotificationSettings }>("/notifications"),
    refetchInterval: (query) =>
      query.state.data?.targets.some((target) => target.pending.count > 0) ? PENDING_POLL_MS : false,
  })
}

export function useUpdateNotificationSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: NotificationSettings) =>
      api<{ settings: NotificationSettings }>("/notifications/settings", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  })
}

// A webhook's signing secret comes back only from this call.
export function useCreateNotificationTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: NotificationTargetInput) =>
      api<{ target: NotificationTarget; secret?: string }>("/notifications", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  })
}

export function useUpdateNotificationTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: NotificationTargetUpdate & { id: string }) =>
      api<{ target: NotificationTarget }>(`/notifications/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  })
}

// A test is recorded like any delivery, so the list's last delivery and an open
// history both refetch afterwards, whatever the outcome.
export function useTestNotificationTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ result: TestResult }>(`/notifications/${id}/test`, { method: "POST" }).then((body) => body.result),
    onSettled: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  })
}

export function useNotificationDeliveries(id: string, page: number, limit: number) {
  return useQuery({
    queryKey: [...NOTIFICATIONS_KEY, id, "deliveries", { page, limit }],
    queryFn: () =>
      api<{ deliveries: NotificationDelivery[]; total: number; page: number; limit: number }>(
        `/notifications/${id}/deliveries?page=${page}&limit=${limit}`,
      ),
    // Keeps the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  })
}

export function useDeleteNotificationTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/notifications/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  })
}
