import type { ReactNode } from "react"
import { Copy, GitBranch } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PROVIDERS } from "@/features/forge/providers"
import { copyToClipboard } from "@/lib/clipboard"
import { plural } from "@/lib/plural"
import { formatDuration, timeAgo } from "@/lib/time"
import { TriggerIcon } from "../badges"
import { costUnknown, formatCost } from "../cost"
import { TRIGGER_LABEL } from "../options"
import type { DropReason, Publication, ReviewDetail, ReviewResult } from "../types"

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

function ChangeCard({ review, result }: { review: ReviewDetail; result: ReviewResult | null }) {
  const change = result?.change
  const duration =
    review.startedAt && review.finishedAt
      ? formatDuration(new Date(review.finishedAt).getTime() - new Date(review.startedAt).getTime())
      : null
  return (
    <SideCard title="Change">
      {change?.headRef && change.baseRef && (
        <p className="flex items-center gap-1.5 font-mono text-xs break-all">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {change.baseRef} ← {change.headRef}
        </p>
      )}
      <dl className="flex flex-col gap-1.5">
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
        {change?.isDraft && (
          <Row label="State">
            <Badge variant="outline">Draft</Badge>
          </Row>
        )}
        <Row label="Trigger">
          <span className="inline-flex items-center gap-1.5">
            <TriggerIcon trigger={review.trigger} />
            {TRIGGER_LABEL[review.trigger]}
          </span>
        </Row>
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
