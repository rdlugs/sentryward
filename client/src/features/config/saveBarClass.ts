import { cn } from "@/lib/utils"

// SaveBar's layout, for forms that lay out their own buttons in the same bar:
// pinned to the bottom of the viewport while there are unsaved edits.
export function saveBarClass(dirty: boolean) {
  return cn("flex flex-wrap items-center gap-2 border-t pt-4", dirty && "sticky bottom-0 z-10 bg-background pb-4")
}
