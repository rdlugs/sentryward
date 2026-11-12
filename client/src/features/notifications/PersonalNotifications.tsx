import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { AlertTriangle, Circle, CircleCheck } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useAuth } from "@/features/auth/useAuth"
import { forgeOrigin, PROVIDERS } from "@/features/forge/providers"
import {
  errorMessage,
  EVENT_OPTIONS,
  usePersonalNotifications,
  useUpdatePersonalNotifications,
  type NotificationEvent,
  type PersonalForge,
} from "./api"

// How long "Saved" stays next to the switch after a save.
const SAVED_MS = 2000

// "github.com" rather than "https://github.com/": a self-hosted forge stored
// with its scheme reads like the rest.
function displayHost(host: string): string {
  try {
    return new URL(forgeOrigin(host)).host
  } catch {
    return host
  }
}

function forgeName(forge: PersonalForge): string {
  return `${PROVIDERS[forge.provider].label} account (${displayHost(forge.host)})`
}

function Step({ done, children }: { done: boolean; children: ReactNode }) {
  const Icon = done ? CircleCheck : Circle
  return (
    <li className="flex items-start gap-2">
      <Icon className={done ? "mt-0.5 size-4 shrink-0 text-emerald-600" : "mt-0.5 size-4 shrink-0 text-muted-foreground"} />
      <span className={done ? "text-muted-foreground" : undefined}>
        <span className="sr-only">{done ? "Done: " : "To do: "}</span>
        {children}
      </span>
    </li>
  )
}

// Every member's own email about reviews of changes they opened. Each change
// saves at once, like a target's Active switch. Changes are matched through a
// linked sign-in account, so hosts without one are listed as a step to take.
export function PersonalNotifications() {
  const { user } = useAuth()
  const { data, isPending } = usePersonalNotifications()
  const update = useUpdatePersonalNotifications()
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(savedTimer.current), [])

  async function save(input: { enabled: boolean; events: NotificationEvent[] }) {
    clearTimeout(savedTimer.current)
    setSaved(false)
    try {
      await update.mutateAsync(input)
      setSaved(true)
      savedTimer.current = setTimeout(() => setSaved(false), SAVED_MS)
    } catch (error) {
      toast.error(errorMessage(error, "Could not save your notifications"))
    }
  }

  // While a save is in flight, show what was asked for.
  const current = update.isPending ? update.variables : data
  // Mail is the one thing that blocks switching on; unlinked forges only mean
  // changes there are not recognised.
  const disabled = !data || update.isPending || (!data.mailConfigured && !data.enabled)
  const eventsDisabled = disabled || !current?.enabled
  const missing = data ? !data.mailConfigured || data.forges.some((forge) => !forge.linked) : false

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email about my changes</CardTitle>
        <CardDescription>When a review of a pull or merge request you opened finishes.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isPending || !data || !current ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <Field orientation="horizontal">
              <Switch
                id="personal-enabled"
                checked={current.enabled}
                onCheckedChange={(enabled) => save({ enabled, events: current.events })}
                disabled={disabled}
              />
              <FieldLabel htmlFor="personal-enabled" className="font-normal">
                Email me about reviews of my changes
              </FieldLabel>
              <span role="status" className="ml-auto text-xs text-muted-foreground">
                {update.isPending ? "Saving…" : saved ? "Saved" : null}
              </span>
            </Field>

            {data.pausedReason && (
              <Alert>
                <AlertTriangle />
                <AlertTitle>{data.pausedReason}</AlertTitle>
                <AlertDescription>Switching it back on clears this notice.</AlertDescription>
              </Alert>
            )}

            {missing && (
              <div className="rounded-md border p-3 text-sm">
                <p className="mb-2 font-medium">Before this can email you</p>
                <ul className="flex flex-col gap-1.5">
                  <Step done={data.mailConfigured}>
                    {data.mailConfigured ? (
                      "Email is set up for Sentryward"
                    ) : (
                      <>
                        Ask an administrator to set up email for Sentryward
                        {user?.role === "admin" && (
                          <>
                            {" "}
                            (set <code className="font-mono text-xs">SMTP_URL</code>)
                          </>
                        )}
                      </>
                    )}
                  </Step>
                  {data.forges.map((forge) => (
                    <Step key={`${forge.provider}:${forge.host}`} done={forge.linked}>
                      {forge.linked ? (
                        `Linked your ${forgeName(forge)}`
                      ) : (
                        <>
                          Link your {forgeName(forge)}.{" "}
                          <Link to="/settings?tab=sign-in" className="underline underline-offset-4">
                            Link account
                          </Link>
                        </>
                      )}
                    </Step>
                  ))}
                </ul>
              </div>
            )}

            <FieldSet>
              <FieldLegend variant="label">Events</FieldLegend>
              {!current.enabled && (
                <FieldDescription>Switch on to choose events.</FieldDescription>
              )}
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {EVENT_OPTIONS.map((option) => {
                  const id = `personal-event-${option.value}`
                  const checked = current.events.includes(option.value)
                  // At least one event stays chosen, as the server requires.
                  const last = checked && current.events.length === 1
                  return (
                    <Field key={option.value} orientation="horizontal">
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={eventsDisabled || last}
                        onCheckedChange={(on) =>
                          save({
                            enabled: current.enabled,
                            events:
                              on === true
                                ? [...current.events, option.value]
                                : current.events.filter((event) => event !== option.value),
                          })
                        }
                      />
                      <FieldContent>
                        <FieldLabel htmlFor={id} className="font-normal">
                          {option.label}
                        </FieldLabel>
                        <FieldDescription>{option.description}</FieldDescription>
                      </FieldContent>
                    </Field>
                  )
                })}
              </div>
              {/* A blocked or resolved review is also a completed one (eventsFor
                  on the server); a failed one is not. */}
              {current.events.includes("completed") && (
                <FieldDescription>
                  Completed already covers blocked and resolved reviews. Failed reviews are separate.
                </FieldDescription>
              )}
            </FieldSet>
          </>
        )}
      </CardContent>
    </Card>
  )
}
