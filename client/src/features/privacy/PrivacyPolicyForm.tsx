import { useEffect } from "react"
import { Controller, useForm, type Control } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { cn } from "cn"
import { MultiSelect } from "@/components/MultiSelect"
import { TagInput } from "@/components/TagInput"
import { UnsavedChangesDialog } from "@/components/UnsavedChangesDialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Switch } from "@/components/ui/switch"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { LLM_PROVIDERS } from "@/features/llm-connections/providers"
import { PROVIDER_OPTIONS, type InstanceSettings, type PolicyLayer } from "./api"

// Days are typed as text so an empty box can mean "no limit".
const daysField = z
  .string()
  .trim()
  .refine((value) => value === "" || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 3650), {
    message: "Enter 1 to 3650 days, or leave empty",
  })

const policySchema = z.object({
  allowedProviders: z.array(z.enum(["anthropic", "openai", "google", "ollama"])),
  allowedHosts: z.array(z.string()),
  localOnly: z.boolean(),
  retentionDays: daysField,
  auditRetentionDays: daysField,
})
type PolicyInput = z.infer<typeof policySchema>

const RETENTION_PRESETS = [30, 90, 365]

const toText = (days: number | null | undefined) => (days == null ? "" : String(days))
const toDays = (text: string) => (text.trim() === "" ? null : Number(text))

function toInput(values: PolicyLayer & { auditRetentionDays?: number | null }): PolicyInput {
  return {
    allowedProviders: values.allowedProviders,
    allowedHosts: values.allowedHosts,
    localOnly: values.localOnly,
    retentionDays: toText(values.retentionDays),
    auditRetentionDays: toText(values.auditRetentionDays),
  }
}

function InstanceBadge() {
  return (
    <Badge variant="secondary" className="font-normal">
      Set by instance
    </Badge>
  )
}

// A days box with a unit suffix and one-click presets. The last preset clears
// the box; presets above `max` (the instance limit) are disabled.
function RetentionField(props: {
  control: Control<PolicyInput>
  name: "retentionDays" | "auditRetentionDays"
  label: string
  // The section heading already says "retention"; the input's name keeps it.
  accessibleLabel: string
  foreverLabel: string
  hint: string
  max?: number | null
  disabled?: boolean
}) {
  const { max, disabled } = props
  return (
    <Controller
      control={props.control}
      name={props.name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={props.name}>{props.label}</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-40">
              <InputGroupInput
                {...field}
                id={props.name}
                aria-label={props.accessibleLabel}
                inputMode="numeric"
                placeholder={props.foreverLabel}
                disabled={disabled}
                aria-invalid={fieldState.invalid}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>days</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            {!disabled && (
              <div className="flex flex-wrap gap-1" role="group" aria-label={`${props.accessibleLabel} presets`}>
                {RETENTION_PRESETS.map((days) => (
                  <Button
                    key={days}
                    type="button"
                    size="sm"
                    variant={field.value === String(days) ? "secondary" : "ghost"}
                    disabled={max != null && days > max}
                    onClick={() => field.onChange(String(days))}
                  >
                    {days} days
                  </Button>
                ))}
                {/* An empty workspace value follows the instance, so it only means forever without a limit. */}
                <Button
                  type="button"
                  size="sm"
                  variant={field.value === "" ? "secondary" : "ghost"}
                  onClick={() => field.onChange("")}
                >
                  {max == null ? "Forever" : "Instance limit"}
                </Button>
              </div>
            )}
          </div>
          <FieldDescription>{props.hint}</FieldDescription>
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  )
}

// Edits one policy layer. The workspace form shows the instance's values it
// can only narrow; the instance form adds the audit log's retention.
export function PrivacyPolicyForm(props: {
  scope: "instance" | "workspace"
  values: PolicyLayer | InstanceSettings
  // The instance layer, shown read-only above the workspace's own fields.
  instance?: PolicyLayer
  // REVIEW_RETENTION_DAYS, used while the instance leaves retention unset.
  envRetentionDays?: number | null
  readOnly?: boolean
  onSave: (values: InstanceSettings) => Promise<unknown>
}) {
  const { scope, instance, readOnly } = props
  const form = useForm<PolicyInput>({ resolver: zodResolver(policySchema), defaultValues: toInput(props.values) })
  const { reset } = form
  // A save elsewhere (another tab, the instance page) refreshes the form.
  useEffect(() => reset(toInput(props.values)), [props.values, reset])

  const instanceRetention = instance?.retentionDays ?? null
  const instanceProviders = instance?.allowedProviders ?? []
  const instanceHosts = instance?.allowedHosts ?? []

  async function onSubmit(values: PolicyInput) {
    const retentionDays = toDays(values.retentionDays)
    // Caught here so the field shows it without a round trip; the server checks too.
    if (instanceRetention !== null && retentionDays !== null && retentionDays > instanceRetention) {
      form.setError("retentionDays", { message: `Must be at most ${instanceRetention} days (the instance limit)` })
      return
    }
    try {
      await props.onSave({
        allowedProviders: values.allowedProviders,
        allowedHosts: values.allowedHosts,
        localOnly: values.localOnly,
        retentionDays,
        auditRetentionDays: toDays(values.auditRetentionDays),
      })
      toast.success("Privacy settings saved")
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  const retentionHint =
    scope === "instance"
      ? props.envRetentionDays
        ? `Empty uses REVIEW_RETENTION_DAYS from the server environment (${props.envRetentionDays} days).`
        : "Empty keeps review data forever."
      : instanceRetention
        ? `Empty follows the instance (${instanceRetention} days); a value can only be shorter.`
        : "Empty keeps review data forever."

  const dirty = form.formState.isDirty
  const leaving = useUnsavedChanges(dirty && !readOnly)

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
      <UnsavedChangesDialog open={leaving.blocked} onKeep={leaving.keep} onDiscard={leaving.discard} />
      <FieldGroup>
        <FieldSet>
          <FieldLegend>Where code can be sent</FieldLegend>
          <FieldDescription>Reviews that would call anything else fail with the reason, before sending.</FieldDescription>
          <FieldGroup>
            <div className="grid items-start gap-6 md:grid-cols-2">
              <Controller
                control={form.control}
                name="allowedProviders"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor={`${scope}-providers`}>Allowed providers</FieldLabel>
                    <MultiSelect
                      id={`${scope}-providers`}
                      values={field.value}
                      onValuesChange={(values) => field.onChange(values as PolicyInput["allowedProviders"])}
                      options={PROVIDER_OPTIONS.map((option) => {
                        const blocked = instanceProviders.length > 0 && !instanceProviders.includes(option.value)
                        return {
                          ...option,
                          icon: LLM_PROVIDERS[option.value].icon,
                          // A blocked provider saved earlier can still be removed.
                          disabled: blocked && !field.value.includes(option.value),
                          badge: blocked ? (
                            <Badge variant="outline" className="ml-auto font-normal">
                              Blocked by instance
                            </Badge>
                          ) : undefined,
                        }
                      })}
                      placeholder={instanceProviders.length ? "Any the instance allows" : "Any provider"}
                      disabled={readOnly}
                      aria-invalid={fieldState.invalid}
                    />
                    <FieldDescription>Leave empty to allow every provider.</FieldDescription>
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="localOnly"
                render={({ field }) => {
                  const locked = Boolean(instance?.localOnly)
                  return (
                    <FieldLabel htmlFor={`${scope}-local-only`}>
                      <Field orientation="horizontal" data-disabled={readOnly || locked}>
                        <FieldContent>
                          <FieldTitle>
                            Local only
                            {locked && <InstanceBadge />}
                          </FieldTitle>
                          <FieldDescription>
                            Only private or loopback endpoints, such as a self-hosted Ollama. Official provider APIs
                            are refused.
                          </FieldDescription>
                        </FieldContent>
                        <Switch
                          id={`${scope}-local-only`}
                          aria-label="Local only"
                          checked={locked || field.value}
                          onCheckedChange={field.onChange}
                          disabled={readOnly || locked}
                        />
                      </Field>
                    </FieldLabel>
                  )
                }}
              />
            </div>
            <Controller
              control={form.control}
              name="allowedHosts"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={`${scope}-hosts`}>Allowed hosts</FieldLabel>
                  <TagInput
                    id={`${scope}-hosts`}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={readOnly}
                    placeholder="e.g. ollama.internal:11434, *.example.com, then Enter"
                    aria-invalid={fieldState.invalid}
                  />
                  <FieldDescription>
                    Empty allows every host. Without a port, any port matches; *.example.com matches hosts below it.
                  </FieldDescription>
                  {instanceHosts.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                      Instance allows:
                      {instanceHosts.map((host) => (
                        <Badge key={host} variant="outline" className="font-mono font-normal">
                          {host}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
        </FieldSet>
        <FieldSeparator />
        <FieldSet>
          <FieldLegend>Data retention</FieldLegend>
          <FieldDescription>
            Finished reviews older than this lose their stored result; changes idle this long also lose their findings
            and thread replies.
          </FieldDescription>
          <div className={cn("grid items-start gap-6", scope === "instance" && "md:grid-cols-2")}>
            <RetentionField
              control={form.control}
              name="retentionDays"
              label="Review data"
              accessibleLabel="Review data retention (days)"
              foreverLabel={scope === "workspace" && instanceRetention ? "Instance limit" : "No limit"}
              hint={retentionHint}
              max={instanceRetention}
              disabled={readOnly}
            />
            {scope === "instance" && (
              <RetentionField
                control={form.control}
                name="auditRetentionDays"
                label="Audit log"
                accessibleLabel="Audit log retention (days)"
                foreverLabel="Keep forever"
                hint="Applies to every workspace. Empty keeps the audit log forever."
                disabled={readOnly}
              />
            )}
          </div>
        </FieldSet>
      </FieldGroup>
      {!readOnly && (
        // Pinned while dirty, so Save is reachable from the top of the form.
        <div className={`flex flex-wrap items-center gap-2 border-t pt-4 ${dirty ? "sticky bottom-0 z-10 bg-background pb-4" : ""}`}>
          <Button type="submit" disabled={form.formState.isSubmitting || !dirty}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
            Save privacy settings
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={form.formState.isSubmitting || !dirty}
            onClick={() => reset(toInput(props.values))}
          >
            <RotateCcw />
            Reset
          </Button>
          {dirty && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
        </div>
      )}
    </form>
  )
}
