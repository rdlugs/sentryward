import { TablePagination } from "@/components/TablePagination"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CATEGORY_LABEL } from "@/features/findings/options"
import type { FindingCategory } from "@/features/findings/types"
import { formatCount } from "@/features/usage/format"
import { Segmented } from "@/features/usage/Segmented"
import { PAGE_SIZES, paginate, usePagination, type Pagination } from "@/hooks/use-pagination"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { formatDuration } from "@/lib/time"
import { cn } from "@/lib/utils"
import { Cost, Dash, Rate } from "./format"
import type { BenchmarkReport, Breakdown } from "./types"

const numeric = "text-right tabular-nums"

// One prefix per table (?modelsPage=, ?bestPage=, ?reposPage=), so the three
// keep their page and size apart in the URL.
export const MODELS_PAGINATION = "models"
export const BEST_PAGINATION = "best"
export const REPOS_PAGINATION = "repos"

// Under a table, and only once it can run to a second page: three tables are
// stacked here, and a bar of disabled controls under each short one is noise.
// A table that fits the smallest size fits every size, so nothing is hidden.
function Pager({ page, pagination }: { page: { page: number; total: number }; pagination: Pagination }) {
  if (page.total <= PAGE_SIZES[0]) return null
  return (
    <TablePagination
      page={page.page}
      size={pagination.size}
      total={page.total}
      onPageChange={pagination.setPage}
      onSizeChange={pagination.setSize}
    />
  )
}

function Empty({ colSpan, children }: { colSpan: number; children: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-6 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  )
}

export function ModelTable({ report }: { report: BenchmarkReport }) {
  const pagination = usePagination(MODELS_PAGINATION)
  const page = paginate(report.byModel, pagination.page, pagination.size)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Models</CardTitle>
        <CardDescription>Cost, tokens and call time per model, and how the findings it raised turned out.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label="Benchmarks by model">
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Reviews</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Est. cost</TableHead>
              <TableHead className="text-right">Per review</TableHead>
              <TableHead className="text-right">Mean call</TableHead>
              <TableHead className="text-right">Found</TableHead>
              <TableHead className="text-right">Confirmed</TableHead>
              <TableHead className="text-right">False positives</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.map((row) => (
              <TableRow key={row.model}>
                <TableCell className="font-mono text-xs">{row.model}</TableCell>
                <TableCell className={numeric}>{formatCount(row.reviews)}</TableCell>
                <TableCell className={numeric}>{formatCount(row.inputTokens + row.outputTokens)}</TableCell>
                <TableCell className={numeric}>
                  <Cost usd={row.cost.usd} partial={row.cost.partial} />
                </TableCell>
                <TableCell className={numeric}>
                  <Cost usd={row.cost.perReview} partial={row.cost.partial} />
                </TableCell>
                <TableCell className={numeric}>{row.meanLatencyMs === null ? <Dash /> : formatDuration(row.meanLatencyMs)}</TableCell>
                <TableCell className={numeric}>{formatCount(row.findings.found)}</TableCell>
                <TableCell className={numeric}><Rate value={row.findings.confirmedRate} /></TableCell>
                <TableCell className={numeric}><Rate value={row.findings.falsePositiveRate} /></TableCell>
              </TableRow>
            ))}
            {page.total === 0 && <Empty colSpan={9}>No model calls in this period.</Empty>}
          </TableBody>
        </Table>
        <Pager page={page} pagination={pagination} />
      </CardContent>
    </Card>
  )
}

export function RepositoryTable({ report }: { report: BenchmarkReport }) {
  const pagination = usePagination(REPOS_PAGINATION)
  const page = paginate(report.byRepository, pagination.page, pagination.size)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Repositories</CardTitle>
        <CardDescription>What reviewing each repository cost and took, and how often findings repeated.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label="Benchmarks by repository">
          <TableHeader>
            <TableRow>
              <TableHead>Repository</TableHead>
              <TableHead className="text-right">Reviews</TableHead>
              <TableHead className="text-right">Est. cost</TableHead>
              <TableHead className="text-right">Per review</TableHead>
              <TableHead className="text-right">Median duration</TableHead>
              <TableHead className="text-right">Found</TableHead>
              <TableHead className="text-right">Confirmed</TableHead>
              <TableHead className="text-right">False positives</TableHead>
              <TableHead className="text-right">Duplicates</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.map((row) => (
              <TableRow key={row.repositoryId}>
                <TableCell>{row.fullPath}</TableCell>
                <TableCell className={numeric}>{formatCount(row.reviews)}</TableCell>
                <TableCell className={numeric}>
                  <Cost usd={row.cost.usd} partial={row.cost.partial} />
                </TableCell>
                <TableCell className={numeric}>
                  <Cost usd={row.cost.perReview} partial={row.cost.partial} />
                </TableCell>
                <TableCell className={numeric}>{row.medianDurationMs === null ? <Dash /> : formatDuration(row.medianDurationMs)}</TableCell>
                <TableCell className={numeric}>{formatCount(row.findings.found)}</TableCell>
                <TableCell className={numeric}><Rate value={row.findings.confirmedRate} /></TableCell>
                <TableCell className={numeric}><Rate value={row.findings.falsePositiveRate} /></TableCell>
                <TableCell className={numeric}><Rate value={row.duplicates.rate} /></TableCell>
              </TableRow>
            ))}
            {page.total === 0 && <Empty colSpan={9}>No reviews in this period.</Empty>}
          </TableBody>
        </Table>
        <Pager page={page} pagination={pagination} />
      </CardContent>
    </Card>
  )
}

const GROUP_VALUES = ["language", "category"] as const
type Group = (typeof GROUP_VALUES)[number]

const GROUPS: { value: Group; label: string }[] = [
  { value: "language", label: "By language" },
  { value: "category", label: "By category" },
]

function groupLabel(group: Group, key: string) {
  if (group === "language") return key === "other" ? "Other" : key
  return key === "other" ? "Other" : (CATEGORY_LABEL[key as FindingCategory] ?? key)
}

// Each language or category, then its models. The best model (enough decided
// findings, highest confirmed rate) is marked; rows with too few findings to
// judge are dimmed rather than hidden, since a small team may have only those.
export function BreakdownTable({ report }: { report: BenchmarkReport }) {
  // ?bestGroup= sits beside ?bestPage=, so a reloaded or shared link opens on
  // the list its page belongs to. Changing it starts over at page 1 in the
  // same URL update (see useUrlFilters): the other grouping is a different list.
  const filters = useUrlFilters({ group: "language" }, { prefix: BEST_PAGINATION, allowed: { group: GROUP_VALUES } })
  const group = filters.values.group as Group
  const groups: Breakdown[] = group === "language" ? report.byLanguage : report.byCategory
  const label = group === "language" ? "Language" : "Category"
  const pagination = usePagination(BEST_PAGINATION)
  // Paged by model row, not by language or category: a group has as many rows
  // as it has models, so paging by group would leave the table's length open.
  const rows = groups.flatMap((entry) => entry.models.map((model, index) => ({ entry, model, first: index === 0 })))
  const page = paginate(rows, pagination.page, pagination.size)
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Best model</CardTitle>
          <CardDescription>
            Findings per model, with rates over those resolved or dismissed as false positives. Best is the highest
            confirmed rate among models with at least {report.minSample} such findings.
          </CardDescription>
        </div>
        <Segmented label="Break down findings" options={GROUPS} value={group} onChange={(next) => filters.set({ group: next })} />
      </CardHeader>
      <CardContent>
        <Table aria-label={`Findings by ${label.toLowerCase()} and model`}>
          <TableHeader>
            <TableRow>
              <TableHead>{label}</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Found</TableHead>
              <TableHead className="text-right">Confirmed</TableHead>
              <TableHead className="text-right">False positives</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.map(({ entry, model, first }, index) => {
              const few = model.decided < report.minSample
              return (
                <TableRow key={`${entry.key}:${model.model ?? "tools"}`} className={cn(few && "text-muted-foreground")}>
                  {/* Named on its first model, and again at the top of a page
                      it runs onto, so no page starts with unnamed rows. */}
                  <TableCell className="font-medium">{first || index === 0 ? groupLabel(group, entry.key) : null}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      {model.model === null ? (
                        <span className="text-muted-foreground">Tools and rules</span>
                      ) : (
                        <span className="font-mono text-xs">{model.model}</span>
                      )}
                      {model.model !== null && model.model === entry.best && <Badge>Best</Badge>}
                      {few && <span className="text-xs">few findings</span>}
                    </div>
                  </TableCell>
                  <TableCell className={numeric}>{formatCount(model.found)}</TableCell>
                  <TableCell className={numeric}><Rate value={model.confirmedRate} /></TableCell>
                  <TableCell className={numeric}><Rate value={model.falsePositiveRate} /></TableCell>
                </TableRow>
              )
            })}
            {page.total === 0 && <Empty colSpan={5}>No findings in this period.</Empty>}
          </TableBody>
        </Table>
        <Pager page={page} pagination={pagination} />
      </CardContent>
    </Card>
  )
}
