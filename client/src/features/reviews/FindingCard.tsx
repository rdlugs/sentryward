import type { Ref } from "react"
import { ChevronRight } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { SeverityBadge } from "./badges"
import { FindingBody } from "./FindingBody"
import { findingLines } from "./links"
import { SEVERITY_BORDER } from "./severity"
import type { Finding, ReviewResult } from "./types"

export function FindingCard({
  finding,
  change,
  open,
  onOpenChange,
  triggerRef,
  onFocus,
}: {
  finding: Finding
  change: ReviewResult["change"]
  open: boolean
  onOpenChange: (open: boolean) => void
  triggerRef?: Ref<HTMLButtonElement>
  onFocus?: () => void
}) {
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange}>
      <article
        className={cn("rounded-lg border border-l-4 bg-card", SEVERITY_BORDER[finding.severity])}
        aria-label={finding.title}
        onFocus={onFocus}
      >
        {/* scroll-mt clears the sticky header and severity bar when a card is focused from the keyboard. */}
        <CollapsibleTrigger
          ref={triggerRef}
          className="flex w-full scroll-mt-28 items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRight
            aria-hidden
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <SeverityBadge severity={finding.severity} />
          <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{finding.title}</h4>
          <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">L{findingLines(finding)}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 border-t px-4 py-3">
          <FindingBody finding={finding} change={change} />
        </CollapsibleContent>
      </article>
    </Collapsible>
  )
}
