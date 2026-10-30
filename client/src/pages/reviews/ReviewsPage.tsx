import { useEffect, useMemo } from "react"
import { AlertTriangle, Play } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import {
  ActiveFilterChips,
  FilterPopover,
  FilterSelect,
  FilterToolbar,
  SearchInput,
  type ActiveFilter,
} from "@/components/TableFilters"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { TablePagination } from "@/components/TablePagination"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDebounced } from "@/hooks/use-debounced"
import { usePagination } from "@/hooks/use-pagination"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { ALL, choices, only, selectedLabel } from "@/lib/filters"
import { ME_QUERY_KEY } from "@/features/auth/auth-context"
import { useAuth } from "@/features/auth/useAuth"
import { useRepos } from "@/features/forge/api"
import { useMarkReviewsViewed, useReviews, type ReviewQuery } from "@/features/reviews/api"
import { STATUS_OPTIONS, TRIGGER_OPTIONS, VERDICT_OPTIONS } from "@/features/reviews/options"
import { ReviewStatsStrip } from "@/features/reviews/ReviewStatsStrip"
import { useStartManualReview } from "@/features/reviews/useStartManualReview"
import { ReviewsTable } from "@/features/reviews/ReviewsTable"

type View = "changes" | "runs"

const DEFAULTS = { view: "changes", status: ALL, verdict: ALL, trigger: ALL, repo: ALL, superseded: "", q: "" }

// Repository ids are not checked: a stale one just matches nothing.
const ALLOWED = {
  view: ["changes", "runs"],
  status: choices(STATUS_OPTIONS),
  verdict: choices(VERDICT_OPTIONS),
  trigger: choices(TRIGGER_OPTIONS),
  superseded: ["", "true"],
}

export function ReviewsPage() {
  const pagination = usePagination()
  // In the URL, so Back from a review restores the list and a link shares it.
  const { values, set } = useUrlFilters(DEFAULTS, { allowed: ALLOWED })
  const { status, verdict, trigger, repo, q: query } = values
  const view = values.view as View
  const includeSuperseded = values.superseded === "true"
  const startReview = useStartManualReview()
  const q = useDebounced(query.trim())

  // Clears the sidebar's failed-review badge. Marked again on leaving, so runs
  // that fail while the list is open do not light it up afterwards. Leaving on
  // a workspace switch marks the one that was open; leaving on logout has no
  // session to mark with.
  const queryClient = useQueryClient()
  const workspaceId = useAuth().workspace?.id
  const { mutate: markViewed } = useMarkReviewsViewed()
  useEffect(() => {
    if (!workspaceId) return
    markViewed(workspaceId)
    return () => {
      if (queryClient.getQueryData(ME_QUERY_KEY)) markViewed(workspaceId)
    }
  }, [markViewed, queryClient, workspaceId])

  const repos = useRepos()
  const repoOptions = useMemo(
    () =>
      (repos.data?.repos ?? [])
        .map((r) => ({ value: r.id, label: r.fullPath }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [repos.data],
  )

  const params: ReviewQuery = {
    view,
    status: only<NonNullable<ReviewQuery["status"]>>(status),
    verdict: only<NonNullable<ReviewQuery["verdict"]>>(verdict),
    trigger: only<NonNullable<ReviewQuery["trigger"]>>(trigger),
    repoId: only(repo),
    q: q || undefined,
    includeSuperseded,
    page: pagination.page,
    limit: pagination.size,
  }
  const { data, isPending, isError } = useReviews(params)
  // A page past the end (e.g. a stale link) falls back to the last real page.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / pagination.size)) : 1
  useEffect(() => {
    if (pagination.page > lastPage) pagination.setPage(lastPage)
  }, [pagination, lastPage])

  const filtering = status !== ALL || verdict !== ALL || trigger !== ALL || repo !== ALL || includeSuperseded
  const narrowed = filtering || q !== ""
  const emptyMessage = narrowed
    ? "No reviews match your filters."
    : "No reviews yet. Start a manual review to run the first one."

  // A new filter, search or view starts over at the first page (useUrlFilters does that).
  const setStatus = (value: string) => set({ status: value })
  const setVerdict = (value: string) => set({ verdict: value })
  const setTrigger = (value: string) => set({ trigger: value })
  const setRepo = (value: string) => set({ repo: value })
  const setIncludeSuperseded = (value: boolean) => set({ superseded: value ? "true" : "" })

  function clearFilters() {
    set({ status: ALL, verdict: ALL, trigger: ALL, repo: ALL, superseded: "" })
  }

  const activeFilters = [
    { label: "Status", value: selectedLabel(status, STATUS_OPTIONS), onRemove: () => setStatus(ALL) },
    { label: "Verdict", value: selectedLabel(verdict, VERDICT_OPTIONS), onRemove: () => setVerdict(ALL) },
    { label: "Trigger", value: selectedLabel(trigger, TRIGGER_OPTIONS), onRemove: () => setTrigger(ALL) },
    { label: "Repository", value: selectedLabel(repo, repoOptions), onRemove: () => setRepo(ALL) },
    {
      label: "Superseded",
      value: includeSuperseded ? "Shown" : null,
      onRemove: () => setIncludeSuperseded(false),
    },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return (
    <PageShell>
      <PageHeader
        title="Reviews"
        description="Every review Sentryward has run on your pull and merge requests."
      />
      <ReviewStatsStrip />
      <FilterToolbar>
        <Tabs value={view} onValueChange={(value) => set({ view: value })} className="mr-auto">
          <TabsList>
            <TabsTrigger value="changes">By change</TabsTrigger>
            <TabsTrigger value="runs">All runs</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button onClick={startReview}>
          <Play />
          Manual review
        </Button>
        <ActiveFilterChips filters={activeFilters} />
        <FilterPopover active={filtering} onClear={clearFilters}>
          <FilterSelect
            id="review-status"
            label="Status"
            allLabel="All statuses"
            value={status}
            onValueChange={setStatus}
            options={STATUS_OPTIONS}
          />
          <FilterSelect
            id="review-verdict"
            label="Verdict"
            allLabel="All verdicts"
            value={verdict}
            onValueChange={setVerdict}
            options={VERDICT_OPTIONS}
          />
          <FilterSelect
            id="review-trigger"
            label="Trigger"
            allLabel="All triggers"
            value={trigger}
            onValueChange={setTrigger}
            options={TRIGGER_OPTIONS}
          />
          {repoOptions.length > 1 && (
            <FilterSelect
              id="review-repo"
              label="Repository"
              allLabel="All repositories"
              value={repo}
              onValueChange={setRepo}
              options={repoOptions}
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="review-superseded" className="text-xs text-muted-foreground">
              Show superseded runs
            </Label>
            <Switch
              id="review-superseded"
              checked={includeSuperseded}
              onCheckedChange={setIncludeSuperseded}
            />
          </div>
        </FilterPopover>
        <SearchInput label="Search reviews" value={query} onChange={(value) => set({ q: value })} />
      </FilterToolbar>
      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load reviews.</AlertTitle>
        </Alert>
      ) : (
        <Card>
          <CardContent>
            <ReviewsTable
              reviews={data.reviews}
              actions
              grouped={view === "changes"}
              emptyMessage={emptyMessage}
            />
            {data.total > 0 && (
              <TablePagination
                page={Math.min(pagination.page, lastPage)}
                size={pagination.size}
                total={data.total}
                onPageChange={pagination.setPage}
                onSizeChange={pagination.setSize}
              />
            )}
          </CardContent>
        </Card>
      )}
    </PageShell>
  )
}
