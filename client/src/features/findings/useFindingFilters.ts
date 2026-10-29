import type { ActiveFilter } from "@/components/TableFilters"
import { useDebounced } from "@/hooks/use-debounced"
import { usePagination } from "@/hooks/use-pagination"
import { nextSort, type Sort } from "@/hooks/use-sort"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { ALL, selectedLabel } from "@/lib/filters"
import type { FindingQuery } from "./api"
import { CATEGORY_OPTIONS, KIND_OPTIONS, LIFECYCLE_OPTIONS, SEVERITY_OPTIONS, STATE_OPTIONS } from "./options"
import type { FindingSortKey } from "./types"

const only = <T extends string>(value: string) => (value === ALL ? undefined : (value as T))

const choices = (options: { value: string }[]) => [ALL, ...options.map((option) => option.value)]

const SORT_KEYS = ["title", "number", "repository", "state", "severity", "category", "kind", "author"] satisfies FindingSortKey[]

const DEFAULTS = {
  state: ALL,
  lifecycle: ALL,
  severity: ALL,
  category: ALL,
  kind: ALL,
  repo: ALL,
  q: "",
  sort: "",
  dir: "",
}

// Repository ids are not checked: a stale one just matches nothing.
const ALLOWED = {
  state: choices(STATE_OPTIONS),
  lifecycle: choices(LIFECYCLE_OPTIONS),
  severity: choices(SEVERITY_OPTIONS),
  category: choices(CATEGORY_OPTIONS),
  kind: choices(KIND_OPTIONS),
  sort: ["", ...SORT_KEYS],
  dir: ["", "asc", "desc"],
}

type RepoOption = { value: string; label: string }

// Filters, search, sort and paging for one findings list, kept in the URL so
// they survive opening a finding's review and coming Back. The page holds one
// per tab, the second under its own param prefix (?fpState=), so each tab
// keeps its own.
export function useFindingFilters(repoOptions: RepoOption[], prefix?: string) {
  const pagination = usePagination(prefix)
  const { values: raw, set } = useUrlFilters(DEFAULTS, { prefix, allowed: ALLOWED })
  const { state, lifecycle, severity, category, kind, repo } = raw
  const q = useDebounced(raw.q.trim())
  const sort: Sort<FindingSortKey> =
    raw.sort && raw.dir ? { key: raw.sort as FindingSortKey, dir: raw.dir as "asc" | "desc" } : null

  const params: FindingQuery = {
    state: only<NonNullable<FindingQuery["state"]>>(state),
    lifecycle: only<NonNullable<FindingQuery["lifecycle"]>>(lifecycle),
    severity: only<NonNullable<FindingQuery["severity"]>>(severity),
    category: only<NonNullable<FindingQuery["category"]>>(category),
    kind: only<NonNullable<FindingQuery["kind"]>>(kind),
    repoId: only(repo),
    q: q || undefined,
    // Unsorted leaves the server's default: most recently seen first.
    sort: sort?.key,
    dir: sort?.dir,
    page: pagination.page,
    limit: pagination.size,
  }

  const filtering = state !== ALL || lifecycle !== ALL || severity !== ALL || category !== ALL || kind !== ALL || repo !== ALL
  const narrowed = filtering || q !== ""

  function onSort(key: FindingSortKey) {
    const next = nextSort(sort, key)
    set({ sort: next?.key ?? "", dir: next?.dir ?? "" })
  }

  function clearFilters() {
    set({ state: ALL, lifecycle: ALL, severity: ALL, category: ALL, kind: ALL, repo: ALL })
  }

  // Each setter starts over at the first page (useUrlFilters does that).
  const setters = {
    setState: (value: string) => set({ state: value }),
    setLifecycle: (value: string) => set({ lifecycle: value }),
    setSeverity: (value: string) => set({ severity: value }),
    setCategory: (value: string) => set({ category: value }),
    setKind: (value: string) => set({ kind: value }),
    setRepo: (value: string) => set({ repo: value }),
    setQuery: (value: string) => set({ q: value }),
  }

  const activeFilters = [
    { label: "State", value: selectedLabel(state, STATE_OPTIONS), onRemove: () => setters.setState(ALL) },
    { label: "Last review", value: selectedLabel(lifecycle, LIFECYCLE_OPTIONS), onRemove: () => setters.setLifecycle(ALL) },
    { label: "Severity", value: selectedLabel(severity, SEVERITY_OPTIONS), onRemove: () => setters.setSeverity(ALL) },
    { label: "Category", value: selectedLabel(category, CATEGORY_OPTIONS), onRemove: () => setters.setCategory(ALL) },
    { label: "Type", value: selectedLabel(kind, KIND_OPTIONS), onRemove: () => setters.setKind(ALL) },
    { label: "Repository", value: selectedLabel(repo, repoOptions), onRemove: () => setters.setRepo(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return {
    values: { state, lifecycle, severity, category, kind, repo, query: raw.q },
    setters,
    params,
    sort,
    onSort,
    pagination,
    filtering,
    narrowed,
    clearFilters,
    activeFilters,
  }
}

export type FindingFilters = ReturnType<typeof useFindingFilters>
