import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"

const NOTIFICATIONS_KEY = ["notifications"]

export type NotificationKind = "webhook" | "slack" | "email"
export type NotificationEvent = "blocked" | "failed" | "completed"

export const EVENT_OPTIONS: { value: NotificationEvent; label: string; description: string }[] = [
  { value: "blocked", label: "Blocked", description: "A review found blocking issues" },
  { value: "failed", label: "Failed", description: "A review could not run or finish" },
  { value: "completed", label: "Completed", description: "Any finished review, blocked or not" },
]

export const KIND_LABELS: Record<NotificationKind, string> = {
  webhook: "Webhook",
  slack: "Slack",
  email: "Email",
}

// Pending: queued, or waiting to be retried after a failed attempt.
export type DeliveryStatus = "pending" | "sent" | "failed"

// The server's MAX_DELIVERY_ATTEMPTS: a delivery is sent at most this often.
export const MAX_DELIVERY_ATTEMPTS = 5
// A NotificationEvent, or "test" for a delivery sent from the dashboard.
export type DeliveryEvent = NotificationEvent | "test"

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

export interface NotificationDelivery extends LastDelivery {
  id: string
  // Null for test deliveries, and once the review itself was pruned.
  jobId: string | null
  // Null while pending.
  finishedAt: string | null
}

export interface NotificationTarget {
  id: string
  kind: NotificationKind
  name: string
  events: NotificationEvent[]
  // Only the host of a URL leaves the server; null for email targets.
  host: string | null
  // Saved under a different server ENCRYPTION_KEY; only adding it again helps.
  undecryptable: boolean
  recipientIds: string[]
  // A paused target keeps its settings but gets no deliveries.
  active: boolean
  // Why the server paused it after failed deliveries; null otherwise, and
  // cleared when an admin switches the target.
  pausedReason: string | null
  // "gone" when the endpoint said it no longer exists, "failures" when the
  // limit was reached; null when not auto-paused.
  pauseCause: "gone" | "failures" | null
  // Deliveries in a row that failed for good; a success resets it.
  consecutiveFailures: number
  // Null until the target gets its first delivery (tests included).
  lastDelivery: LastDelivery | null
  createdAt: string
  updatedAt: string
}

export type NotificationTargetInput =
  | { kind: "webhook" | "slack"; name: string; events: NotificationEvent[]; url: string }
  | { kind: "email"; name: string; events: NotificationEvent[]; recipientIds: string[] }

export interface NotificationTargetUpdate {
  name?: string
  events?: NotificationEvent[]
  recipientIds?: string[]
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
      query.state.data?.targets.some((target) => target.lastDelivery?.status === "pending") ? PENDING_POLL_MS : false,
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
