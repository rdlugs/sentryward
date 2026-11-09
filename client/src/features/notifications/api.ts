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

export type DeliveryStatus = "sent" | "failed"
// A NotificationEvent, or "test" for a delivery sent from the dashboard.
export type DeliveryEvent = NotificationEvent | "test"

export interface LastDelivery {
  status: DeliveryStatus
  event: DeliveryEvent
  // Set when the far end answered with a non-2xx status.
  httpStatus: number | null
  // Never contains the target URL; the server redacts it before storing.
  error: string | null
  createdAt: string
}

export interface NotificationDelivery extends LastDelivery {
  id: string
  attempts: number
  // Null for test deliveries, and once the review itself was pruned.
  jobId: string | null
  finishedAt: string
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

export type TestResult = { ok: true } | { ok: false; error: string }

export function useNotificationTargets() {
  return useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => api<{ targets: NotificationTarget[]; mailConfigured: boolean }>("/notifications"),
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
