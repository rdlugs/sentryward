import { useCallback, useState, type ReactNode } from "react"
import { ManualReviewContext } from "./manual-review-context"
import { ManualReviewSheet } from "./ManualReviewSheet"

// One sheet for the whole dashboard, so the top bar, the command palette and
// the pages that offer a manual review all open the same one.
export function ManualReviewProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const start = useCallback(() => setOpen(true), [])

  return (
    <ManualReviewContext.Provider value={start}>
      {children}
      <ManualReviewSheet open={open} onOpenChange={setOpen} />
    </ManualReviewContext.Provider>
  )
}
