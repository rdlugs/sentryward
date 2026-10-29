import { useState } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router"
import { AlertTriangle, ArrowLeft, Bot, Copy, Download, ExternalLink, History, Loader2, OctagonX, RotateCw } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { allFindingsPrompt } from "@/features/reviews/agentPrompt"
import { useCancelReview, useRerunReview, useReview } from "@/features/reviews/api"
import { StatusBadge, VerdictBadge } from "@/features/reviews/badges"
import { CancelReviewDialog } from "@/features/reviews/CancelReviewDialog"
import { FindingsSection } from "@/features/reviews/detail/FindingsSection"
import { ReviewProblemActions } from "@/features/reviews/detail/ReviewProblem"
import { ReviewProgress } from "@/features/reviews/detail/ReviewProgress"
import { ReviewSidebar } from "@/features/reviews/detail/ReviewSidebar"
import { WalkthroughCard } from "@/features/reviews/detail/WalkthroughCard"
import { PROVIDERS } from "@/features/forge/providers"
import { changeLabel } from "@/features/reviews/links"
import { copyToClipboard } from "@/lib/clipboard"
import { isActive, type ReviewResult } from "@/features/reviews/types"
import { useReviewMarkdown } from "@/features/reviews/useReviewMarkdown"

// Back to the list this review was opened from, filters and page included,
// when that was the reviews list; otherwise to the list unfiltered.
function BackToReviews() {
  const from: unknown = useLocation().state?.from
  const to = typeof from === "string" && from.split("?")[0] === "/reviews" ? from : "/reviews"
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2.5 self-start text-muted-foreground">
      <Link to={to}>
        <ArrowLeft />
        Back to reviews
      </Link>
    </Button>
  )
}

function ResultView({ result }: { result: ReviewResult }) {
  const notes = [...result.errors, ...result.warnings]
  return (
    <>
      {notes.length > 0 && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>{result.status === "completed" ? "Notes" : "This review is incomplete"}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {result.walkthrough && (
        <WalkthroughCard walkthrough={result.walkthrough} provider={result.change.provider} files={result.files} />
      )}
      <FindingsSection result={result} />
    </>
  )
}

export function ReviewDetailPage() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const from: unknown = useLocation().state?.from
  const { data, isPending, isError } = useReview(id)
  const rerun = useRerunReview()
  const cancel = useCancelReview()
  const [cancelling, setCancelling] = useState(false)
  const markdown = useReviewMarkdown(id)

  if (isPending) {
    return (
      <PageShell>
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </PageShell>
    )
  }
  if (isError) {
    return (
      <PageShell>
        <BackToReviews />
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Review not found.</AlertTitle>
          <AlertDescription>
            <p>The link may be wrong, or the review belongs to another workspace.</p>
            <Button size="sm" variant="outline" asChild className="mt-1">
              <Link to="/reviews">View all reviews</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </PageShell>
    )
  }

  const { review } = data
  const result = review.result?.schemaVersion === 1 ? review.result : null
  const title = review.title ?? review.summary?.title ?? result?.change.title ?? review.repository.fullPath
  const webUrl = review.summary?.webUrl ?? result?.change.webUrl

  async function runAgain() {
    try {
      const { review: next } = await rerun.mutateAsync(review.id)
      // Carries the list it was opened from, so Back to reviews still returns there.
      navigate(`/reviews/${next.id}`, { state: { from } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start a new review")
    }
  }

  async function stop() {
    try {
      await cancel.mutateAsync(review.id)
      setCancelling(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel the review")
    }
  }

  return (
    <PageShell>
      <BackToReviews />
      <PageHeader
        title={title}
        description={
          <>
            {review.repository.fullPath} {changeLabel(review.repository.provider, review.number)}
            {webUrl && (
              <>
                {" · "}
                <a href={webUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                  Open on {PROVIDERS[review.repository.provider].label}
                  <ExternalLink className="size-3" />
                </a>
              </>
            )}
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => result && copyToClipboard(allFindingsPrompt(result.findings), "Agent prompt")}
              disabled={!result?.findings.length}
            >
              <Bot />
              Copy prompt for all findings
            </Button>
            <Button variant="outline" onClick={markdown.copy} disabled={!result || markdown.copying}>
              {markdown.copying ? <Loader2 className="animate-spin" /> : <Copy />}
              Copy markdown
            </Button>
            <Button variant="outline" onClick={markdown.download} disabled={!result || markdown.downloading}>
              {markdown.downloading ? <Loader2 className="animate-spin" /> : <Download />}
              Download markdown
            </Button>
            <Button variant="outline" onClick={runAgain} disabled={rerun.isPending || isActive(review.status)}>
              {rerun.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
              Re-run
            </Button>
            {isActive(review.status) && (
              <Button variant="destructive" onClick={() => setCancelling(true)} disabled={cancel.isPending}>
                <OctagonX />
                Cancel
              </Button>
            )}
          </>
        }
      >
        <div className="flex items-center gap-2 pt-1">
          <StatusBadge status={review.status} />
          <VerdictBadge verdict={review.verdict} />
        </div>
      </PageHeader>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {isActive(review.status) ? (
            <ReviewProgress review={review} />
          ) : result ? (
            // Keyed so a re-run navigating here starts with fresh collapse state.
            <ResultView key={review.id} result={result} />
          ) : review.resultExpiredAt ? (
            <Alert>
              <History />
              <AlertTitle>The full result has expired</AlertTitle>
              <AlertDescription>
                <p>
                  Cleared on {new Date(review.resultExpiredAt).toLocaleDateString()} under this server's retention
                  setting. The review's status and verdict are kept
                  {review.status === "failed" ? "." : ", and its findings are still listed on the Findings page."}
                </p>
                {review.error && <p>{review.error}</p>}
                <ReviewProblemActions review={review} onRerun={runAgain} rerunning={rerun.isPending} />
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant={review.status === "failed" ? "destructive" : "default"}>
              <AlertTriangle />
              <AlertTitle>
                {review.status === "superseded"
                  ? "Superseded by a newer push"
                  : review.status === "skipped"
                    ? "Skipped"
                    : review.status === "cancelled"
                      ? "Cancelled"
                      : "The review did not run"}
              </AlertTitle>
              <AlertDescription>
                {review.error && <p className="whitespace-pre-line">{review.error}</p>}
                <ReviewProblemActions review={review} onRerun={runAgain} rerunning={rerun.isPending} />
              </AlertDescription>
            </Alert>
          )}
        </div>
        <ReviewSidebar review={review} result={result} />
      </div>
      <CancelReviewDialog
        review={review}
        open={cancelling}
        onOpenChange={setCancelling}
        onConfirm={stop}
        pending={cancel.isPending}
      />
    </PageShell>
  )
}
