import { useState } from "react"
import { Link } from "react-router"
import { ExternalLink, EyeOff, RotateCcw } from "lucide-react"
import { DetailRow } from "@/components/DetailSection"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { SeverityBadge } from "@/features/reviews/badges"
import { FindingBody } from "@/features/reviews/FindingBody"
import { changeLabel, findingLines } from "@/features/reviews/links"
import { timeAgo } from "@/lib/time"
import { useFinding } from "./api"
import { IgnoreFindingDialog } from "./IgnoreFindingDialog"
import { CATEGORY_LABEL, IGNORE_REASON_LABEL, KIND_LABEL, LIFECYCLE_LABEL } from "./options"
import { ReopenFindingDialog } from "./ReopenFindingDialog"
import { StateBadge } from "./StateBadge"
import type { FindingRow } from "./types"

function When({ iso }: { iso: string }) {
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{timeAgo(iso)}</time>
}

function Actions({ finding }: { finding: FindingRow }) {
  const [ignoring, setIgnoring] = useState(false)
  const [reopening, setReopening] = useState(false)
  return (
    <SheetFooter className="flex-row flex-wrap border-t">
      {finding.state === "ignored" ? (
        <Button variant="outline" onClick={() => setReopening(true)}>
          <RotateCcw />
          Reopen
        </Button>
      ) : (
        <Button variant="destructive" onClick={() => setIgnoring(true)}>
          <EyeOff />
          Ignore
        </Button>
      )}
      <IgnoreFindingDialog finding={ignoring ? finding : null} onOpenChange={setIgnoring} />
      <ReopenFindingDialog finding={reopening ? finding : null} onOpenChange={setReopening} />
      {finding.lastJobId && (
        <Button variant="ghost" asChild>
          <Link to={`/reviews/${finding.lastJobId}`}>Open review</Link>
        </Button>
      )}
    </SheetFooter>
  )
}

// Opened from a row of the findings table. The row is on screen at once; the
// full text comes from the run that last reported the finding.
export function FindingDetailsSheet({
  row,
  onOpenChange,
}: {
  row: FindingRow | null
  onOpenChange: (open: boolean) => void
}) {
  const { data, isPending, isError } = useFinding(row?.id ?? null)
  // Fresher than the row after an ignore or reopen.
  const finding = data?.finding ?? row
  const change = data?.change

  return (
    <Sheet open={row !== null} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-3xl">
        {finding && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-8 text-base">{finding.title}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StateBadge state={finding.state} />
                <SeverityBadge severity={finding.severity} />
                <Badge variant="outline">{CATEGORY_LABEL[finding.category] ?? finding.category}</Badge>
                <Badge variant="outline">{KIND_LABEL[finding.kind] ?? finding.kind}</Badge>
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-1 flex-col gap-6 px-4 pb-4">
              <dl className="grid grid-cols-[8rem_1fr] items-center gap-x-4 gap-y-2 text-sm">
                <DetailRow label="Repository">{finding.repository.fullPath}</DetailRow>
                <DetailRow label="PR/MR">
                  {change?.webUrl ? (
                    <a href={change.webUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                      {changeLabel(finding.repository.provider, finding.number)} {finding.changeTitle}
                      <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    <>
                      {changeLabel(finding.repository.provider, finding.number)} {finding.changeTitle}
                    </>
                  )}
                </DetailRow>
                <DetailRow label="Author">{finding.author ?? <span className="text-muted-foreground">Unknown</span>}</DetailRow>
                <DetailRow label="Location">
                  <code className="font-mono text-xs">
                    {finding.file}:{data?.detail ? findingLines(data.detail) : finding.startLine}
                  </code>
                </DetailRow>
                <DetailRow label="Last review">{LIFECYCLE_LABEL[finding.lifecycle]}</DetailRow>
                <DetailRow label="First seen">
                  <When iso={finding.firstSeenAt} />
                </DetailRow>
                <DetailRow label="Last seen">
                  <When iso={finding.lastSeenAt} />
                </DetailRow>
                {finding.state === "resolved" && finding.resolvedAt && (
                  <DetailRow label="Resolved">
                    <When iso={finding.resolvedAt} />
                  </DetailRow>
                )}
                {finding.state === "ignored" && finding.ignoredAt && (
                  <DetailRow label="Ignored">
                    <When iso={finding.ignoredAt} />
                  </DetailRow>
                )}
                {finding.state === "ignored" && finding.ignoreReason && (
                  <DetailRow label="Reason">{IGNORE_REASON_LABEL[finding.ignoreReason]}</DetailRow>
                )}
                {finding.state === "ignored" && finding.ignoreNote && (
                  // Typed by a user; plain text, never HTML.
                  <DetailRow label="Note">
                    <p className="whitespace-pre-wrap">{finding.ignoreNote}</p>
                  </DetailRow>
                )}
              </dl>
              <Separator />
              {isPending ? (
                <Skeleton className="h-40 w-full" />
              ) : isError ? (
                <p className="text-sm text-destructive">Could not load the finding.</p>
              ) : data.detail && data.change ? (
                <section aria-label="Finding details" className="flex flex-col gap-3">
                  <FindingBody finding={data.detail} change={data.change} />
                </section>
              ) : (
                <p className="text-sm text-muted-foreground">Full details are no longer available for this finding.</p>
              )}
            </div>
            <Actions finding={finding} />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
