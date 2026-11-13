import { useMemo, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  FolderTree,
  History,
  Loader2,
  OctagonX,
  RotateCw,
} from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { allFindingsPrompt } from "@/features/reviews/agentPrompt"
import { useCancelReview, useRerunReview, useReview, useReviewChange, useReviewDiff } from "@/features/reviews/api"
import { StatusBadge, VerdictBadge } from "@/features/reviews/badges"
import { CancelReviewDialog } from "@/features/reviews/CancelReviewDialog"
import { branchesOf } from "@/features/reviews/detail/branches"
import { BranchPair, ForgeUserLink, RelativeTime } from "@/features/reviews/detail/ChangePeople"
import { FileDiff } from "@/features/reviews/detail/FileDiff"
import { FileTree } from "@/features/reviews/detail/FileTree"
import { buildFileTree, treeOrder } from "@/features/reviews/detail/fileTree"
import { FindingsSection } from "@/features/reviews/detail/FindingsSection"
import { ReviewProblemActions } from "@/features/reviews/detail/ReviewProblem"
import { ReviewProgress } from "@/features/reviews/detail/ReviewProgress"
import { ReviewSidebar } from "@/features/reviews/detail/ReviewSidebar"
import { WalkthroughCard } from "@/features/reviews/detail/WalkthroughCard"
import { PROVIDERS } from "@/features/forge/providers"
import { changeLabel } from "@/features/reviews/links"
import { copyToClipboard } from "@/lib/clipboard"
import { isActive, type ChangedFile, type Finding, type ReviewDetail, type ReviewResult } from "@/features/reviews/types"
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

// What the main column shows: one file's diff, or the overview. In the URL so
// a file can be linked and survives a reload: ?path=<file>, or ?view=overview.
// With neither, a queued or running review shows its progress (the overview)
// and any other opens the first file in the tree.
function useSelection(files: ChangedFile[] | undefined, overviewFirst: boolean) {
  const [params, setParams] = useSearchParams()
  const first = useMemo(() => (files ? (treeOrder(buildFileTree(files, []))[0]?.path ?? null) : null), [files])
  const path = params.get("path")
  const explicitOverview = params.get("view") === "overview"
  const known = path !== null && files?.some((f) => f.path === path)
  const selected = explicitOverview || overviewFirst ? (known ? path : null) : known ? path : first

  function select(next: string | null) {
    setParams((prev) => {
      const out = new URLSearchParams(prev)
      out.delete("path")
      out.delete("view")
      if (next === null) out.set("view", "overview")
      else out.set("path", next)
      return out
    })
    window.scrollTo({ top: 0 })
  }

  // A file asked for, or the first one, while the files are still loading.
  const waiting = files === undefined && !explicitOverview && (path !== null || !overviewFirst)
  return { selected, select, waiting }
}

// The change a review is about, for links and finding cards: the result's
// when there is one, else what the job itself records.
function changeOf(review: ReviewDetail, result: ReviewResult | null): ReviewResult["change"] {
  return (
    result?.change ?? {
      provider: review.repository.provider,
      host: review.repository.host,
      project: review.repository.fullPath,
      number: review.number,
      baseSha: review.baseSha ?? "",
      headSha: review.headSha,
      webUrl: review.summary?.webUrl,
      title: review.title ?? "",
      isDraft: false,
    }
  )
}

// A result written before diffs were kept has none of its files carrying a
// patch or a reason for missing one; its diff is then read from the forge.
function hasStoredDiffs(result: ReviewResult | null): result is ReviewResult {
  return !!result?.files.some((file) => file.patch !== undefined || file.patchOmitted !== undefined)
}

function ReviewView({
  review,
  result,
  overview,
  banner,
}: {
  review: ReviewDetail
  result: ReviewResult | null
  // What the review has to say for its status: progress, the result, or why
  // it did not run. Given a way to open a file, for the findings' paths.
  overview: (openFile: (path: string) => void) => ReactNode
  // Kept above a file's diff too, so a review's notes or failure are never out of sight.
  banner: ReactNode
}) {
  const stored = hasStoredDiffs(result)
  const fetched = useReviewDiff(review.id, !stored)
  const files = stored ? result.files : fetched.data?.files
  const findings = result?.findings ?? NO_FINDINGS
  const { selected, select, waiting } = useSelection(files, isActive(review.status))
  const [filesOpen, setFilesOpen] = useState(false)
  const file = selected === null ? undefined : files?.find((f) => f.path === selected)
  const fileFindings = useMemo(
    () => (file ? findings.filter((finding) => finding.file === file.path) : NO_FINDINGS),
    [file, findings],
  )
  const change = changeOf(review, result)

  const tree = (onPick?: () => void) =>
    files ? (
      <FileTree
        files={files}
        findings={findings}
        selected={selected}
        onSelect={(path) => {
          select(path)
          onPick?.()
        }}
      />
    ) : fetched.isError ? (
      <div role="status" className="flex flex-col items-start gap-2 px-2 text-sm text-muted-foreground">
        <p>Couldn't load the changes: {fetched.error.message}</p>
        <Button variant="outline" size="sm" onClick={() => void fetched.refetch()}>
          <RotateCw />
          Retry
        </Button>
      </div>
    ) : (
      <div aria-label="Loading changed files" className="flex flex-col gap-2 px-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    )

  return (
    <>
      <aside className="hidden lg:sticky lg:top-18 lg:block lg:max-h-[calc(100svh-5.5rem)] lg:overflow-y-auto">
        {tree()}
      </aside>
      <div className="flex min-w-0 flex-col gap-6">
        {/* Below lg the tree would push the diff out of sight, so it opens in a sheet. */}
        <Sheet open={filesOpen} onOpenChange={setFilesOpen}>
          <Button variant="outline" size="sm" className="self-start lg:hidden" onClick={() => setFilesOpen(true)}>
            <FolderTree />
            {file ? file.path.split("/").pop() : "Overview"}
            {files && <span className="text-muted-foreground">· {files.length} files</span>}
          </Button>
          <SheetContent side="left" className="w-80 overflow-y-auto p-3">
            <SheetHeader className="sr-only">
              <SheetTitle>Changed files</SheetTitle>
              <SheetDescription>Pick a file to see its diff, or the overview.</SheetDescription>
            </SheetHeader>
            {tree(() => setFilesOpen(false))}
          </SheetContent>
        </Sheet>
        {file ? (
          <>
            {banner}
            {/* Keyed so each file starts with its findings open again. */}
            <FileDiff key={file.path} file={file} findings={fileFindings} change={change} />
          </>
        ) : waiting && !fetched.isError ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          overview(select)
        )}
      </div>
    </>
  )
}

const NO_FINDINGS: Finding[] = []

function ResultNotes({ result }: { result: ReviewResult }) {
  const notes = [...result.errors, ...result.warnings]
  if (notes.length === 0) return null
  return (
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
  )
}

function ResultOverview({ result, onOpenFile }: { result: ReviewResult; onOpenFile: (path: string) => void }) {
  return (
    <>
      <ResultNotes result={result} />
      {result.walkthrough && (
        <WalkthroughCard walkthrough={result.walkthrough} provider={result.change.provider} files={result.files} />
      )}
      <FindingsSection result={result} onOpenFile={onOpenFile} />
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
  // Who opened the change, for the subtitle; the sidebar reads the same query.
  // Polled only while the review runs, which the review query decides.
  const changeDetails = useReviewChange(id, !!data && isActive(data.review.status))

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
  const opened = changeDetails.data?.change
  const branches = branchesOf(opened, result)

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

  const statusAlert = review.resultExpiredAt ? (
    <Alert>
      <History />
      <AlertTitle>The full result has expired</AlertTitle>
      <AlertDescription>
        <p>
          Cleared on {new Date(review.resultExpiredAt).toLocaleDateString()} under this server's retention setting.
          The review's status and verdict are kept
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
  )
  // Progress lives in the overview only: above a diff it would push the
  // change down on every poll.
  const active = isActive(review.status)
  const overview = (openFile: (path: string) => void) =>
    active ? <ReviewProgress review={review} /> : result ? <ResultOverview result={result} onOpenFile={openFile} /> : statusAlert
  const banner = active ? null : result ? <ResultNotes result={result} /> : statusAlert

  return (
    <PageShell>
      <BackToReviews />
      <PageHeader
        title={title}
        description={
          <>
            {review.repository.fullPath} {changeLabel(review.repository.provider, review.number)}
            {opened?.author && (
              <>
                {" · opened by "}
                <ForgeUserLink user={opened.author} /> <RelativeTime iso={opened.createdAt} />
              </>
            )}
            {branches.source && branches.target && (
              <>
                {" · "}
                <BranchPair source={branches.source} target={branches.target} />
              </>
            )}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  {/* Selecting an item closes the menu, so the trigger shows that an export is still running. */}
                  {markdown.copying || markdown.downloading ? <Loader2 className="animate-spin" /> : <Download />}
                  Export
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
                <DropdownMenuItem
                  onSelect={() => result && copyToClipboard(allFindingsPrompt(result.findings), "Agent prompt")}
                  disabled={!result?.findings.length}
                >
                  <Bot />
                  Copy prompt for all findings
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={markdown.copy} disabled={!result || markdown.copying}>
                  {markdown.copying ? <Loader2 className="animate-spin" /> : <Copy />}
                  Copy markdown
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={markdown.download} disabled={!result || markdown.downloading}>
                  {markdown.downloading ? <Loader2 className="animate-spin" /> : <Download />}
                  Download markdown
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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

      {/* Tree, diff and sidebar side by side only where all three fit; below
          xl the sidebar moves under them. */}
      <div className="grid items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_20rem]">
        {/* Keyed so a re-run navigating here starts with fresh collapse state. */}
        <ReviewView key={review.id} review={review} result={result} overview={overview} banner={banner} />
        <div className="lg:col-span-2 xl:col-span-1">
          <ReviewSidebar review={review} result={result} />
        </div>
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
