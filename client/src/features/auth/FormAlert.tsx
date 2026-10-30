import { CircleAlert } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

// Form-level server errors (bad credentials, rate limits) shown inside the form
// rather than as a toast, so they stay next to what the user has to fix.
export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
