import { useEffect } from "react"
import { useBlocker } from "react-router"

// Asks before leaving a form with unsaved edits: in-app navigation through the
// router's blocker, a reload or closed tab through beforeunload (the browser
// shows its own prompt there). Only a new pathname is blocked, so a page that
// keeps its tab or scope in ?params can still update them while dirty.
export function useUnsavedChanges(dirty: boolean) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  )

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [dirty])

  return {
    blocked: blocker.state === "blocked",
    keep: () => blocker.reset?.(),
    discard: () => blocker.proceed?.(),
  }
}
