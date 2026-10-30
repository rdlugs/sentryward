import { createContext } from "react"

// Opens the one manual review sheet the provider renders.
export const ManualReviewContext = createContext<(() => void) | null>(null)
