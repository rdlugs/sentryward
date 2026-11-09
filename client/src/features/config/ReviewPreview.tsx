import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import {
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  FileCode,
  GitPullRequest,
  MessageSquare,
  MessageSquareOff,
  RotateCcw,
} from "lucide-react"
import { SegmentedControl } from "@/components/SegmentedControl"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { PROVIDER_IDS, PROVIDERS } from "@/features/forge/providers"
import { changeLabel } from "@/features/reviews/links"
import { cn } from "@/lib/utils"
import {
  useConfigPreview,
  type ForgeProvider,
  type PreviewPublication,
  type PreviewRequest,
} from "./api"
import { ForgeMarkdown } from "./ForgeMarkdown"
import { CHANGE_ATTRIBUTE, HIGHLIGHT_MS, LEAVE_MS, pageChanges, type Change, type PageMarks } from "./previewChanges"

// What a review posts with the settings in the form, drawn as the PR/MR page
// it lands on. The content is not mocked here: the server runs the real
// pipeline and renderers on a sample change (server/src/review/preview), so
// every word matches what Sentryward would post.

type Inline = PreviewPublication["inline"][number]
type Status = NonNullable<PreviewPublication["status"]>

// Two forges fit side by side; a picker with many more would want a select again.
const FORGES = PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDERS[id].label, icon: PROVIDERS[id].icon }))

// The summary and the inline threads are previewed one at a time so neither
// is pushed below the fold by the other.
export type PreviewView = "summary" | "inline"
type View = PreviewView

const VIEWS: { value: View; label: string; icon: typeof MessageSquare }[] = [
  { value: "summary", label: "Summary", icon: MessageSquare },
  { value: "inline", label: "In-line", icon: FileCode },
]

// Stand-ins for the colours a project gives its labels.
const LABEL_COLOURS = [
  "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
]

function Avatar(props: { name: string; bot?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        props.bot ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {props.name[0]!.toUpperCase()}
    </span>
  )
}

// One entry in the conversation (GitHub) or activity (GitLab).
function Note(props: {
  provider: ForgeProvider
  label: string
  author: string
  bot?: boolean
  action: string
  children: ReactNode
  changed?: Change
}) {
  const github = props.provider === "github"
  const handle = github ? (props.bot ? `${props.author}[bot]` : props.author) : `@${props.author}`
  return (
    <section aria-label={props.label} {...{ [CHANGE_ATTRIBUTE]: props.changed }} className="flex gap-2">
      <Avatar name={props.author} bot={props.bot} />
      <div className={cn("min-w-0 flex-1 overflow-hidden border bg-background", github ? "rounded-md" : "rounded-sm")}>
        <header
          className={cn(
            "flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b px-3 py-1.5 text-xs",
            github ? "bg-muted/50" : "bg-background",
          )}
        >
          <span className="font-semibold">{github ? handle : props.author}</span>
          {!github && <span className="text-muted-foreground">{handle}</span>}
          {props.bot && github && <span className="rounded-full border px-1.5 text-[10px] text-muted-foreground">bot</span>}
          <span className="text-muted-foreground">{props.action}</span>
        </header>
        <div className="p-3">{props.children}</div>
      </div>
    </section>
  )
}

function DiffHunk({ comment }: { comment: Inline }) {
  return (
    <div className="overflow-hidden rounded-md border text-xs">
      <div className="border-b bg-muted/50 px-3 py-1.5 font-mono">{comment.path}</div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono">
          <tbody>
            {comment.diff.map((line) => (
              <tr key={line.newLine} className={line.type === "add" ? "bg-green-600/10" : undefined}>
                <td className="w-8 px-1 text-right text-muted-foreground select-none">{line.oldLine ?? ""}</td>
                <td className="w-8 px-1 text-right text-muted-foreground select-none">{line.newLine}</td>
                <td className="px-2 whitespace-pre">
                  {line.type === "add" ? "+" : " "}
                  {line.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function InlineThread(props: { provider: ForgeProvider; comment: Inline; flash?: number; upcoming?: string }) {
  const { comment, provider } = props
  const original = comment.diff
    .filter((line) => line.newLine >= comment.startLine && line.newLine <= comment.endLine)
    .map((line) => line.text)
  return (
    <div className="flex flex-col gap-2">
      <DiffHunk comment={comment} />
      <div className="ml-4 border-l-2 pl-3">
        <ForgeMarkdown provider={provider} original={original} flash={props.flash} upcoming={props.upcoming}>
          {comment.body}
        </ForgeMarkdown>
      </div>
    </div>
  )
}

const STATUS_TEXT: Record<ForgeProvider, Record<Status["state"], string>> = {
  github: { success: "Successful", failure: "Failing", error: "Errored", pending: "Pending" },
  gitlab: { success: "passed", failure: "failed", error: "failed", pending: "pending" },
}

function StatusRow(props: { provider: ForgeProvider; status: Status; changed?: Change }) {
  const { state } = props.status
  const Icon = state === "success" ? CircleCheck : state === "pending" ? Clock : CircleX
  const github = props.provider === "github"
  return (
    <section
      aria-label="Commit status"
      {...{ [CHANGE_ATTRIBUTE]: props.changed }}
      className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
    >
      <Icon className={cn("size-4 shrink-0", state === "success" ? "text-green-600" : "text-destructive")} />
      {github ? (
        <>
          <code className="text-xs font-semibold">sentryward/review</code>
          <span className="text-muted-foreground">
            {STATUS_TEXT.github[state]}: {props.status.description}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">
          External status <code className="text-xs font-semibold text-foreground">sentryward/review</code>{" "}
          {STATUS_TEXT.gitlab[state]}: {props.status.description}
        </span>
      )}
    </section>
  )
}

function PageHeader({ preview, highlight }: { preview: PreviewPublication; highlight?: Highlight }) {
  const { pr, provider } = preview
  const github = provider === "github"
  return (
    <header className="flex flex-col gap-2 border-b pb-3">
      <h4 className="text-base font-semibold">
        {pr.title} <span className="font-normal text-muted-foreground">{changeLabel(provider, pr.number)}</span>
      </h4>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 font-medium text-white",
            github ? "rounded-full bg-green-600" : "rounded-sm bg-sky-600",
          )}
        >
          {github ? <GitPullRequest className="size-3.5" /> : <CircleDot className="size-3.5" />}
          Open
        </span>
        <span>
          <strong className="text-foreground">{pr.author}</strong>{" "}
          {github ? (
            <>
              wants to merge into <code>{pr.targetBranch}</code> from <code>{pr.sourceBranch}</code>
            </>
          ) : (
            <>
              requested to merge <code>{pr.sourceBranch}</code> into <code>{pr.targetBranch}</code>
            </>
          )}
        </span>
      </div>
      {pr.labels.length > 0 && (
        <ul aria-label="Labels" className="flex flex-wrap gap-1">
          {pr.labels.map((label, i) => (
            <li
              key={label}
              {...{ [CHANGE_ATTRIBUTE]: highlight?.page.labels.has(label) ? highlight.mark : undefined }}
              className={cn(
                "border px-2 py-0.5 text-xs font-medium",
                github ? "rounded-full" : "rounded-sm",
                LABEL_COLOURS[i % LABEL_COLOURS.length],
              )}
            >
              {label}
            </li>
          ))}
        </ul>
      )}
    </header>
  )
}

function NothingPosted({ children, changed }: { children: ReactNode; changed?: Change }) {
  return (
    <div
      {...{ [CHANGE_ATTRIBUTE]: changed }}
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-background p-6 text-center text-sm text-muted-foreground">
      <MessageSquareOff className="size-5" />
      {children}
    </div>
  )
}

// What to mark on the page for a moment after a setting changed the preview.
// Leaving: the old preview, with what `next` no longer has marked "removed".
// Entering: the new preview, with what it adds marked "added".
interface Highlight {
  mark: Change
  page: PageMarks
  flash?: number
  next?: PreviewPublication
}

function ForgePage(props: { preview: PreviewPublication; view: View; highlight?: Highlight }) {
  const { preview, view, highlight } = props
  const { pr, provider } = preview
  const github = provider === "github"
  const marked = (on: boolean | undefined) => (on && highlight ? highlight.mark : undefined)
  const flash = highlight?.flash
  const next = highlight?.next
  // What a comment becomes; a comment that goes entirely is marked as a whole.
  const upcoming = (text: string | null | undefined) => (next && text ? text : undefined)

  if (view === "inline") {
    // One thread shows the format; the sample change has several findings,
    // and repeating them only makes the preview longer.
    const [example] = preview.inline
    return (
      <div className="flex flex-col gap-3">
        <PageHeader preview={preview} highlight={highlight} />
        {!example ? (
          <NothingPosted changed={marked(highlight?.page.nothingInline)}>Sentryward posts no inline comments on the diff.</NothingPosted>
        ) : (
          <>
            <Note
              provider={provider}
              label="Inline comments"
              author="sentryward"
              bot
              action={github ? "reviewed" : "started a thread on the diff"}
              changed={marked(highlight?.page.notes.inline)}
            >
              <InlineThread provider={provider} comment={example} flash={flash} upcoming={upcoming(next?.inline[0]?.body)} />
            </Note>
            <p className="text-xs text-muted-foreground">
              One example. Sentryward posts a thread like this for each finding on the diff.
            </p>
          </>
        )}
      </div>
    )
  }

  const nothing = !preview.summaryComment && !preview.walkthroughComment && !preview.status && pr.labels.length === 0
  return (
    <div className="flex flex-col gap-3">
      <PageHeader preview={preview} highlight={highlight} />
      {/* GitLab shows the status in the merge request widget, above the activity. */}
      {!github && preview.status && <StatusRow provider={provider} status={preview.status} changed={marked(highlight?.page.status)} />}
      {/* The author's text, with the high-level summary when Sentryward writes it there. */}
      {pr.description && (
        <Note provider={provider} label="Description" author={pr.author} action={github ? "opened this pull request" : "created this merge request"}>
          <ForgeMarkdown provider={provider} flash={flash} upcoming={upcoming(next?.pr.description)}>
            {pr.description}
          </ForgeMarkdown>
        </Note>
      )}
      {nothing && <NothingPosted changed={marked(highlight?.page.nothingSummary)}>Sentryward posts no summary to the change. Reviews still show up in the dashboard.</NothingPosted>}
      {preview.summaryComment && (
        <Note provider={provider} label="Summary comment" author="sentryward" bot action="commented" changed={marked(highlight?.page.notes.summary)}>
          <ForgeMarkdown provider={provider} flash={flash} upcoming={upcoming(next?.summaryComment)}>
            {preview.summaryComment}
          </ForgeMarkdown>
        </Note>
      )}
      {preview.walkthroughComment && (
        <Note
          provider={provider}
          label="PR summary comment"
          author="sentryward"
          bot
          action="commented"
          changed={marked(highlight?.page.notes.walkthrough)}
        >
          <ForgeMarkdown provider={provider} flash={flash} upcoming={upcoming(next?.walkthroughComment)}>
            {preview.walkthroughComment}
          </ForgeMarkdown>
        </Note>
      )}
      {github && preview.status && <StatusRow provider={provider} status={preview.status} changed={marked(highlight?.page.status)} />}
    </div>
  )
}

interface Transition {
  seq: number
  phase: "leaving" | "entering"
  prev: PreviewPublication
  next: PreviewPublication
  leaving: PageMarks
  entering: PageMarks
}

// `request` is null while the form holds values the server would reject; the
// last good preview then stays up. `focus` names the view the last changed
// setting shows up in; each new `seq` switches to it once, so a view picked by
// hand afterwards sticks until the next change. It also arms a highlight of
// what that change does, shown once the new preview arrives.
export function ReviewPreview(props: {
  request: Omit<PreviewRequest, "provider"> | null
  focus?: { view: View; seq: number }
  // Shown above the summary view: what the sample change cannot show, such as
  // output.summaryOnlyWithFindings, since the sample always has findings.
  summaryNote?: string
}) {
  const { request, focus, summaryNote } = props
  const [provider, setProvider] = useState<ForgeProvider>("github")
  // Only filters the loaded preview, so switching never refetches.
  const [view, setView] = useState<View>("summary")
  const [seenSeq, setSeenSeq] = useState(focus?.seq)
  // A setting changed and its preview has not arrived yet.
  const [armed, setArmed] = useState<number>()
  // The last preview the server answered with.
  const [latest, setLatest] = useState<PreviewPublication>()
  // A setting's change being shown: first what leaves, on the old preview,
  // then what arrives, on the new one.
  const [transition, setTransition] = useState<Transition>()
  const preview = useConfigPreview(request && { provider, ...request })
  const pageRef = useRef<HTMLDivElement>(null)

  // Set during render (React's "adjusting state when a prop changes"), so the
  // new view and the highlight are drawn in the same pass as their cause.
  if (focus && focus.seq !== seenSeq) {
    setSeenSeq(focus.seq)
    setView(focus.view)
    setArmed(focus.seq)
  }
  // Only a preview the server answered for these settings is compared; a
  // forge switch or the first load arrives unarmed and highlights nothing.
  if (preview.data && !preview.isPlaceholderData && preview.data !== latest) {
    setLatest(preview.data)
    // Compared with what is on show, which mid-leave is still the old preview.
    const onShow = transition?.phase === "leaving" ? transition.prev : latest
    setTransition(
      armed !== undefined && onShow && onShow.provider === preview.data.provider
        ? { seq: armed, phase: "leaving", prev: onShow, next: preview.data, ...pageChanges(onShow, preview.data) }
        : undefined,
    )
    setArmed(undefined)
  }

  // Runs after the comments' own layout effects have marked their blocks.
  // Leaving with nothing marked moves on before paint, so a change that only
  // adds shows at once; otherwise what leaves stays marked for LEAVE_MS. The
  // first mark is brought into view: the preview scrolls inside its card.
  useLayoutEffect(() => {
    if (!transition) return
    const leaving = transition.phase === "leaving"
    const first = pageRef.current?.querySelector(`[${CHANGE_ATTRIBUTE}]`)
    const advance = () =>
      setTransition((current) =>
        current !== transition ? current : leaving ? { ...transition, phase: "entering" } : undefined,
      )
    if (leaving && !first) {
      advance()
      return
    }
    if (first && typeof first.scrollIntoView === "function") {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      first.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" })
    }
    const timer = setTimeout(advance, leaving ? LEAVE_MS : HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [transition])

  const leaving = transition?.phase === "leaving"
  const highlight: Highlight | undefined = transition && {
    mark: leaving ? "removed" : "added",
    page: leaving ? transition.leaving : transition.entering,
    flash: leaving ? undefined : transition.seq,
    next: leaving ? transition.next : undefined,
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedControl label="Forge" options={FORGES} value={provider} onChange={setProvider} />
        <SegmentedControl label="View" options={VIEWS} value={view} onChange={setView} />
      </div>
      {summaryNote && view === "summary" && <p className="text-xs text-muted-foreground">{summaryNote}</p>}
      {!request && preview.data && (
        <p className="text-xs text-muted-foreground">Fix the highlighted fields to update the preview.</p>
      )}
      {preview.isError && !preview.data ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm">
          <p className="text-destructive">Could not render the preview.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => preview.refetch()}>
            <RotateCcw />
            Try again
          </Button>
        </div>
      ) : preview.data ? (
        <div
          ref={pageRef}
          className={cn("transition-opacity", !leaving && preview.isPlaceholderData && "opacity-60")}
        >
          <ForgePage preview={leaving ? transition.prev : preview.data} view={view} highlight={highlight} />
        </div>
      ) : (
        <div aria-label="Loading preview" className="flex flex-col gap-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      )}
    </div>
  )
}
