import { useEffect, useState } from "react"
import { Check, Circle, Loader2 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { formatDuration } from "@/lib/time"
import { cn } from "@/lib/utils"
import type { ReviewDetail, ReviewProgress as Progress, ReviewStage, ReviewStep } from "../types"

const STEP_LABELS: Record<ReviewStep, string> = {
  fetching: "Fetching the change",
  preparing: "Preparing the review",
  reviewing: "Reviewing",
  verifying: "Checking findings",
  publishing: "Publishing",
}

function stepOf(stage: ReviewStage): ReviewStep {
  return stage === "planning" || stage === "context" || stage === "walkthrough" ? "reviewing" : stage
}

function detailOf(progress: Progress): string | null {
  switch (progress.stage) {
    case "planning":
      return "Planning passes"
    case "context":
      return "Reading surrounding code"
    case "walkthrough":
      return "Writing the walkthrough"
    case "reviewing":
      return progress.passes?.total ? `${progress.passes.done} of ${progress.passes.total} passes` : null
    default:
      return null
  }
}

// Re-renders every second, so elapsed time moves between polls.
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function Elapsed({ label, since }: { label: string; since: string }) {
  const now = useNow()
  return (
    <span className="tabular-nums text-muted-foreground">
      {label} {formatDuration(now - new Date(since).getTime())}
    </span>
  )
}

export function ReviewProgress({ review }: { review: ReviewDetail }) {
  if (review.status === "queued") {
    // A job requeued after its worker stopped keeps its original createdAt and
    // records no requeue time, so a retry shows no wait it cannot measure.
    const retry = review.attempts > 0
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>{retry ? "Waiting for a worker to retry..." : "Waiting for a worker..."}</span>
          {!retry && <Elapsed label="Queued for" since={review.createdAt} />}
        </CardContent>
      </Card>
    )
  }

  const since = review.startedAt ?? review.createdAt
  const { progress } = review
  // Until the worker knows the run's config it cannot say which steps are off,
  // so only the current one is listed: the list grows once the steps are
  // known and never drops one.
  const steps = progress && (progress.steps ?? [stepOf(progress.stage)])
  const current = progress && steps ? steps.indexOf(stepOf(progress.stage)) : -1
  // A worker from before progress was recorded, one that has not written yet,
  // or a stage this client does not know.
  if (!progress || !steps || current === -1) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>Reviewing the change...</span>
          <Elapsed label="Running for" since={since} />
        </CardContent>
      </Card>
    )
  }

  const detail = detailOf(progress)
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">Review in progress</span>
          <Elapsed label="Running for" since={since} />
        </div>
        <ol aria-label="Review progress" className="flex flex-col gap-2">
          {steps.map((step, index) => {
            const done = index < current
            const active = index === current
            return (
              <li
                key={step}
                aria-current={active ? "step" : undefined}
                className={cn("flex items-center gap-2", !done && !active && "text-muted-foreground")}
              >
                {done ? (
                  <Check className="size-4 text-primary" aria-label="Done" />
                ) : active ? (
                  <Loader2 className="size-4 animate-spin" aria-label="In progress" />
                ) : (
                  <Circle className="size-4" aria-hidden />
                )}
                <span>{STEP_LABELS[step]}</span>
                {active && detail && <span className="text-muted-foreground">· {detail}</span>}
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}
