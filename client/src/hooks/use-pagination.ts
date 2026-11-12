import { useSearchParams } from "react-router"

export const PAGE_SIZES = [10, 25, 50, 100]
const DEFAULT_SIZE = PAGE_SIZES[0]

function parsePage(raw: string | null) {
  const page = Number(raw)
  return Number.isInteger(page) && page >= 1 ? page : 1
}

function parseSize(raw: string | null) {
  const size = Number(raw)
  return PAGE_SIZES.includes(size) ? size : DEFAULT_SIZE
}

// The search params a table's pagination lives in, e.g. ?fpPage= and ?fpSize=.
export function paginationKeys(prefix?: string) {
  return prefix ? { page: `${prefix}Page`, size: `${prefix}Size` } : { page: "page", size: "size" }
}

// Drops each table's page from the params, for an updater that changes what the
// tables list (another period, filter or grouping): they start over at page 1.
export function resetPages(params: URLSearchParams, prefixes: (string | undefined)[]) {
  for (const prefix of prefixes) params.delete(paginationKeys(prefix).page)
}

// ?page= and ?size= keep the current page linkable and survive a reload.
// Defaults are left out of the URL, and other params (e.g. ?tab=) are kept.
// A prefix gives a second table on the same page its own params (?fpPage=).
export function usePagination(prefix?: string) {
  const [params, setParams] = useSearchParams()
  const { page: pageKey, size: sizeKey } = paginationKeys(prefix)
  const page = parsePage(params.get(pageKey))
  const size = parseSize(params.get(sizeKey))

  function update(next: { page: number; size: number }) {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current)
        if (next.page === 1) updated.delete(pageKey)
        else updated.set(pageKey, String(next.page))
        if (next.size === DEFAULT_SIZE) updated.delete(sizeKey)
        else updated.set(sizeKey, String(next.size))
        return updated
      },
      { replace: true },
    )
  }

  return {
    page,
    size,
    setPage: (next: number) => {
      if (next !== page) update({ page: next, size })
    },
    // A new size changes what each page holds, so start over at page 1.
    setSize: (next: number) => update({ page: 1, size: next }),
  }
}

export type Pagination = ReturnType<typeof usePagination>

// Clamps to the last page so a filter that shrinks the list never strands the
// table on an empty page.
export function paginate<T>(rows: T[], page: number, size: number) {
  const lastPage = Math.max(1, Math.ceil(rows.length / size))
  const current = Math.min(page, lastPage)
  return { rows: rows.slice((current - 1) * size, current * size), total: rows.length, page: current }
}
