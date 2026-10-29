import { Link } from "react-router"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { SetupStep } from "./useSetupProgress"

function StepAction({ step, primary, onReview }: { step: SetupStep; primary: boolean; onReview: () => void }) {
  const variant = primary ? "default" : "outline"
  if (!step.action.to) {
    return (
      <Button type="button" size="sm" variant={variant} onClick={onReview}>
        {step.action.label}
      </Button>
    )
  }
  return (
    <Button asChild size="sm" variant={variant}>
      <Link to={step.action.to}>{step.action.label}</Link>
    </Button>
  )
}

// Every setup step with the finished ones ticked; only the next one gets the
// primary button. Gone once everything is done. Nothing renders while loading:
// most visits are from finished setups, where a placeholder would only collapse.
export function SetupChecklist({
  steps,
  isPending,
  onReview,
}: {
  steps: SetupStep[]
  isPending: boolean
  onReview: () => void
}) {
  if (isPending) return null

  const next = steps.find((step) => !step.done)
  if (!next) return null
  const doneCount = steps.filter((step) => step.done).length

  return (
    <Card className="bg-gradient-to-br from-muted/70 via-card to-card">
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Finish setting up</h2>
          <p className="text-sm text-muted-foreground">
            {doneCount} of {steps.length} steps done
          </p>
        </div>
        <ol className="flex flex-col gap-4" aria-label="Setup steps">
          {steps.map((step, index) => (
            <li key={step.id} className="flex items-start gap-3" aria-current={step === next ? "step" : undefined}>
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
                  step.done && "border-emerald-600 bg-emerald-600 text-white",
                )}
                aria-hidden
              >
                {step.done ? <Check className="size-3.5" strokeWidth={3} /> : index + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <h3 className={cn("text-sm font-medium", step.done && "text-muted-foreground line-through")}>
                  {step.title}
                  {/* The space sits outside the span: accessible names trim each element's text. */}
                  {step.done && <>{" "}<span className="sr-only">(done)</span></>}
                </h3>
                {!step.done && (
                  <>
                    <p className="text-sm text-muted-foreground">{step.text}</p>
                    {step.blocked ? (
                      <p className="text-sm text-muted-foreground">{step.blocked}</p>
                    ) : (
                      <div className="mt-1">
                        <StepAction step={step} primary={step === next} onReview={onReview} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
