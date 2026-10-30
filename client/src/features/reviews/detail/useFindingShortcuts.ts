import { useEffect, useRef } from "react"

// Each handler returns whether it acted, so a shortcut with nothing to act on
// is left to the browser.
export type FindingShortcutHandlers = {
  next: () => boolean
  previous: () => boolean
  toggle: () => boolean
  copy: () => boolean
  help: () => boolean
}

// Keys belong to whatever is being typed into or picked from: the file filter,
// the comment type Select, the Export menu, or an open dialog.
function ownsKeys(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.closest("input, textarea, select")) return true
  return target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null
}

// Ctrl+? is Ctrl+Shift+/, which Chrome can report as "/" with Shift held.
// Matched on the character, not the physical key: on other layouts the US
// slash key is something else (Ctrl+Shift+- is zoom out on a German one).
function isHelp(event: KeyboardEvent) {
  return event.key === "?" || (event.key === "/" && event.shiftKey)
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
            u: ref.current.previous,
            o: ref.current.toggle,
            c: ref.current.copy,
          }[letter]
      // Only stops the browser's own Ctrl+J (downloads) and Ctrl+O (open file)
      // when the shortcut did something here. Ctrl+U is always stopped: on the
      // first finding, opening view source would be far worse than nothing.
      // Ctrl+K is the command palette's (see layouts/CommandPalette.tsx).
      if ((action && action()) || letter === "u") event.preventDefault()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])
}
