import { useEffect } from "react"
import { AlertTriangle } from "lucide-react"
import { ActiveFilterChips, FilterPopover, FilterSelect, FilterToolbar, SearchInput } from "@/components/TableFilters"
import { TablePagination } from "@/components/TablePagination"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useFindings, type FindingQuery } from "./api"
import { FindingsTable } from "./FindingsTable"
import { CATEGORY_OPTIONS, KIND_OPTIONS, LIFECYCLE_OPTIONS, SEVERITY_OPTIONS, STATE_OPTIONS } from "./options"
import type { FindingRow } from "./types"
import type { FindingFilters } from "./useFindingFilters"

interface FindingListProps {
  filters: FindingFilters
  repoOptions: { value: string; label: string }[]
  // Prefixes the select ids, so two lists never share one.
  id: string
  // Fixed params the filters cannot change, e.g. only false positives.
  scope?: Partial<FindingQuery>
  showState?: boolean
  searchLabel: string
  emptyMessage: { none: string; noMatch: string }
  onOpen: (row: FindingRow) => void
}

export function FindingList({
  filters,
  repoOptions,
  id,
  scope,
  showState = false,
  searchLabel,
  emptyMessage,
  onOpen,
}: FindingListProps) {
  const { values, setters, pagination } = filters
  const { data, isPending, isError } = useFindings({ ...filters.params, ...scope })
  // A page past the end (e.g. after ignoring the last row) falls back to the last real page.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / pagination.size)) : 1
  useEffect(() => {
    if (pagination.page > lastPage) pagination.setPage(lastPage)
  }, [pagination, lastPage])

  return (
    <>
      <FilterToolbar>
        <ActiveFilterChips filters={filters.activeFilters} />
        <FilterPopover active={filters.filtering} onClear={filters.clearFilters}>
          {showState && (
            <>
              <FilterSelect
                id={`${id}-state`}
                label="State"
                allLabel="All states"
                value={values.state}
                onValueChange={setters.setState}
                options={STATE_OPTIONS}
              />
              {/* Against the change's latest review: tells a fix from a refactor. */}
              <FilterSelect
                id={`${id}-lifecycle`}
                label="Last review"
                allLabel="Any outcome"
                value={values.lifecycle}
                onValueChange={setters.setLifecycle}
                options={LIFECYCLE_OPTIONS}
              />
            </>
          )}
          <FilterSelect
            id={`${id}-severity`}
            label="Severity"
            allLabel="All severities"
            value={values.severity}
            onValueChange={setters.setSeverity}
            options={SEVERITY_OPTIONS}
          />
          <FilterSelect
            id={`${id}-category`}
            label="Category"
            allLabel="All categories"
            value={values.category}
            onValueChange={setters.setCategory}
            options={CATEGORY_OPTIONS}
          />
          <FilterSelect
            id={`${id}-kind`}
            label="Type"
            allLabel="All types"
            value={values.kind}
            onValueChange={setters.setKind}
            options={KIND_OPTIONS}
          />
          {repoOptions.length > 1 && (
            <FilterSelect
              id={`${id}-repo`}
              label="Repository"
              allLabel="All repositories"
              value={values.repo}
              onValueChange={setters.setRepo}
              options={repoOptions}
            />
          )}
        </FilterPopover>
        <SearchInput label={searchLabel} value={values.query} onChange={setters.setQuery} />
      </FilterToolbar>
      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load findings.</AlertTitle>
        </Alert>
      ) : (
        <Card>
          <CardContent>
            <FindingsTable
              findings={data.findings}
              sort={filters.sort}
              onSort={filters.onSort}
              onOpen={onOpen}
              emptyMessage={filters.narrowed ? emptyMessage.noMatch : emptyMessage.none}
            />
            {data.total > 0 && (
              <TablePagination
                page={Math.min(pagination.page, lastPage)}
                size={pagination.size}
                total={data.total}
                onPageChange={pagination.setPage}
                onSizeChange={pagination.setSize}
              />
            )}
          </CardContent>
        </Card>
      )}
    </>
  )
}
