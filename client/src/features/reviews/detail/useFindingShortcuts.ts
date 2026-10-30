import { useEffect, useRef } from "react"

export type FindingShortcutHandlers = {
  next: () => void
  previous: () => void
  toggle: () => void
  copy: () => void
  help: () => void
}

// Keys belong to whatever is being typed into or picked from: the file filter,
// the comment type Select, the Export menu, or an open dialog.
function ownsKeys(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.closest("input, textarea, select")) return true
  return target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null
}

// Ctrl+? is Ctrl+Shift+/ on US layouts; code catches layouts that report "/" as the key.
function isHelp(event: KeyboardEvent) {
  return event.key === "?" || (event.code === "Slash" && event.shiftKey)
}

function hasSelection() {
  const selection = window.getSelection()
  return selection !== null && !selection.isCollapsed
}

// Ctrl + key shortcuts for the findings list. Enter is not handled here: the
// focused card trigger is a button, so it already toggles natively. Cmd is
// left alone so Cmd+C stays copy on macOS.
export function useFindingShortcuts(handlers: FindingShortcutHandlers) {
  // Read through a ref so the listener is bound once, not on every render.
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !event.ctrlKey || event.metaKey || event.altKey) return
      if (ownsKeys(event.target)) return
      const letter = event.shiftKey ? undefined : event.key.toLowerCase()
      // Selected text still copies as usual; the agent prompt is for when nothing is selected.
      if (letter === "c" && hasSelection()) return
      const action = isHelp(event)
        ? ref.current.help
        : letter && {
            j: ref.current.next,
            k: ref.current.previous,
            o: ref.current.toggle,
            c: ref.current.copy,
          }[letter]
      if (!action) return
      // Also stops the browser's own Ctrl+J (downloads), Ctrl+K (search) and Ctrl+O (open file).
      event.preventDefault()
      action()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])
}
