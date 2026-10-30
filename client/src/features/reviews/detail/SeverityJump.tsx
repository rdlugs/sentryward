import { Keyboard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SEVERITY_CLASS } from "../severity"
import { SEVERITIES, type Severity } from "../types"

// Sticks below the dashboard header (h-14) so a long review can always jump
// back to its worst findings. Counts are of the visible findings, so every
// enabled button has somewhere to go.
export function SeverityJump({
  counts,
  onJump,
  onShowShortcuts,
}: {
  counts: Record<Severity, number>
  onJump: (severity: Severity) => void
  onShowShortcuts: () => void
}) {
  return (
    <nav
      aria-label="Jump to severity"
      className="sticky top-14 z-[5] -mx-1 flex flex-wrap items-center gap-1.5 rounded-md bg-background/95 px-1 py-1.5 backdrop-blur supports-backdrop-filter:bg-background/80"
    >
      <span className="text-xs text-muted-foreground">Jump to</span>
      {SEVERITIES.map((severity) => (
        <button
          key={severity}
          type="button"
          disabled={counts[severity] === 0}
          aria-label={`Jump to first ${severity} finding (${counts[severity]})`}
          onClick={() => onJump(severity)}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-opacity",
            "hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            "disabled:pointer-events-none disabled:opacity-40",
            SEVERITY_CLASS[severity],
          )}
        >
          {severity}
          <span className="tabular-nums opacity-70">{counts[severity]}</span>
        </button>
      ))}
      <Button
        variant="ghost"
        size="icon"
        className="ml-auto size-6"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (Ctrl+?)"
        onClick={onShowShortcuts}
      >
        <Keyboard />
      </Button>
    </nav>
  )
}
