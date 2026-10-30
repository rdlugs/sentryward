import { useSyncExternalStore } from "react"

// The auth brand panel only shows from `lg`. Its animations run while it is on
// screen, the tab is visible and the user hasn't asked for reduced motion; in
// jsdom matchMedia never matches, so tests always see the still versions.
const WIDE = "(min-width: 64rem)"
const REDUCED = "(prefers-reduced-motion: reduce)"

function subscribe(onChange: () => void) {
  const queries = [window.matchMedia(WIDE), window.matchMedia(REDUCED)]
  for (const query of queries) query.addEventListener("change", onChange)
  document.addEventListener("visibilitychange", onChange)
  return () => {
    for (const query of queries) query.removeEventListener("change", onChange)
    document.removeEventListener("visibilitychange", onChange)
  }
}

// A string snapshot so useSyncExternalStore can compare it by value.
function snapshot() {
  return [window.matchMedia(WIDE).matches, window.matchMedia(REDUCED).matches, !document.hidden].join()
}

export function usePanelMotion() {
  const [wide, reduced, visible] = useSyncExternalStore(subscribe, snapshot).split(",").map((v) => v === "true")
  return { wide, reduced, active: wide && !reduced && visible }
}
