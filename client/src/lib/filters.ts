// Every filter select starts on this value, which matches all rows.
export const ALL = "all"

// The query value for a filter select: nothing while it is on ALL.
export const only = <T extends string>(value: string) => (value === ALL ? undefined : (value as T))

// The values a filter select may hold in the URL (see useUrlFilters).
export const choices = (options: { value: string }[]) => [ALL, ...options.map((option) => option.value)]

export function matchesQuery(query: string, ...fields: string[]) {
  const needle = query.trim().toLowerCase()
  return !needle || fields.some((field) => field.toLowerCase().includes(needle))
}

// Label of the selected option, or null while a filter is on ALL.
export function selectedLabel(value: string, options: { value: string; label: string }[]) {
  if (value === ALL) return null
  return options.find((option) => option.value === value)?.label ?? null
}
