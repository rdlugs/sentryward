import { useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import { ChevronsDownUp, ChevronsUpDown, FileCode } from "lucide-react"
import { SearchInput } from "@/components/TableFilters"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { copyToClipboard } from "@/lib/clipboard"
import { ALL } from "@/lib/filters"
import { cn } from "@/lib/utils"
import { findingPrompt } from "../agentPrompt"
import { BUCKET_ICON } from "../icons"
import { SEVERITY_CLASS } from "../severity"
import { FindingCard } from "../FindingCard"
import { SeverityJump } from "./SeverityJump"
import { ShortcutsDialog } from "./ShortcutsDialog"
import { useFindingShortcuts } from "./useFindingShortcuts"
import {
  BUCKET_ORDER,
  BUCKET_TITLE,
  SEVERITIES,
  type Bucket,
  type Finding,
  type ReviewResult,
  type Severity,
} from "../types"

// Nitpicks and outside-diff comments start collapsed: they are the long tail
// someone skims after the comments that need action.
const OPEN_BY_DEFAULT = new Set<Bucket>(["actionable", "requirement_gap"])

function groupByFile(findings: Finding[]) {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    groups.set(finding.file, [...(groups.get(finding.file) ?? []), finding])
  }
  return [...groups.entries()]
}

function countBySeverity(findings: Finding[]) {
  const out = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>
  for (const finding of findings) out[finding.severity]++
  return out
}

// Filters live in the URL so a filtered view can be linked and survives a reload.
function useFindingFilters() {
  const [params, setParams] = useSearchParams()
  const severities = new Set(
    (params.get("severity") ?? "").split(",").filter((s): s is Severity => SEVERITIES.includes(s as Severity)),
  )
  const rawBucket = params.get("bucket")
  const bucket = BUCKET_ORDER.includes(rawBucket as Bucket) ? (rawBucket as Bucket) : null
  // Kept untrimmed so the input shows exactly what was typed; matching trims it.
  const file = params.get("file") ?? ""

  function update(next: { severities?: Set<Severity>; bucket?: Bucket | null; file?: string }) {
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev)
        const sev = next.severities ?? severities
        const b = next.bucket === undefined ? bucket : next.bucket
        const f = next.file ?? file
        if (sev.size) out.set("severity", SEVERITIES.filter((s) => sev.has(s)).join(","))
        else out.delete("severity")
        if (b) out.set("bucket", b)
        else out.delete("bucket")
        if (f) out.set("file", f)
        else out.delete("file")
        return out
      },
      { replace: true },
    )
  }

  return {
    severities,
    bucket,
    file,
    active: severities.size > 0 || bucket !== null || file.trim() !== "",
    toggleSeverity(severity: Severity) {
      const next = new Set(severities)
      if (next.has(severity)) next.delete(severity)
      else next.add(severity)
      update({ severities: next })
    },
    setBucket: (value: Bucket | null) => update({ bucket: value }),
    setFile: (value: string) => update({ file: value }),
    clear: () => update({ severities: new Set(), bucket: null, file: "" }),
  }
}

export function FindingsSection({ result }: { result: ReviewResult }) {
  const filters = useFindingFilters()
  const [open, setOpen] = useState(
    () => new Set(result.findings.filter((f) => OPEN_BY_DEFAULT.has(f.bucket)).map((f) => f.fingerprint)),
  )
  const files = useMemo(() => new Map(result.files.map((file) => [file.path, file])), [result.files])

  const counts = useMemo(() => countBySeverity(result.findings), [result.findings])

  const fileQuery = filters.file.trim().toLowerCase()
  const visible = result.findings.filter(
    (f) =>
      (!filters.severities.size || filters.severities.has(f.severity)) &&
      (!filters.bucket || f.bucket === filters.bucket) &&
      (!fileQuery || f.file.toLowerCase().includes(fileQuery)),
  )

  // Rendered from the same grouping, so keyboard navigation and the severity
  // jump follow what is on screen rather than the order the model reported.
  const groups = BUCKET_ORDER.map((bucket) => ({
    bucket,
    files: groupByFile(visible.filter((f) => f.bucket === bucket)),
  })).filter((group) => group.files.length)
  const ordered = groups.flatMap((group) => group.files.flatMap(([, items]) => items))
  const visibleCounts = countBySeverity(visible)

  // Where j/k continue from. Kept in sync with Tab and clicks through the cards'
  // onFocus and kept after focus leaves the list; o/c also need the card to
  // still hold focus. A finding hidden by a filter no longer counts as current.
  const [current, setCurrent] = useState<string | null>(null)
  const currentIndex = ordered.findIndex((f) => f.fingerprint === current)
  const root = useRef<HTMLDivElement>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  // Looked up by data attribute rather than a ref per card, which would be
  // detached and reattached for every card on every render.
  function triggerFor(fingerprint: string) {
    const triggers = root.current?.querySelectorAll<HTMLElement>("[data-fingerprint]") ?? []
    return [...triggers].find((el) => el.dataset.fingerprint === fingerprint)
  }

  function focusedFinding() {
    const finding = ordered[currentIndex]
    const card = finding && triggerFor(finding.fingerprint)?.closest("article")
    return card && card.contains(document.activeElement) ? finding : undefined
  }

  function focusFinding(fingerprint: string, block: ScrollLogicalPosition) {
    const trigger = triggerFor(fingerprint)
    if (!trigger) return
    trigger.scrollIntoView({ block })
    trigger.focus({ preventScroll: true })
    // :focus-visible does not match after a jump started with the mouse (and
    // Chromium ignores focus({ focusVisible })), so the ring is drawn from this
    // attribute until focus moves on.
    trigger.dataset.jumped = ""
    trigger.addEventListener("blur", () => delete trigger.dataset.jumped, { once: true })
    setCurrent(fingerprint)
  }

  function step(delta: 1 | -1) {
    if (!ordered.length) return false
    const index =
      currentIndex === -1
        ? delta === 1
          ? 0
          : ordered.length - 1
        : Math.min(Math.max(currentIndex + delta, 0), ordered.length - 1)
    focusFinding(ordered[index].fingerprint, "nearest")
    return true
  }

  function jumpTo(severity: Severity) {
    const first = ordered.find((f) => f.severity === severity)
    if (first) focusFinding(first.fingerprint, "start")
  }

  useFindingShortcuts({
    next: () => step(1),
    previous: () => step(-1),
    toggle: () => {
      const finding = focusedFinding()
      if (!finding) return false
      toggle(finding.fingerprint, !open.has(finding.fingerprint))
      return true
    },
    copy: () => {
      const finding = focusedFinding()
      if (!finding) return false
      void copyToClipboard(findingPrompt(finding), "Agent prompt")
      return true
    },
    help: () => {
      if (!result.findings.length) return false
      setHelpOpen(true)
      return true
    },
  })

  function setAll(expanded: boolean) {
    setOpen((prev) => {
      const next = new Set(prev)
      for (const finding of visible) {
        if (expanded) next.add(finding.fingerprint)
        else next.delete(finding.fingerprint)
      }
      return next
    })
  }

  function toggle(fingerprint: string, expanded: boolean) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (expanded) next.add(fingerprint)
      else next.delete(fingerprint)
      return next
    })
  }

  // An empty list from a partial or failed run only means nothing was reported,
  // not that the change is clean, so only a completed run gets the all-clear.
  if (result.findings.length === 0) {
    return (
      <section aria-label="Findings" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {result.status === "completed"
          ? "No findings. Nothing in this change needs attention."
          : "No findings were reported; review coverage was incomplete."}
      </section>
    )
  }

  return (
    <div ref={root} className="flex flex-col gap-5">
      <div role="toolbar" aria-label="Filter findings" className="flex flex-wrap items-center gap-2">
        {SEVERITIES.map((severity) => {
          const pressed = filters.severities.has(severity)
          return (
            <button
              key={severity}
              type="button"
              aria-pressed={pressed}
              disabled={counts[severity] === 0}
              onClick={() => filters.toggleSeverity(severity)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                "disabled:pointer-events-none disabled:opacity-40",
                pressed && cn("border-transparent ring-1 ring-current", SEVERITY_CLASS[severity]),
              )}
            >
              {severity}
              <span className="tabular-nums opacity-70">{counts[severity]}</span>
            </button>
          )
        })}
        <Select
          value={filters.bucket ?? ALL}
          onValueChange={(value) => filters.setBucket(value === ALL ? null : (value as Bucket))}
        >
          <SelectTrigger size="sm" aria-label="Comment type" className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={ALL}>All comment types</SelectItem>
            {BUCKET_ORDER.map((bucket) => (
              <SelectItem key={bucket} value={bucket}>
                {BUCKET_TITLE[bucket]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SearchInput
          label="Filter by file path"
          value={filters.file}
          onChange={filters.setFile}
          className="h-7 compact:h-7 spacious:h-7 sm:w-56 [&_input]:text-xs"
        />
        {filters.active && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={filters.clear}>
            Clear filters
          </Button>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAll(true)}>
            <ChevronsUpDown />
            Expand all
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAll(false)}>
            <ChevronsDownUp />
            Collapse all
          </Button>
        </div>
      </div>

      <SeverityJump counts={visibleCounts} onJump={jumpTo} onShowShortcuts={() => setHelpOpen(true)} />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No findings match these filters.
          <Button variant="outline" size="sm" onClick={filters.clear}>
            Clear filters
          </Button>
        </div>
      ) : (
        groups.map(({ bucket, files: bucketFiles }) => {
          const Icon = BUCKET_ICON[bucket]
          return (
            <section key={bucket} aria-label={BUCKET_TITLE[bucket]} className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Icon className="size-5 text-muted-foreground" aria-hidden />
                {BUCKET_TITLE[bucket]}{" "}
                <span className="font-normal text-muted-foreground">
                  ({bucketFiles.reduce((sum, [, items]) => sum + items.length, 0)})
                </span>
              </h2>
              {bucketFiles.map(([path, items]) => {
                const file = files.get(path)
                return (
                  <div key={path} className="flex flex-col gap-2">
                    <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <FileCode className="size-4 text-muted-foreground" aria-hidden />
                      <span className="font-mono break-all">{path}</span>
                      {file && (
                        <span className="text-xs text-muted-foreground">
                          {file.changeType} ·{" "}
                          <span className="text-emerald-700 dark:text-emerald-400">+{file.additions}</span>{" "}
                          <span className="text-destructive">-{file.deletions}</span>
                        </span>
                      )}
                    </h3>
                    {items.map((finding) => (
                      <FindingCard
                        key={finding.fingerprint}
                        finding={finding}
                        change={result.change}
                        open={open.has(finding.fingerprint)}
                        onOpenChange={(expanded) => toggle(finding.fingerprint, expanded)}
                        onFocus={() => setCurrent(finding.fingerprint)}
                      />
                    ))}
                  </div>
                )
              })}
            </section>
          )
        })
      )}
    </div>
  )
}
