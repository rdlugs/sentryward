import { useContext } from "react"
import { ManualReviewContext } from "./manual-review-context"

export function useStartManualReview() {
  const context = useContext(ManualReviewContext)
  if (!context) {
    throw new Error("useStartManualReview must be used within a ManualReviewProvider")
  }
  return context
}
