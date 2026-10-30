import * as React from "react"

const MOBILE_BREAKPOINT = 768
// Tailwind's `sm`: below it the main lists render as cards instead of tables.
const SM_BREAKPOINT = 640

// Cached per query so useSyncExternalStore sees a stable subscribe and doesn't
// resubscribe on every render.
const stores = new Map<string, { subscribe: (onChange: () => void) => () => void; getSnapshot: () => boolean }>()

function store(query: string) {
  let entry = stores.get(query)
  if (!entry) {
    entry = {
      subscribe(onChange) {
        const mql = window.matchMedia(query)
        mql.addEventListener("change", onChange)
        return () => mql.removeEventListener("change", onChange)
      },
      getSnapshot: () => window.matchMedia(query).matches,
    }
    stores.set(query, entry)
  }
  return entry
}

function getServerSnapshot() {
  return false
}

export function useMediaQuery(query: string) {
  const { subscribe, getSnapshot } = store(query)
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export function useIsMobile() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
}

export function useIsBelowSm() {
  return useMediaQuery(`(max-width: ${SM_BREAKPOINT - 1}px)`)
}
