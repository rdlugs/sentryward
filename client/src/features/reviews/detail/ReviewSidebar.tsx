import type { ReactNode } from "react"
import { Copy } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PROVIDERS } from "@/features/forge/providers"
import { copyToClipboard } from "@/lib/clipboard"
import { plural } from "@/lib/plural"
import { formatDuration, timeAgo } from "@/lib/time"
import { useReviewChange } from "../api"
import { TriggerIcon } from "../badges"
import { costUnknown, formatCost } from "../cost"
import { TRIGGER_LABEL } from "../options"
import { isActive, type ChangeDetails, type DropReason, type Publication, type ReviewDetail, type ReviewResult } from "../types"
import { branchesOf } from "./branches"
import { ForgeUserLink, RelativeTime } from "./ChangePeople"

const OMISSION_TEXT: Record<string, string> = {
  ignored: "ignored by configuration",
  binary: "binary file",
  deleted: "deleted",
  patch_unavailable: "diff not provided by the forge",
  too_large: "too large for one review pass",
  budget: "review pass limit reached",
  chunk_failed: "review pass failed",
}

const DROP_REASON_TEXT: Record<DropReason, string> = {
  invalid_line: "Invalid line number",
  unknown_file: "File not in the change",
  category: "Category not enabled",
  off_diff: "Outside changed lines",
  low_confidence: "Low confidence",
  below_floor: "Below the severity floor",
  empty: "Empty finding",
  duplicate: "Duplicate",
  over_limit: "Over the findings limit",
  previously_ignored: "Previously ignored on this change",
  refuted: "Refuted by verification",
  rule_mismatch: "Named a rule that does not apply",
  claim_refuted: "The repository contradicted its claim",
}

// A reason added on the server before the client knows it still reads as text.
function dropReasonText(reason: string) {
  // hasOwn, so a reason like "toString" is not read off the prototype.
  if (Object.hasOwn(DROP_REASON_TEXT, reason)) return DROP_REASON_TEXT[reason as DropReason]
  const words = reason.replace(/_/g, " ").trim()
  return words ? words[0].toUpperCase() + words.slice(1) : reason
}

// One line on what reached the forge, so nobody has to go and check.
function publicationText(publication: Publication, forge: string) {
  const parts: string[] = []
  if (publication.inlinePosted.length) parts.push(plural(publication.inlinePosted.length, "inline comment"))
  if (publication.inlineSkipped) parts.push(`${publication.inlineSkipped} already posted`)
  if (publication.summaryCommentId) parts.push("summary")
  if (publication.statusState) parts.push(`commit status (${publication.statusState})`)
  return parts.length ? `Posted to ${forge}: ${parts.join(", ")}` : `Nothing posted to ${forge}`
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  )
}

function SideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">{children}</CardContent>
    </Card>
  )
}

const STATE_LABEL: Record<ChangeDetails["state"], string> = { open: "Open", merged: "Merged", closed: "Closed" }

const STATE_CLASS: Record<ChangeDetails["state"], string> = {
  open: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  merged: "border-violet-500/40 text-violet-700 dark:text-violet-400",
  closed: "border-destructive/40 text-destructive",
}

// The change's own state and dates, as the forge reports them now.
function ChangeRows({ details }: { details: ChangeDetails }) {
  return (
    <>
      <Row label="State">
        <Badge variant="outline" className={STATE_CLASS[details.state]}>
          {details.isDraft && details.state === "open" ? "Draft" : STATE_LABEL[details.state]}
        </Badge>
      </Row>
      {details.author && (
        <Row label="Opened by">
          <ForgeUserLink user={details.author} />
        </Row>
      )}
      <Row label="Opened">
        <RelativeTime iso={details.createdAt} />
      </Row>
      <Row label="Updated">
        <RelativeTime iso={details.updatedAt} />
      </Row>
      {details.mergedAt && (
        <Row label="Merged">
          <RelativeTime iso={details.mergedAt} />
          {details.mergedBy && (
            <>
              {" by "}
              <ForgeUserLink user={details.mergedBy} />
            </>
          )}
        </Row>
      )}
      {details.closedAt && (
        <Row label="Closed">
          <RelativeTime iso={details.closedAt} />
          {details.closedBy && (
            <>
              {" by "}
              <ForgeUserLink user={details.closedBy} />
            </>
          )}
        </Row>
      )}
    </>
  )
}

function BranchRow({ label, branch }: { label: string; branch: string }) {
  return (
    <Row label={label}>
      <span className="inline-flex max-w-full min-w-0 items-center gap-1">
        <code className="truncate text-xs" title={branch}>
          {branch}
        </code>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label={`Copy ${label.toLowerCase()} branch`}
          onClick={() => copyToClipboard(branch, `${label} branch`)}
        >
          <Copy className="size-3" />
        </Button>
      </span>
    </Row>
  )
}

function ChangeCard({ review, result }: { review: ReviewDetail; result: ReviewResult | null }) {
  const change = result?.change
  const forge = PROVIDERS[review.repository.provider].label
  const details = useReviewChange(review.id, isActive(review.status))
  const branches = branchesOf(details.data?.change, result)
  const duration =
    review.startedAt && review.finishedAt
      ? formatDuration(new Date(review.finishedAt).getTime() - new Date(review.startedAt).getTime())
      : null
  return (
    <SideCard title="Change">
      <dl className="flex flex-col gap-1.5">
        {branches.source && <BranchRow label="Source" branch={branches.source} />}
        {branches.target && <BranchRow label="Target" branch={branches.target} />}
        <Row label="Commit">
          <span className="inline-flex items-center gap-1">
            <code className="text-xs">{review.headSha.slice(0, 7)}</code>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Copy commit SHA"
              onClick={() => copyToClipboard(review.headSha, "Commit SHA")}
            >
              <Copy className="size-3" />
            </Button>
          </span>
        </Row>
        {details.data ? (
          <ChangeRows details={details.data.change} />
        ) : details.isError ? (
          <p className="text-xs text-muted-foreground">Couldn't load the change from {forge}.</p>
        ) : (
          <>
            {change?.isDraft && (
              <Row label="State">
                <Badge variant="outline">Draft</Badge>
              </Row>
            )}
            <Skeleton aria-label="Loading the change" className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </>
        )}
        <Row label="Trigger">
          <span className="inline-flex items-center gap-1.5">
            <TriggerIcon trigger={review.trigger} />
            {TRIGGER_LABEL[review.trigger]}
          </span>
        </Row>
        {review.focus && (
          <Row label="Focus">
            {/* The row truncates; the whole request is on hover. */}
            <span title={review.focus}>{review.focus}</span>
          </Row>
        )}
        <Row label="Queued">
          <time dateTime={review.createdAt} title={new Date(review.createdAt).toLocaleString()}>
            {timeAgo(review.createdAt)}
          </time>
        </Row>
        {duration && <Row label="Took">{duration}</Row>}
        {review.attempts > 1 && <Row label="Attempts">{review.attempts}</Row>}
      </dl>
    </SideCard>
  )
}

function PublicationCard({ publication, forge }: { publication: Publication; forge: string }) {
  const problems = [
    ...(publication.inlineFailed.length ? [`${plural(publication.inlineFailed.length, "inline comment")} failed to post`] : []),
    ...publication.errors,
  ]
  return (
    <SideCard title="Publication">
      <p>{publicationText(publication, forge)}</p>
      {problems.length > 0 && (
        <ul className="list-disc pl-4 text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </SideCard>
  )
}

function CoverageCard({ result }: { result: ReviewResult }) {
  const { coverage } = result
  return (
    <SideCard title="Coverage">
      <p>
        {coverage.reviewedFiles.length} of {result.files.length} files reviewed in {coverage.passes} {coverage.passes === 1 ? "pass" : "passes"}
      </p>
      {coverage.omissions.length > 0 && (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-muted-foreground">
          {coverage.omissions.map((o, i) => (
            <li key={`${o.path}-${i}`} className="break-all">
              <code className="text-xs text-foreground">{o.path}</code>: {OMISSION_TEXT[o.reason] ?? o.reason}
              {o.detail ? `, ${o.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </SideCard>
  )
}

// Counts only: what was filtered or downgraded, never the discarded text.
function ValidationCard({ result }: { result: ReviewResult }) {
  const { dropped, demoted } = result.validation
  const drops = Object.entries(dropped)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
  if (drops.length === 0 && demoted === 0) return null
  return (
    <SideCard title="Validation">
      {drops.length > 0 && (
        <>
          <p className="text-muted-foreground">Left out of the review</p>
          <dl className="flex flex-col gap-1.5">
            {drops.map(([reason, count]) => (
              // Not Row: its label never shrinks, so a long reason would hide the count.
              <div key={reason} className="flex items-baseline justify-between gap-3">
                <dt className="min-w-0 break-words text-muted-foreground">{dropReasonText(reason)}</dt>
                <dd className="shrink-0 tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {demoted > 0 && (
        <>
          <p>{plural(demoted, "finding")} downgraded because evidence was missing or unverified</p>
          {/* The server counts a demotion before later drops (below floor, duplicate, ...). */}
          {drops.length > 0 && <p className="text-muted-foreground">A downgraded finding can also be counted above.</p>}
        </>
      )}
    </SideCard>
  )
}

function UsageCard({ result }: { result: ReviewResult }) {
  const { usageTotals, usage } = result
  return (
    <SideCard title="Usage">
      <dl className="flex flex-col gap-1.5">
        <Row label="Model calls">{usageTotals.calls}</Row>
        <Row label="Input tokens">{usageTotals.inputTokens.toLocaleString()}</Row>
        <Row label="Output tokens">{usageTotals.outputTokens.toLocaleString()}</Row>
        <Row label="Estimated cost">
          {usageTotals.costUsd === undefined ? (
            <span className="text-muted-foreground" title="Not recorded for this run">
              -
            </span>
          ) : (
            formatCost(costUnknown(usageTotals) ? null : usageTotals.costUsd)
          )}
        </Row>
      </dl>
      {usage.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Per call</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {usage.map((call, i) => (
              <li key={i} className="flex flex-col">
                <span className="truncate font-mono" title={call.model}>
                  {call.purpose} · {call.model}
                </span>
                <span className="text-muted-foreground">
                  {call.inputTokens.toLocaleString()} in · {call.outputTokens.toLocaleString()} out ·{" "}
                  {call.reasoningTokens ? `${call.reasoningTokens.toLocaleString()} reasoning · ` : ""}
                  {formatDuration(call.latencyMs)}
                </span>
                {call.steps && (
                  <span className="text-muted-foreground">
                    {call.steps} steps
                    {call.toolCalls &&
                      ` · ${Object.entries(call.toolCalls)
                        .map(([name, count]) => `${name} ×${count}`)
                        .join(", ")}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </SideCard>
  )
}

export function ReviewSidebar({ review, result }: { review: ReviewDetail; result: ReviewResult | null }) {
  const forge = PROVIDERS[review.repository.provider].label
  return (
    <aside aria-label="Review details" className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
      <ChangeCard review={review} result={result} />
      {review.publication && <PublicationCard publication={review.publication} forge={forge} />}
      {result && <CoverageCard result={result} />}
      {result && <ValidationCard result={result} />}
      {result && <UsageCard result={result} />}
    </aside>
  )
}
