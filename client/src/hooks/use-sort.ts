import { useState } from "react"

// Null leaves the rows in the order the API returned them.
export type Sort<K extends string> = { key: K; dir: "asc" | "desc" } | null

// Each header cycles ascending -> descending -> unsorted.
export function nextSort<K extends string>(current: Sort<K>, key: K): Sort<K> {
  if (current?.key !== key) return { key, dir: "asc" }
  return current.dir === "asc" ? { key, dir: "desc" } : null
}

export function useSort<K extends string>() {
  const [sort, setSort] = useState<Sort<K>>(null)
  function onSort(key: K) {
    setSort((current) => nextSort(current, key))
  }
  return { sort, onSort }
}
