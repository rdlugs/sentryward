import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { SeverityBadge, VerdictBadge } from "@/features/reviews/badges"
import { DEMO_SCENARIOS, type DemoLine } from "./demoScenarios"
import { usePanelMotion } from "./usePanelMotion"

// Phases of one scenario: the diff alone, the review running, the finding's
// title typing in, its body and fix showing, and the verdict.
const DIFF = 0
const REVIEWING = 1
const TYPING = 2
const DETAILS = 3
const VERDICT = 4

const AFTER_MS: Record<number, number> = { [DIFF]: 400, [REVIEWING]: 1100, [DETAILS]: 1200, [VERDICT]: 3500 }
const TYPE_MS = 25

interface Step {
  scenario: number
  phase: number
  typed: number
}

// Still versions (reduced motion, panel hidden, tests) show the first example
// finished, so nothing depends on timing.
const FINISHED: Step = { scenario: 0, phase: VERDICT, typed: Infinity }

function next(step: Step): { step: Step; delay: number } {
  const { title } = DEMO_SCENARIOS[step.scenario]
  if (step.phase === TYPING) {
    return step.typed < title.length
      ? { step: { ...step, typed: step.typed + 1 }, delay: TYPE_MS }
      : { step: { ...step, phase: DETAILS }, delay: 300 }
  }
  if (step.phase === VERDICT) {
    return { step: { scenario: (step.scenario + 1) % DEMO_SCENARIOS.length, phase: DIFF, typed: 0 }, delay: AFTER_MS[VERDICT] }
  }
  return { step: { ...step, phase: step.phase + 1 }, delay: AFTER_MS[step.phase] }
}

const LINE_CLASS: Record<DemoLine["kind"], string> = {
  context: "text-muted-foreground",
  add: "bg-emerald-500/10 text-foreground",
  del: "bg-destructive/10 text-muted-foreground line-through decoration-destructive/40",
}
const GUTTER: Record<DemoLine["kind"], string> = { context: " ", add: "+", del: "-" }

// A made-up review playing out on the auth brand panel: a small diff, then
// Sentryward's inline finding with a suggested fix, then the commit status
// verdict, cycling through a few examples. Decorative, so hidden from
// assistive tech; the panel's headline says the same in words.
export function ReviewDemo({ className }: { className?: string }) {
  const { active } = usePanelMotion()
  const [step, setStep] = useState<Step>({ scenario: 0, phase: DIFF, typed: 0 })

  useEffect(() => {
    if (!active) return
    const { step: following, delay } = next(step)
    const timer = setTimeout(() => setStep(following), delay)
    return () => clearTimeout(timer)
  }, [active, step])

  const shown = active ? step : FINISHED
  const scenario = DEMO_SCENARIOS[shown.scenario]

  return (
    <div
      aria-hidden
      className={cn("overflow-hidden rounded-xl border bg-card/85 text-xs shadow-lg backdrop-blur", className)}
    >
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2">
        <span className="truncate font-mono text-muted-foreground">{scenario.file}</span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          sentryward/review
          {shown.phase === VERDICT ? (
            <span key={`verdict-${shown.scenario}`} className="animate-in fade-in">
              <VerdictBadge verdict={scenario.verdict} />
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-1.5 rounded-full bg-sky-400",
                  shown.phase >= REVIEWING && "animate-pulse",
                )}
              />
              {shown.phase >= REVIEWING ? "Reviewing…" : "Queued"}
            </span>
          )}
        </span>
      </div>
      <div key={shown.scenario} className="animate-in py-1 font-mono leading-5 fade-in">
        {scenario.lines.map((line, index) => (
          <div key={index}>
            <div className={cn("flex gap-3 px-3 whitespace-pre", LINE_CLASS[line.kind])}>
              <span className="w-2 shrink-0 select-none opacity-60">{GUTTER[line.kind]}</span>
              <span className="truncate">{line.text}</span>
            </div>
            {index === scenario.commentLine && shown.phase >= TYPING && (
              <div className="mx-3 my-2 animate-in rounded-lg border bg-background/80 p-3 font-sans fade-in slide-in-from-top-1">
                <div className="flex items-center gap-2">
                  <img src="/sentryward-192.png" alt="" className="size-4" />
                  <span className="font-medium">Sentryward</span>
                  <SeverityBadge severity={scenario.severity} />
                </div>
                <p className="mt-2 min-h-5 font-medium">
                  {scenario.title.slice(0, shown.typed)}
                  {shown.phase === TYPING && <span className="ml-px inline-block h-3.5 w-px animate-pulse bg-foreground align-middle" />}
                </p>
                {shown.phase >= DETAILS && (
                  <div className="animate-in fade-in">
                    <p className="mt-1 text-muted-foreground">{scenario.body}</p>
                    <div className="mt-2 overflow-hidden rounded-md border">
                      <div className="border-b bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">Suggested change</div>
                      <div className="truncate bg-emerald-500/10 px-2 py-1 font-mono whitespace-pre">+ {scenario.suggestion}</div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
