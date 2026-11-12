import { useMemo, useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SortableHead } from "@/components/SortableHead"
import { TablePagination } from "@/components/TablePagination"
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { paginate, usePagination, type Pagination } from "@/hooks/use-pagination"
import { useSort } from "@/hooks/use-sort"
import { timeAgo } from "@/lib/time"
import { costUnknown, formatCount, formatUsd } from "./format"
import { Segmented } from "./Segmented"
import type { ModelUsageRow, RepositoryUsageRow, UsageReport, UsageTokens } from "./types"

// ?usagePage= and ?usageSize=, apart from the recent reviews'.
export const USAGE_PAGINATION = "usage"

type View = "model" | "repository"
type Mode = "costs" | "tokens"

const VIEWS: { value: View; label: string }[] = [
  { value: "model", label: "Usage by Model" },
  { value: "repository", label: "Usage by Repository" },
]

const MODES = [
  { value: "costs", label: "Costs" },
  { value: "tokens", label: "Tokens" },
] as const

interface Column<R> {
  key: string
  label: string
  numeric?: boolean
  // What the column sorts by; text sorts alphabetically, null sorts last.
  sortValue: (row: R) => string | number | null
  cell: (row: R) => ReactNode
}

const dash = <span className="text-muted-foreground">-</span>
const unknown = <span className="text-muted-foreground">Unknown</span>

// Unknown costs sort last, like rows never used.
const costOf = <R extends UsageTokens>(row: R, usd: number) => (costUnknown(row) ? null : usd)
const costCell = <R extends UsageTokens>(row: R, usd: number) => (costUnknown(row) ? unknown : formatUsd(usd))

function tokenColumns<R extends UsageTokens>(): Column<R>[] {
  return [
    { key: "input", label: "Input", numeric: true, sortValue: (r) => r.inputTokens - r.cachedInputTokens, cell: (r) => formatCount(r.inputTokens - r.cachedInputTokens) },
    { key: "cached", label: "Cached", numeric: true, sortValue: (r) => r.cachedInputTokens, cell: (r) => formatCount(r.cachedInputTokens) },
    { key: "output", label: "Output", numeric: true, sortValue: (r) => r.outputTokens, cell: (r) => formatCount(r.outputTokens) },
    { key: "total", label: "Total", numeric: true, sortValue: (r) => r.inputTokens + r.outputTokens, cell: (r) => formatCount(r.inputTokens + r.outputTokens) },
  ]
}

const lastUsed = <R extends { lastUsed: string | null }>(): Column<R> => ({
  key: "lastUsed",
  label: "Last used",
  numeric: true,
  sortValue: (r) => r.lastUsed,
  cell: (r) => (r.lastUsed ? timeAgo(r.lastUsed) : dash),
})

function modelColumns(mode: Mode): Column<ModelUsageRow>[] {
  return [
    { key: "model", label: "Model", sortValue: (r) => r.model, cell: (r) => <span className="font-mono text-xs">{r.model}</span> },
    { key: "provider", label: "Provider", sortValue: (r) => r.provider, cell: (r) => <Badge variant="outline">{r.provider}</Badge> },
    { key: "calls", label: "Calls", numeric: true, sortValue: (r) => r.calls, cell: (r) => formatCount(r.calls) },
    lastUsed(),
    ...(mode === "tokens"
      ? tokenColumns<ModelUsageRow>()
      : [
          { key: "inputCost", label: "Input cost", numeric: true, sortValue: (r: ModelUsageRow) => costOf(r, r.cost.input), cell: (r: ModelUsageRow) => costCell(r, r.cost.input) },
          { key: "cachedCost", label: "Cached cost", numeric: true, sortValue: (r: ModelUsageRow) => costOf(r, r.cost.cached), cell: (r: ModelUsageRow) => costCell(r, r.cost.cached) },
          { key: "outputCost", label: "Output cost", numeric: true, sortValue: (r: ModelUsageRow) => costOf(r, r.cost.output), cell: (r: ModelUsageRow) => costCell(r, r.cost.output) },
          { key: "totalCost", label: "Total cost", numeric: true, sortValue: (r: ModelUsageRow) => costOf(r, r.cost.total), cell: (r: ModelUsageRow) => costCell(r, r.cost.total) },
        ]),
  ]
}

function repositoryColumns(mode: Mode): Column<RepositoryUsageRow>[] {
  return [
    { key: "repository", label: "Repository", sortValue: (r) => r.fullPath, cell: (r) => r.fullPath },
    { key: "reviews", label: "Reviews", numeric: true, sortValue: (r) => r.reviews, cell: (r) => formatCount(r.reviews) },
    { key: "calls", label: "Calls", numeric: true, sortValue: (r) => r.calls, cell: (r) => formatCount(r.calls) },
    lastUsed(),
    ...(mode === "tokens"
      ? tokenColumns<RepositoryUsageRow>()
      : [{ key: "totalCost", label: "Est. cost", numeric: true, sortValue: (r: RepositoryUsageRow) => costOf(r, r.usd), cell: (r: RepositoryUsageRow) => costCell(r, r.usd) }]),
  ]
}

function compare(a: string | number | null, b: string | number | null) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  return typeof a === "string" ? a.localeCompare(String(b)) : a - Number(b)
}

function DataTable<R>({
  label,
  rows,
  columns,
  rowKey,
  pagination,
}: {
  label: string
  rows: R[]
  columns: Column<R>[]
  rowKey: (row: R) => string
  pagination: Pagination
}) {
  const { sort, onSort: toggleSort } = useSort<string>()
  // A new order starts over at page 1, so the top of it is what shows.
  function onSort(key: string) {
    toggleSort(key)
    pagination.setPage(1)
  }
  const sorted = useMemo(() => {
    const column = sort && columns.find((c) => c.key === sort.key)
    if (!sort || !column) return rows
    const direction = sort.dir === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
      const order = compare(column.sortValue(a), column.sortValue(b))
      // Rows without a value (never used) stay last whichever way the column sorts.
      return column.sortValue(a) === null || column.sortValue(b) === null ? order : direction * order
    })
  }, [rows, columns, sort])
  // Paged after sorting, so a sort orders every row and not just this page.
  const page = paginate(sorted, pagination.page, pagination.size)

  return (
    <>
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <SortableHead key={column.key} label={column.label} sortKey={column.key} sort={sort} onSort={onSort} />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.map((row) => (
            <TableRow key={rowKey(row)}>
              {columns.map((column) => (
                <TableCell key={column.key} className={column.numeric ? "text-right tabular-nums" : undefined}>
                  {column.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {sorted.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length} className="py-6 text-center text-muted-foreground">
                No usage recorded in this period.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {page.total > 0 && (
        <TablePagination
          page={page.page}
          size={pagination.size}
          total={page.total}
          onPageChange={pagination.setPage}
          onSizeChange={pagination.setSize}
        />
      )}
    </>
  )
}

export function UsageTable({ report }: { report: UsageReport }) {
  const [view, setView] = useState<View>("model")
  const [mode, setMode] = useState<Mode>("costs")
  // The one instance for this table; DataTable reads and sets it through props.
  const pagination = usePagination(USAGE_PAGINATION)

  // Other rows (or the same rows by another measure) start over at page 1.
  function startOver<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      pagination.setPage(1)
    }
  }

  return (
    <section aria-label="Usage table" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={view} onValueChange={(next) => startOver(setView)(next as View)}>
          <SelectTrigger aria-label="Group usage by" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VIEWS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Segmented label="Table values" options={MODES} value={mode} onChange={startOver(setMode)} />
      </div>
      <Card>
        <CardContent>
          {view === "model" ? (
            <DataTable
              key={`model-${mode}`}
              label="Usage by model"
              rows={report.byModel}
              columns={modelColumns(mode)}
              rowKey={(row) => row.model}
              pagination={pagination}
            />
          ) : (
            <DataTable
              key={`repository-${mode}`}
              label="Usage by repository"
              rows={report.byRepository}
              columns={repositoryColumns(mode)}
              rowKey={(row) => row.repositoryId}
              pagination={pagination}
            />
          )}
        </CardContent>
      </Card>
    </section>
  )
}

