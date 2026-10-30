import { Fragment, useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router"
import { ChevronRight, Copy, ExternalLink, MoreHorizontal, OctagonX, RotateCw } from "lucide-react"
import { toast } from "sonner"
import { NoMatchesRow } from "@/components/TableFilters"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PROVIDERS } from "@/features/forge/providers"
import { useIsBelowSm } from "@/hooks/use-mobile"
import { rowClick } from "@/lib/rowClick"
import { formatDuration, timeAgo } from "@/lib/time"
import { cn } from "@/lib/utils"
import { useCancelReview, useRerunReview, useReviews } from "./api"
import { SeverityBadge, StatusBadge, TriggerIcon, VerdictBadge } from "./badges"
import { CancelReviewDialog } from "./CancelReviewDialog"
import { changeLabel, changeTitle } from "./links"
import { RerunReviewDialog } from "./RerunReviewDialog"
import { isActive, SEVERITIES, type ReviewListItem } from "./types"
import { useReviewMarkdown } from "./useReviewMarkdown"

// Remembers the list it was opened from (`from`, read once by the table), so
// the review's back link returns to it with the same filters and page (see
// BackToReviews).
function ReviewLink(props: { id: string; from: string; className?: string; children: ReactNode }) {
  return (
    <Link to={`/reviews/${props.id}`} state={{ from: props.from }} className={props.className}>
      {props.children}
    </Link>
  )
}

// Ticks only while something is running, so idle tables never re-render.
function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

function FindingCounts({ review }: { review: ReviewListItem }) {
  const summary = review.summary
  if (!summary) return <span className="text-muted-foreground">-</span>
  if (summary.total === 0) return <span className="text-muted-foreground">None</span>
  return (
    <div className="flex flex-wrap gap-1">
      {SEVERITIES.filter((s) => summary.bySeverity[s]).map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <SeverityBadge severity={s} />
          <span className="text-xs tabular-nums">{summary.bySeverity[s]}</span>
        </span>
      ))}
    </div>
  )
}

function Duration({ review, now }: { review: ReviewListItem; now: number }) {
  if (!review.startedAt) return null
  const start = new Date(review.startedAt).getTime()
  if (review.status === "running") return <div className="text-xs">running for {formatDuration(now - start)}</div>
  if (!review.finishedAt) return null
  return <div className="text-xs">took {formatDuration(new Date(review.finishedAt).getTime() - start)}</div>
}

function ReviewActions({ review }: { review: ReviewListItem }) {
  const rerun = useRerunReview()
  const cancel = useCancelReview()
  const [confirming, setConfirming] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const markdown = useReviewMarkdown(review.id)
  const forge = PROVIDERS[review.repository.provider].label
  const webUrl = review.summary?.webUrl

  async function runAgain() {
    try {
      await rerun.mutateAsync(review.id)
      toast.success("Review queued")
      setConfirming(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start a new review")
    }
  }

  async function stop() {
    try {
      await cancel.mutateAsync(review.id)
      toast.success("Review cancelled")
      setCancelling(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel the review")
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${changeTitle(review)}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
        <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
          <DropdownMenuItem onSelect={() => setConfirming(true)} disabled={rerun.isPending || isActive(review.status)}>
            <RotateCw />
            Re-run
          </DropdownMenuItem>
          {isActive(review.status) && (
            <DropdownMenuItem onSelect={() => setCancelling(true)} disabled={cancel.isPending} variant="destructive">
              <OctagonX />
              Cancel review
            </DropdownMenuItem>
          )}
          {/* A summary is only stored alongside a result, which the markdown is rendered from. */}
          <DropdownMenuItem onSelect={markdown.copy} disabled={!review.summary}>
            <Copy />
            Copy markdown
          </DropdownMenuItem>
          {webUrl && (
            <DropdownMenuItem asChild>
              <a href={webUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open on {forge}
              </a>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* A sibling of the menu, not inside it, so it stays mounted after the menu closes. */}
      <RerunReviewDialog
        review={review}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={runAgain}
        pending={rerun.isPending}
      />
      <CancelReviewDialog
        review={review}
        open={cancelling}
        onOpenChange={setCancelling}
        onConfirm={stop}
        pending={cancel.isPending}
      />
    </>
  )
}

// Earlier runs of one change, loaded when its row or card is expanded.
function RunHistoryList({ review, from }: { review: ReviewListItem; from: string }) {
  const { data, isPending, isError } = useReviews({
    repoId: review.repository.id,
    number: review.number,
    view: "runs",
    includeSuperseded: true,
    limit: 20,
  })
  const runs = data?.reviews.filter((run) => run.id !== review.id) ?? []

  if (isPending) return <Skeleton className="h-6 w-full" />
  if (isError) return <p className="text-sm text-destructive">Could not load earlier runs.</p>
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No earlier runs.</p>
  return (
    <ul className="flex flex-col gap-1.5" aria-label={`Earlier runs of ${changeTitle(review)}`}>
      {runs.map((run) => (
        <li key={run.id} className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={run.status} reason={run.error} />
          <VerdictBadge verdict={run.verdict} />
          <TriggerIcon trigger={run.trigger} />
          <ReviewLink id={run.id} from={from} className="hover:underline">
            <code>{run.headSha.slice(0, 7)}</code>
          </ReviewLink>
          <span className="text-muted-foreground">{timeAgo(run.createdAt)}</span>
        </li>
      ))}
    </ul>
  )
}

function RunHistory({ review, colSpan, from }: { review: ReviewListItem; colSpan: number; from: string }) {
  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={colSpan} className="py-2 pl-10">
        <RunHistoryList review={review} from={from} />
      </TableCell>
    </TableRow>
  )
}

function ForgeLink({ review }: { review: ReviewListItem }) {
  const webUrl = review.summary?.webUrl
  if (!webUrl) return null
  return (
    <a
      href={webUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open on ${PROVIDERS[review.repository.provider].label}`}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <ExternalLink className="size-3.5" />
    </a>
  )
}

function RunsToggle({ runs, open, onToggle }: { runs: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mt-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      {runs} runs
    </button>
  )
}

// Below `sm` the columns become a stacked card per review, so the list reflows
// at 320px instead of scrolling sideways (WCAG 1.4.10).
function ReviewCard({
  review,
  actions,
  grouped,
  open,
  onToggle,
  from,
  now,
}: {
  review: ReviewListItem
  actions: boolean
  grouped: boolean
  open: boolean
  onToggle: () => void
  from: string
  now: number
}) {
  const navigate = useNavigate()
  const runs = review.runCount ?? 1
  return (
    <li
      onClick={rowClick(() => navigate(`/reviews/${review.id}`, { state: { from } }))}
      className="flex cursor-pointer flex-col gap-2 border-b py-3 last:border-0"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <ReviewLink id={review.id} from={from} className="min-w-0 font-medium break-words hover:underline">
              {changeTitle(review)}
            </ReviewLink>
            <span className="mt-1 inline-flex">
              <ForgeLink review={review} />
            </span>
          </div>
          <div className="text-xs break-all text-muted-foreground">
            {review.repository.fullPath} {changeLabel(review.repository.provider, review.number)} ·{" "}
            <code>{review.headSha.slice(0, 7)}</code>
          </div>
        </div>
        {actions && <ReviewActions review={review} />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={review.status} reason={review.error} />
        <TriggerIcon trigger={review.trigger} />
        <VerdictBadge verdict={review.verdict} />
        <FindingCounts review={review} />
      </div>
      {review.error && <div className="text-xs break-words text-muted-foreground">{review.error}</div>}
      <div className="text-xs text-muted-foreground">
        Queued {timeAgo(review.createdAt)}
        <Duration review={review} now={now} />
      </div>
      {grouped && runs > 1 && (
        <div>
          <RunsToggle runs={runs} open={open} onToggle={onToggle} />
          {open && (
            <div className="mt-2 rounded-md bg-muted/30 p-2">
              <RunHistoryList review={review} from={from} />
            </div>
          )}
        </div>
      )}
    </li>
  )
}

export function ReviewsTable({
  reviews,
  actions = false,
  grouped = false,
  emptyMessage,
}: {
  reviews: ReviewListItem[]
  // Row menu (re-run, copy markdown, open on forge).
  actions?: boolean
  // Rows are the latest run per change; ones with more runs can expand.
  grouped?: boolean
  // Shown in place of rows; the headers stay so the table keeps its shape.
  emptyMessage: ReactNode
}) {
  const now = useNow(reviews.some((review) => review.status === "running"))
  const location = useLocation()
  const navigate = useNavigate()
  const from = location.pathname + location.search
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const colSpan = 5 + Number(actions)
  const cards = useIsBelowSm()

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (cards) {
    if (!reviews.length) return <p className="py-8 text-center text-muted-foreground">{emptyMessage}</p>
    return (
      <ul aria-label="Reviews">
        {reviews.map((review) => (
          <ReviewCard
            key={review.id}
            review={review}
            actions={actions}
            grouped={grouped}
            open={expanded.has(review.id)}
            onToggle={() => toggle(review.id)}
            from={from}
            now={now}
          />
        ))}
      </ul>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Change</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Verdict</TableHead>
          <TableHead>Findings</TableHead>
          <TableHead className="text-right">Queued</TableHead>
          {actions && <TableHead className="w-10" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {!reviews.length && <NoMatchesRow colSpan={colSpan}>{emptyMessage}</NoMatchesRow>}
        {reviews.map((review) => {
          const runs = review.runCount ?? 1
          const open = expanded.has(review.id)
          return (
            <Fragment key={review.id}>
              <TableRow
                onClick={rowClick(() => navigate(`/reviews/${review.id}`, { state: { from } }))}
                className="cursor-pointer"
              >
                <TableCell className="max-w-md">
                  <div className="flex items-center gap-1.5">
                    <ReviewLink id={review.id} from={from} className="truncate font-medium hover:underline">
                      {changeTitle(review)}
                    </ReviewLink>
                    <ForgeLink review={review} />
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {review.repository.fullPath} {changeLabel(review.repository.provider, review.number)} ·{" "}
                    <code>{review.headSha.slice(0, 7)}</code>
                  </div>
                  {review.error && <div className="truncate text-xs text-muted-foreground">{review.error}</div>}
                  {grouped && runs > 1 && (
                    <RunsToggle runs={runs} open={open} onToggle={() => toggle(review.id)} />
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={review.status} reason={review.error} />
                    <TriggerIcon trigger={review.trigger} />
                  </div>
                </TableCell>
                <TableCell>
                  <VerdictBadge verdict={review.verdict} />
                </TableCell>
                <TableCell>
                  <FindingCounts review={review} />
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {timeAgo(review.createdAt)}
                  <Duration review={review} now={now} />
                </TableCell>
                {actions && (
                  <TableCell>
                    <ReviewActions review={review} />
                  </TableCell>
                )}
              </TableRow>
              {grouped && open && <RunHistory review={review} colSpan={colSpan} from={from} />}
            </Fragment>
          )
        })}
      </TableBody>
    </Table>
  )
}
