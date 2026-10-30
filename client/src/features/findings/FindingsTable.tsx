import { useState, type ReactNode } from "react"
import { EyeOff, MoreHorizontal, RotateCcw } from "lucide-react"
import { SortableHead } from "@/components/SortableHead"
import { NoMatchesRow } from "@/components/TableFilters"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Sort } from "@/hooks/use-sort"
import { rowClick } from "@/lib/rowClick"
import { SeverityBadge } from "@/features/reviews/badges"
import { changeLabel } from "@/features/reviews/links"
import { IgnoreFindingDialog } from "./IgnoreFindingDialog"
import { CATEGORY_LABEL, KIND_LABEL } from "./options"
import { ReopenFindingDialog } from "./ReopenFindingDialog"
import { StateBadge } from "./StateBadge"
import type { FindingRow, FindingSortKey } from "./types"

// The page has room for the name; the owner is in the tooltip.
function repoName(fullPath: string) {
  return fullPath.split("/").pop() ?? fullPath
}

function FindingActions({ finding }: { finding: FindingRow }) {
  const [ignoring, setIgnoring] = useState(false)
  const [reopening, setReopening] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${finding.title}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
        <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
          {finding.state === "ignored" ? (
            <DropdownMenuItem onSelect={() => setReopening(true)}>
              <RotateCcw />
              Reopen
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem variant="destructive" onSelect={() => setIgnoring(true)}>
              <EyeOff />
              Ignore
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* A sibling of the menu, not inside it, so it stays mounted after the menu closes. */}
      <IgnoreFindingDialog finding={ignoring ? finding : null} onOpenChange={setIgnoring} />
      <ReopenFindingDialog finding={reopening ? finding : null} onOpenChange={setReopening} />
    </>
  )
}

const COLUMNS: { key: FindingSortKey; label: string }[] = [
  { key: "title", label: "Finding" },
  { key: "number", label: "PR/MR #" },
  { key: "repository", label: "Repository" },
  { key: "state", label: "State" },
  { key: "severity", label: "Severity" },
  { key: "category", label: "Category" },
  { key: "kind", label: "Type" },
  { key: "author", label: "PR/MR Author" },
]

export function FindingsTable({
  findings,
  sort,
  onSort,
  onOpen,
  emptyMessage,
}: {
  findings: FindingRow[]
  // Applied by the server, since the list is paged there.
  sort: Sort<FindingSortKey>
  onSort: (key: FindingSortKey) => void
  onOpen: (finding: FindingRow) => void
  // Shown in place of rows; the headers stay so the table keeps its shape.
  emptyMessage: ReactNode
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {COLUMNS.map((column) => (
            <SortableHead key={column.key} label={column.label} sortKey={column.key} sort={sort} onSort={onSort} />
          ))}
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {!findings.length && <NoMatchesRow colSpan={COLUMNS.length + 1}>{emptyMessage}</NoMatchesRow>}
        {findings.map((finding) => (
          <TableRow key={finding.id} onClick={rowClick(() => onOpen(finding))} className="cursor-pointer">
            <TableCell className="max-w-md whitespace-normal">
              <button
                type="button"
                onClick={() => onOpen(finding)}
                className="text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
              >
                {finding.title}
              </button>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {finding.file}:{finding.startLine}
              </div>
            </TableCell>
            <TableCell>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="cursor-help tabular-nums">
                    {changeLabel(finding.repository.provider, finding.number)}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">{finding.changeTitle || "Untitled"}</TooltipContent>
              </Tooltip>
            </TableCell>
            <TableCell title={finding.repository.fullPath}>{repoName(finding.repository.fullPath)}</TableCell>
            <TableCell>
              <StateBadge state={finding.state} />
            </TableCell>
            <TableCell>
              <SeverityBadge severity={finding.severity} />
            </TableCell>
            <TableCell>{CATEGORY_LABEL[finding.category] ?? finding.category}</TableCell>
            <TableCell>{KIND_LABEL[finding.kind] ?? finding.kind}</TableCell>
            <TableCell>{finding.author ?? <span className="text-muted-foreground">-</span>}</TableCell>
            <TableCell>
              <FindingActions finding={finding} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
