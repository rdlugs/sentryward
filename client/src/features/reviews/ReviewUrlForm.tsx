import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { reviewUrlErrorMessage, useCreateReview } from "./api"

export function ReviewUrlForm({ onQueued }: { onQueued?: () => void }) {
  const [url, setUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const createReview = useCreateReview()
  const navigate = useNavigate()

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      const { review } = await createReview.mutateAsync({ url })
      setUrl("")
      onQueued?.()
      navigate(`/reviews/${review.id}`)
    } catch (err) {
      setError(reviewUrlErrorMessage(err))
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor="review-url">Review a pull or merge request</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="review-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/acme/web/pull/42"
            aria-invalid={Boolean(error)}
          />
          <Button type="submit" disabled={createReview.isPending || !url.trim()}>
            {createReview.isPending && <Loader2 className="animate-spin" />}
            Review
          </Button>
        </div>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    </form>
  )
}
