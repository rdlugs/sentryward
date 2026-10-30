import type { MouseEvent } from "react"

const CONTROLS = "a, button, input, select, textarea, label, [role=button], [role=menuitem]"

// Lets a click anywhere on a table row open it, while the row's own link or
// button stays the target for keyboard, middle-click and open-in-new-tab.
export function rowClick(open: () => void) {
  return (event: MouseEvent<HTMLTableRowElement>) => {
    const target = event.target as Element
    // React bubbles events through portals, so clicks in a row's menu or
    // dialogs reach the row even though they are not inside it in the DOM.
    if (!event.currentTarget.contains(target)) return
    // Controls handle their own clicks; modified clicks are the browser's.
    if (target.closest(CONTROLS)) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    // Dragging across a SHA or an error to copy it is not a click on the row.
    if (window.getSelection()?.toString()) return
    open()
  }
}
