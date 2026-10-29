import { useEffect } from "react"
import { useBlocker } from "react-router"

// Asks before leaving a form with unsaved edits: in-app navigation through the
// router's blocker, a reload or closed tab through beforeunload (the browser
// shows its own prompt there). A new pathname is always blocked; so is a change
// to any of `scopeParams`, the ?params that swap or unmount the form (a scope,
// or a tab whose content is not kept mounted). Other ?params, such as a tab
// whose fields stay in form state, can still change while dirty.
export function useUnsavedChanges(dirty: boolean, scopeParams: string[] = []) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!dirty) return false
    if (currentLocation.pathname !== nextLocation.pathname) return true
    const current = new URLSearchParams(currentLocation.search)
    const next = new URLSearchParams(nextLocation.search)
    return scopeParams.some((param) => current.get(param) !== next.get(param))
  })

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
