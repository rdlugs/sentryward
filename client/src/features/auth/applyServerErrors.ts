import type { FieldValues, Path, UseFormSetError } from "react-hook-form"
import { toast } from "sonner"
import { ApiError } from "@/lib/api"

// Errors that don't belong to a field go to `onFormError` when the form shows
// them itself (e.g. an inline banner), otherwise to a toast.
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  onFormError?: (message: string) => void,
) {
  if (error instanceof ApiError && error.fieldErrors) {
    for (const [field, messages] of Object.entries(error.fieldErrors)) {
      if (messages?.[0]) {
        setError(field as Path<T>, { message: messages[0] })
      }
    }
    return
  }
  const message = error instanceof Error ? error.message : "Something went wrong"
  if (onFormError) onFormError(message)
  else toast.error(message)
}
