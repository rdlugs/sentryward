import { useSearchParams } from "react-router"
import { paginationKeys } from "./use-pagination"

// The search param a filter lives in: ?status=, or ?fpStatus= with a prefix,
// matching the prefixed pagination params of a second table on the page.
function paramName(key: string, prefix?: string) {
  return prefix ? `${prefix}${key[0].toUpperCase()}${key.slice(1)}` : key
}

// A table's filters, search and sort kept in the URL, so Back from a row
// restores the view and a copied link reproduces it. Defaults are left out of
// the URL, and a value outside `allowed` (a stale or hand-edited link) reads
// as the default. Every change starts over at page 1 in the same update: two
// setSearchParams calls in one tick would each start from the same params and
// the second would undo the first.
export function useUrlFilters<K extends string>(
  defaults: Record<K, string>,
  options: { prefix?: string; allowed?: Partial<Record<K, readonly string[]>> } = {},
) {
  const [params, setParams] = useSearchParams()
  const keys = Object.keys(defaults) as K[]

  const values = {} as Record<K, string>
  for (const key of keys) {
    const raw = params.get(paramName(key, options.prefix))
    const allowed = options.allowed?.[key]
    values[key] = raw === null || (allowed && !allowed.includes(raw)) ? defaults[key] : raw
  }

  function set(next: Partial<Record<K, string>>) {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current)
        for (const key of Object.keys(next) as K[]) {
          const value = next[key]!
          if (value === defaults[key]) updated.delete(paramName(key, options.prefix))
          else updated.set(paramName(key, options.prefix), value)
        }
        updated.delete(paginationKeys(options.prefix).page)
        return updated
      },
      { replace: true },
    )
  }

  return { values, set }
}
