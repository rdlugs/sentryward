import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError, workspaceHeaders } from "@/lib/api"
import { isActive, type JobStatus, type OpenChange, type ReviewDetail, type ReviewListItem, type ReviewStats, type Trigger, type Verdict } from "./types"

// While anything is queued or running, poll; otherwise stay quiet.
const POLL_MS = 3000

export interface ReviewPage {
  reviews: ReviewListItem[]
  total: number
  page: number
  limit: number
}

export interface ReviewQuery {
  repoId?: string
  number?: number
  status?: JobStatus
  verdict?: Verdict
  trigger?: Trigger
  q?: string
  view?: "changes" | "runs"
  includeSuperseded?: boolean
  page?: number
  limit?: number
}

// Only set params go into the URL, in a fixed order so query keys and stubs
// stay predictable.
function reviewSearch(params: ReviewQuery) {
  const search = new URLSearchParams()
  for (const key of ["repoId", "number", "status", "verdict", "trigger", "q", "view"] as const) {
    if (params[key]) search.set(key, String(params[key]))
  }
  if (params.includeSuperseded) search.set("includeSuperseded", "true")
  if (params.page) search.set("page", String(params.page))
  if (params.limit) search.set("limit", String(params.limit))
  return search.toString()
}

export function useReviews(params: ReviewQuery = {}) {
  const query = reviewSearch(params)
  return useQuery({
    queryKey: ["reviews", params],
    queryFn: () => api<ReviewPage>(`/reviews${query ? `?${query}` : ""}`),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.reviews.some((r) => isActive(r.status)) ? POLL_MS : false),
  })
}

// Under the "reviews" key, so queueing or rerunning a review refreshes it too.
export function useReviewStats() {
  return useQuery({
    queryKey: ["reviews", "stats"],
    queryFn: () => api<ReviewStats>("/reviews/stats"),
  })
}

export interface ReviewAttention {
  // Failed runs since the caller last opened the Reviews list (or the last day).
  failed: number
  since: string
}

// For the sidebar badge. Under the "reviews" key so queueing or rerunning
// refreshes it, and polled slowly so failures show up without a reload.
export function useReviewAttention() {
  return useQuery({
    queryKey: ["reviews", "attention"],
    queryFn: () => api<ReviewAttention>("/reviews/attention"),
    refetchInterval: 60_000,
  })
}

// The visit is stored on the server, so the badge clears on every device. The
// workspace is passed in, not read from the selection: leaving the list on a
// switch must mark the workspace that was open. Refetched rather than zeroed,
// so a poll already in flight cannot restore the old count.
export function useMarkReviewsViewed() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (workspaceId: string) =>
      api<void>("/reviews/viewed", { method: "POST", headers: workspaceHeaders(workspaceId) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reviews", "attention"], exact: true }),
  })
}

export function useReview(id: string) {
  return useQuery({
    queryKey: ["review", id],
    queryFn: () => api<{ review: ReviewDetail }>(`/reviews/${id}`),
    refetchInterval: (q) => (q.state.data && isActive(q.state.data.review.status) ? POLL_MS : false),
  })
}

// A pasted link, or a change picked from a repository's open ones.
export type CreateReviewInput = { url: string } | { repoId: string; number: number }

// Why a pasted link was refused: the server's message for the url field when
// there is one. Shared by the review URL form and the command palette.
export function reviewUrlErrorMessage(err: unknown) {
  return err instanceof ApiError ? (err.fieldErrors?.url?.[0] ?? err.message) : "Could not queue the review"
}

export function useCreateReview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateReviewInput) =>
      api<{ review: ReviewListItem }>("/reviews", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reviews"] }),
  })
}

// Read live from the forge, so only while a repository is picked.
export function useOpenChanges(repoId: string | undefined) {
  return useQuery({
    queryKey: ["repos", repoId, "changes"],
    queryFn: () => api<{ changes: OpenChange[] }>(`/repos/${repoId}/changes`),
    enabled: Boolean(repoId),
  })
}

export function useRerunReview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<{ review: ReviewListItem }>(`/reviews/${id}/rerun`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reviews"] }),
  })
}

export function useCancelReview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<{ review: ReviewListItem }>(`/reviews/${id}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reviews"] }),
  })
}

export async function fetchReviewMarkdown(id: string): Promise<string> {
  const res = await fetch(`/api/reviews/${id}/markdown`, { credentials: "include", headers: workspaceHeaders() })
  if (!res.ok) throw new Error("Could not load the markdown")
  return res.text()
}
