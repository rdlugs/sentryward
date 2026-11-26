import { useState, type ReactNode } from "react"
import { Link } from "react-router"
import { EyeOff, Loader2, MoreHorizontal, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { SortableHead } from "@/components/SortableHead"
import { NoMatchesRow } from "@/components/TableFilters"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useIsBelowSm } from "@/hooks/use-mobile"
import type { Sort } from "@/hooks/use-sort"
import { formatDate, timeAgo } from "@/lib/time"
import { SeverityBadge } from "@/features/reviews/badges"
import { findingLocation } from "@/features/reviews/findingLocation"
import { changeLabel } from "@/features/reviews/links"
import { useSetBacklogState } from "./api"
import { BacklogStateBadge } from "./BacklogStateBadge"
import { DismissBacklogDialog } from "./DismissBacklogDialog"
import { ORIGIN_LABEL } from "./options"
import type { BacklogItem, BacklogSortKey } from "./types"

// The page has room for the name; the owner is in the tooltip.
function repoName(fullPath: string) {
  return fullPath.split("/").pop() ?? fullPath
}

function lines(item: Pick<BacklogItem, "startLine" | "endLine">) {
  return item.endLine && item.endLine !== item.startLine ? `${item.startLine}-${item.endLine}` : `${item.startLine}`
}

// Dismiss an open item, or put a resolved or dismissed one back in the backlog.
// Reopening is one click: nothing is lost that the next merge cannot redo.
function BacklogActions({ item }: { item: BacklogItem }) {
  const [dismissing, setDismissing] = useState(false)
  const setState = useSetBacklogState()

  async function reopen() {
    try {
      await setState.mutateAsync({ id: item.id, state: "open" })
      toast.success("Backlog item reopened")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reopen the item")
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${item.title}`}>
            {setState.isPending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
          {item.state === "open" ? (
            <DropdownMenuItem variant="destructive" onSelect={() => setDismissing(true)}>
              <EyeOff />
              Dismiss
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void reopen()}>
              <RotateCcw />
              Reopen
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* A sibling of the menu, not inside it, so it stays mounted after the menu closes. */}
      <DismissBacklogDialog item={dismissing ? item : null} onOpenChange={setDismissing} />
    </>
  )
}

// Where the item came from, and for a resolved one, what resolved it.
function Provenance({ item }: { item: BacklogItem }) {
  const provider = item.repository.provider
  return (
    <div className="flex flex-col gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="cursor-help tabular-nums">
            {changeLabel(provider, item.sourceNumber)} into {item.baseBranch}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{item.sourceChangeTitle || "Untitled"}</TooltipContent>
      </Tooltip>
      <span className="text-xs text-muted-foreground">
        {formatDate(item.mergedAt)} · {ORIGIN_LABEL[item.origin]}
      </span>
      {item.state === "resolved" && item.resolvedNumber !== null && (
        <span className="text-xs text-muted-foreground">
          Resolved by{" "}
          {item.resolvedJobId ? (
            <Link to={`/reviews/${item.resolvedJobId}`} className="underline-offset-2 hover:underline">
              {changeLabel(provider, item.resolvedNumber)}
            </Link>
          ) : (
            changeLabel(provider, item.resolvedNumber)
          )}
        </span>
      )}
      {/* Typed by a user; plain text, never HTML. */}
      {item.state === "dismissed" && item.dismissNote && (
        <span className="text-xs whitespace-pre-wrap text-muted-foreground">{item.dismissNote}</span>
      )}
    </div>
  )
}

const COLUMNS: { key: BacklogSortKey; label: string }[] = [
  { key: "title", label: "Item" },
  { key: "repository", label: "Repository" },
  { key: "severity", label: "Severity" },
  { key: "mergedAt", label: "Shipped in" },
  { key: "firstSeenAt", label: "First raised" },
]

// Below `sm` the columns become a stacked card per item, so the list reflows
// at 320px instead of scrolling sideways (WCAG 1.4.10).
function BacklogCard({ item }: { item: BacklogItem }) {
  return (
    <li className="flex flex-col gap-2 border-b py-3 last:border-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium break-words">{item.title}</div>
          <div className="font-mono text-xs break-all text-muted-foreground">
            {findingLocation(item.file, lines(item))}
          </div>
        </div>
        <BacklogActions item={item} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <BacklogStateBadge item={item} />
        <SeverityBadge severity={item.severity} />
      </div>
      <div className="text-xs break-words text-muted-foreground">
        <span title={item.repository.fullPath}>{repoName(item.repository.fullPath)}</span> · first raised{" "}
        {timeAgo(item.firstSeenAt)}
      </div>
      <Provenance item={item} />
    </li>
  )
}

export function BacklogTable({
  items,
  sort,
  onSort,
  emptyMessage,
}: {
  items: BacklogItem[]
  // Applied by the server, since the list is paged there.
  sort: Sort<BacklogSortKey>
  onSort: (key: BacklogSortKey) => void
  // Shown in place of rows; the headers stay so the table keeps its shape.
  emptyMessage: ReactNode
}) {
  const cards = useIsBelowSm()
  if (cards) {
    return items.length ? (
      <ul aria-label="Backlog">
        {items.map((item) => (
          <BacklogCard key={item.id} item={item} />
        ))}
      </ul>
    ) : (
      <p className="py-8 text-center text-muted-foreground">{emptyMessage}</p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {COLUMNS.map((column) => (
            <SortableHead key={column.key} label={column.label} sortKey={column.key} sort={sort} onSort={onSort} />
          ))}
          <TableHead>State</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {!items.length && <NoMatchesRow colSpan={COLUMNS.length + 2}>{emptyMessage}</NoMatchesRow>}
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell className="max-w-md whitespace-normal">
              <div className="font-medium">{item.title}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {findingLocation(item.file, lines(item))}
              </div>
            </TableCell>
            <TableCell title={item.repository.fullPath}>{repoName(item.repository.fullPath)}</TableCell>
            <TableCell>
              <SeverityBadge severity={item.severity} />
            </TableCell>
            <TableCell className="whitespace-normal">
              <Provenance item={item} />
            </TableCell>
            <TableCell title={formatDate(item.firstSeenAt)}>{timeAgo(item.firstSeenAt)}</TableCell>
            <TableCell>
              <BacklogStateBadge item={item} />
            </TableCell>
            <TableCell>
              <BacklogActions item={item} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
