import { Link } from "react-router"
import { AlertTriangle, Info } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  errorMessage,
  EVENT_OPTIONS,
  usePersonalNotifications,
  useUpdatePersonalNotifications,
  type NotificationEvent,
  type PersonalForge,
} from "./api"

const FORGE_LABELS: Record<PersonalForge["provider"], string> = { github: "GitHub", gitlab: "GitLab" }

// Every member's own email about reviews of changes they opened. Each change
// saves at once, like a target's Active switch. Changes are matched through a
// linked sign-in account, so hosts without one are called out.
export function PersonalNotifications() {
  const { data, isPending } = usePersonalNotifications()
  const update = useUpdatePersonalNotifications()

  async function save(input: { enabled: boolean; events: NotificationEvent[] }) {
    try {
      await update.mutateAsync(input)
    } catch (error) {
      toast.error(errorMessage(error, "Could not save your notifications"))
    }
  }

  // While a save is in flight, show what was asked for.
  const current = update.isPending ? update.variables : data
  const unlinked = data?.forges.filter((forge) => !forge.linked) ?? []
  const disabled = !data || update.isPending || (!data.mailConfigured && !data.enabled)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your pull requests</CardTitle>
        <CardDescription>
          Email me when a review of a pull or merge request I opened finishes. Only you see this setting.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isPending || !data || !current ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            {!data.mailConfigured && (
              <Alert>
                <Info />
                <AlertTitle>Mail is not configured</AlertTitle>
                <AlertDescription>An administrator needs to set SMTP_URL before you can switch this on.</AlertDescription>
              </Alert>
            )}
            {data.pausedReason && (
              <Alert>
                <AlertTriangle />
                <AlertTitle>{data.pausedReason}</AlertTitle>
                <AlertDescription>Switching it back on clears this notice.</AlertDescription>
              </Alert>
            )}
            {unlinked.length > 0 && (
              <Alert>
                <Info />
                <AlertTitle>Link your forge account</AlertTitle>
                <AlertDescription>
                  <p>
                    Your changes are recognised through a linked sign-in account. Link{" "}
                    {unlinked.map((forge) => `${FORGE_LABELS[forge.provider]} (${forge.host})`).join(", ")} under{" "}
                    <Link to="/settings?tab=sign-in" className="underline underline-offset-4">
                      Settings, Sign-in methods
                    </Link>
                    .
                  </p>
                </AlertDescription>
              </Alert>
            )}
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
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Events</FieldLegend>
              <div className="flex flex-col gap-2">
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
                        disabled={update.isPending || last}
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
            </FieldSet>
          </>
        )}
      </CardContent>
    </Card>
  )
}
