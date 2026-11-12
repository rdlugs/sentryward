import { useMemo, useState } from "react"
import { useSearchParams } from "react-router"
import { Controller, useForm, useWatch, type Control, type FieldValues, type Path } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { AlertTriangle, BellRing, Copy, History, KeyRound, Loader2, Mail, MoreHorizontal, Pencil, Plus, Send, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { SortableHead } from "@/components/SortableHead"
import {
  ActiveFilterChips,
  FilterPopover,
  FilterSelect,
  FilterToolbar,
  NoMatchesRow,
  SearchInput,
  type ActiveFilter,
} from "@/components/TableFilters"
import { TablePagination } from "@/components/TablePagination"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useAuth } from "@/features/auth/useAuth"
import { useRepos } from "@/features/forge/api"
import { useMembers, type Member } from "@/features/workspaces/api"
import { paginate, usePagination } from "@/hooks/use-pagination"
import { useSort } from "@/hooks/use-sort"
import { copyToClipboard } from "@/lib/clipboard"
import { ALL, matchesQuery, selectedLabel } from "@/lib/filters"
import { timeAgo } from "@/lib/time"
import {
  EVENT_OPTIONS,
  KIND_LABELS,
  MIN_SEVERITY_LABELS,
  useCreateNotificationTarget,
  useDeleteNotificationTarget,
  useNotificationTargets,
  useRotateNotificationSecret,
  useTestNotificationTarget,
  useUpdateNotificationTarget,
  type NotificationEvent,
  type NotificationKind,
  type MinSeverity,
  type DeliverySettings,
  type NotificationTarget,
  type TargetFilters,
} from "./api"
import { DeliveriesSheet, LastDeliveryCell, TargetActiveSwitch, TargetName } from "./components"
import { causeHint, failingTargets, hourLabel, WEEKDAYS } from "./delivery"
import { FailingTargets } from "./FailingTargets"
import { PersonalNotifications } from "./PersonalNotifications"

const eventsSchema = z
  .array(z.enum(["blocked", "failed", "resolved", "completed"]))
  .min(1, "Choose at least one event")

// The scope as the form holds it; toFilters turns it into what the API takes.
const scopeFields = {
  repoScope: z.enum(["all", "only"]),
  // The server's limit, checked here so the form says so before saving.
  repositoryIds: z.array(z.string()).max(100, "Choose 100 repositories or fewer, or All"),
  minSeverity: z.enum(["any", "minor", "major", "critical"]),
  onlyVerdictChanges: z.boolean(),
}
type ScopeInput = z.infer<z.ZodObject<typeof scopeFields>>

function checkScope(data: ScopeInput, ctx: z.RefinementCtx) {
  if (data.repoScope === "only" && data.repositoryIds.length === 0) {
    ctx.addIssue({ code: "custom", path: ["repositoryIds"], message: "Choose at least one repository" })
  }
}

function toFilters({ repoScope, repositoryIds, minSeverity, onlyVerdictChanges }: ScopeInput): TargetFilters {
  return {
    repositoryIds: repoScope === "all" ? [] : repositoryIds,
    minSeverity: minSeverity === "any" ? null : minSeverity,
    onlyVerdictChanges,
  }
}

// A target paused because its repositories were removed starts on "Only
// these" with nothing ticked, so saving it means choosing again (All included).
function scopeDefaults(target?: NotificationTarget): ScopeInput {
  return {
    repoScope: target && (target.repositoryIds.length > 0 || target.pauseCause === "scope") ? "only" : "all",
    repositoryIds: target?.repositoryIds ?? [],
    minSeverity: target?.minSeverity ?? "any",
    onlyVerdictChanges: target?.onlyVerdictChanges ?? false,
  }
}

// Delivery as the form holds it: selects work in strings, so the hour and
// weekday are converted by toDelivery.
const deliveryFields = {
  deliveryMode: z.enum(["each", "daily", "weekly"]),
  digestHour: z.string(),
  digestWeekday: z.string(),
  digestTimeZone: z.string().min(1, "Choose a timezone"),
}
type DeliveryInput = z.infer<z.ZodObject<typeof deliveryFields>>

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

function toDelivery({ deliveryMode, digestHour, digestWeekday, digestTimeZone }: DeliveryInput): DeliverySettings {
  if (deliveryMode === "each") return { mode: "each" }
  const hour = Number(digestHour)
  if (deliveryMode === "daily") return { mode: "daily", hour, timeZone: digestTimeZone }
  return { mode: "weekly", hour, weekday: Number(digestWeekday), timeZone: digestTimeZone }
}

// A new target starts on each review, with a digest at 09:00 Monday in the
// browser's timezone ready if digests are chosen.
function deliveryDefaults(target?: NotificationTarget): DeliveryInput {
  const delivery = target?.delivery
  return {
    deliveryMode: delivery?.mode ?? "each",
    digestHour: String(delivery?.hour ?? 9),
    digestWeekday: String(delivery?.weekday ?? 1),
    digestTimeZone: delivery?.timeZone ?? browserTimeZone(),
  }
}

// Saving the same choice again would restart the digest period, so an edit
// sends delivery only when it changed.
function sameDelivery(a: DeliverySettings, target: NotificationTarget) {
  const b = target.delivery
  if (a.mode !== b.mode) return false
  if (a.mode === "each") return true
  return a.hour === b.hour && a.timeZone === b.timeZone && (a.mode !== "weekly" || a.weekday === b.weekday)
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: hourLabel(hour) }))
const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: WEEKDAYS[day]! }))

let timeZones: string[] | null = null
function timeZoneOptions(current: string) {
  if (!timeZones) {
    try {
      timeZones = Intl.supportedValuesOf("timeZone")
    } catch {
      timeZones = []
    }
    if (!timeZones.includes("UTC")) timeZones = ["UTC", ...timeZones]
  }
  return timeZones.includes(current) ? timeZones : [current, ...timeZones]
}

const SEVERITY_OPTIONS: { value: "any" | MinSeverity; label: string }[] = [
  { value: "any", label: "Any" },
  ...(Object.keys(MIN_SEVERITY_LABELS) as MinSeverity[]).map((value) => ({
    value,
    label: `${MIN_SEVERITY_LABELS[value]} or worse`,
  })),
]

const HTTP_URL = /^https?:\/\/\S+$/

const createSchema = z
  .object({
    kind: z.enum(["webhook", "slack", "google_chat", "discord", "teams", "email"]),
    name: z.string().trim().min(1, "Name is required").max(100),
    url: z.string().trim(),
    events: eventsSchema,
    recipientIds: z.array(z.string()),
    ...scopeFields,
    ...deliveryFields,
  })
  .superRefine((data, ctx) => {
    checkScope(data, ctx)
    if (data.kind === "email") {
      if (data.recipientIds.length === 0) {
        ctx.addIssue({ code: "custom", path: ["recipientIds"], message: "Choose at least one member" })
      }
    } else if (!HTTP_URL.test(data.url)) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "Enter an http or https URL" })
    }
  })
type CreateInput = z.infer<typeof createSchema>

const editSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    // Empty keeps the current URL, which the server never sends back.
    url: z.string().trim().refine((url) => url === "" || HTTP_URL.test(url), "Enter an http or https URL"),
    events: eventsSchema,
    recipientIds: z.array(z.string()),
    ...scopeFields,
    ...deliveryFields,
  })
  .superRefine(checkScope)
type EditInput = z.infer<typeof editSchema>

const URL_PLACEHOLDERS: Record<Exclude<NotificationKind, "email">, string> = {
  webhook: "https://ci.example.com/hooks/sentryward",
  slack: "https://hooks.slack.com/services/...",
  google_chat: "https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...",
  discord: "https://discord.com/api/webhooks/...",
  teams: "https://....logic.azure.com/workflows/.../triggers/manual/paths/invoke?...",
}

// What each service calls the URL it hands out. Teams in particular: its old
// "incoming webhook" connectors take a different message format and are being
// retired, so the label names the Workflows webhook this kind expects.
const URL_LABELS: Record<Exclude<NotificationKind, "email">, { add: string; edit: string }> = {
  webhook: { add: "URL", edit: "New URL" },
  slack: { add: "Incoming webhook URL", edit: "New incoming webhook URL" },
  google_chat: { add: "Incoming webhook URL", edit: "New incoming webhook URL" },
  discord: { add: "Webhook URL", edit: "New webhook URL" },
  teams: { add: "Workflows webhook URL", edit: "New Workflows webhook URL" },
}

const KIND_OPTIONS = (Object.keys(KIND_LABELS) as NotificationKind[]).map((kind) => ({
  value: kind,
  label: KIND_LABELS[kind],
}))

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
]

type SortKey = "name" | "kind" | "createdAt" | "active"

function compareTargets(a: NotificationTarget, b: NotificationTarget, key: SortKey) {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name)
    case "kind":
      return KIND_LABELS[a.kind].localeCompare(KIND_LABELS[b.kind])
    case "createdAt":
      return Date.parse(a.createdAt) - Date.parse(b.createdAt)
    case "active":
      // Ascending lists active targets first.
      return Number(b.active) - Number(a.active)
  }
}

type MemberNames = Map<string, string>

// Recipients who left the workspace are not emailed, so they are not listed.
function recipientNames(target: NotificationTarget, names: MemberNames) {
  return target.recipientIds.flatMap((id) => names.get(id) ?? [])
}

function toggle<T>(list: T[], value: T, on: boolean): T[] {
  return on ? [...list, value] : list.filter((item) => item !== value)
}

function CheckboxList<T extends FieldValues>({
  control,
  name,
  legend,
  options,
}: {
  control: Control<T>
  name: Path<T>
  legend: string
  options: { value: string; label: string; description?: string }[]
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldSet data-invalid={fieldState.invalid}>
          <FieldLegend variant="label">{legend}</FieldLegend>
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
            {options.map((option) => {
              const id = `${name}-${option.value}`
              const value = field.value as string[]
              return (
                <Field key={option.value} orientation="horizontal">
                  <Checkbox
                    id={id}
                    checked={value.includes(option.value)}
                    onCheckedChange={(on) => field.onChange(toggle(value, option.value, on === true))}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={id} className="font-normal">
                      {option.label}
                    </FieldLabel>
                    {option.description && <FieldDescription>{option.description}</FieldDescription>}
                  </FieldContent>
                </Field>
              )
            })}
          </div>
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </FieldSet>
      )}
    />
  )
}

// Repositories, minimum severity and verdict changes, shared by both sheets.
// Failed and resolved deliveries ignore the last two, as the server does.
function ScopeFields<T extends FieldValues & ScopeInput>({ control }: { control: Control<T> }) {
  const repoScope = useWatch({ control, name: "repoScope" as Path<T> })
  const { data } = useRepos()
  const repoOptions = (data?.repos ?? []).map((repo) => ({ value: repo.id, label: repo.fullPath }))
  return (
    <FieldSet>
      <FieldLegend variant="label">Scope</FieldLegend>
      <FieldDescription>Failed and resolved reviews are always sent, whatever the severity or verdict.</FieldDescription>
      <Controller
        control={control}
        name={"repoScope" as Path<T>}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="notification-repo-scope">Repositories</FieldLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="notification-repo-scope" className="w-full" onBlur={field.onBlur}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="all">All repositories</SelectItem>
                <SelectItem value="only">Only these</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      />
      {repoScope === "only" && (
        <CheckboxList control={control} name={"repositoryIds" as Path<T>} legend="Only these repositories" options={repoOptions} />
      )}
      <Controller
        control={control}
        name={"minSeverity" as Path<T>}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="notification-min-severity">Minimum severity</FieldLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="notification-min-severity" className="w-full" onBlur={field.onBlur}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {SEVERITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Send only reviews with at least one finding this severe.</FieldDescription>
          </Field>
        )}
      />
      <Controller
        control={control}
        name={"onlyVerdictChanges" as Path<T>}
        render={({ field }) => (
          <Field orientation="horizontal">
            <Checkbox
              id="notification-verdict-changes"
              checked={field.value}
              onCheckedChange={(on) => field.onChange(on === true)}
            />
            <FieldContent>
              <FieldLabel htmlFor="notification-verdict-changes" className="font-normal">
                Only when the verdict changes
              </FieldLabel>
              <FieldDescription>
                Skip a review whose verdict matches the previous review of the same pull or merge request.
              </FieldDescription>
            </FieldContent>
          </Field>
        )}
      />
    </FieldSet>
  )
}

function OptionSelect({
  id,
  label,
  value,
  onChange,
  onBlur,
  options,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  onBlur: () => void
  options: { value: string; label: string }[]
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full" onBlur={onBlur}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-72">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

const MODE_OPTIONS = [
  { value: "each", label: "Each review" },
  { value: "daily", label: "Daily digest" },
  { value: "weekly", label: "Weekly digest" },
]

// Each review, or a daily or weekly digest at a chosen hour and timezone.
function DeliveryFields<T extends FieldValues & DeliveryInput>({ control }: { control: Control<T> }) {
  const mode = useWatch({ control, name: "deliveryMode" as Path<T> })
  return (
    <FieldSet>
      <FieldLegend variant="label">Delivery</FieldLegend>
      <FieldDescription>
        A digest sums up the period&apos;s reviews that match the events and scope above, and is not sent when there
        were none.
      </FieldDescription>
      <Controller
        control={control}
        name={"deliveryMode" as Path<T>}
        render={({ field }) => (
          <OptionSelect id="notification-delivery-mode" label="Send" options={MODE_OPTIONS} {...field} />
        )}
      />
      {mode !== "each" && (
        <>
          {mode === "weekly" && (
            <Controller
              control={control}
              name={"digestWeekday" as Path<T>}
              render={({ field }) => (
                <OptionSelect id="notification-digest-weekday" label="Day" options={WEEKDAY_OPTIONS} {...field} />
              )}
            />
          )}
          <Controller
            control={control}
            name={"digestHour" as Path<T>}
            render={({ field }) => (
              <OptionSelect id="notification-digest-hour" label="Time" options={HOUR_OPTIONS} {...field} />
            )}
          />
          <Controller
            control={control}
            name={"digestTimeZone" as Path<T>}
            render={({ field }) => (
              <OptionSelect
                id="notification-digest-timezone"
                label="Timezone"
                options={timeZoneOptions(field.value).map((zone) => ({ value: zone, label: zone }))}
                {...field}
              />
            )}
          />
        </>
      )}
    </FieldSet>
  )
}

function memberOptions(members: Member[] | undefined) {
  return (members ?? []).map((member) => ({ value: member.id, label: member.name, description: member.email }))
}

// The add and edit sheets: the fields scroll between a fixed header and a
// footer, so Save stays in view however long the form gets.
const FORM_CLASS = "flex min-h-0 flex-1 flex-col"
const BODY_CLASS = "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4"
const FOOTER_CLASS = "flex-row justify-end border-t"

// The secret appears only here: the server never returns it again. After a
// rotation, previousUntil says how long the old secret keeps signing too.
function CreatedSecretView({
  secret,
  title = "Webhook added",
  previousUntil = null,
}: {
  secret: string
  title?: string
  previousUntil?: string | null
}) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>
          Each delivery carries an <code className="font-mono text-xs">X-Sentryward-Signature-V2</code> header: the
          HMAC-SHA256 of <code className="font-mono text-xs">{"<timestamp>.<body>"}</code> with this secret, where the
          timestamp is the <code className="font-mono text-xs">X-Sentryward-Timestamp</code> header. Copy it now; it's
          shown only once.
          {previousUntil && (
            <>
              {" "}
              Until {new Date(previousUntil).toLocaleString()}, the header also carries a signature made with the
              previous secret, separated by a comma, so your receiver keeps working while you update it.
            </>
          )}
        </SheetDescription>
      </SheetHeader>
      <div className="flex gap-2 px-4">
        <Input
          readOnly
          value={secret}
          aria-label="Signing secret"
          className="font-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" onClick={() => copyToClipboard(secret, "Secret")}>
          <Copy />
          Copy
        </Button>
      </div>
      <SheetFooter className="flex-row justify-end border-t">
        <SheetClose asChild>
          <Button type="button">Done</Button>
        </SheetClose>
      </SheetFooter>
    </>
  )
}

function AddTargetSheet({
  open,
  onOpenChange,
  mailConfigured,
  members,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mailConfigured: boolean
  members: Member[] | undefined
}) {
  const [secret, setSecret] = useState<string | null>(null)
  const createTarget = useCreateNotificationTarget()
  const form = useForm<CreateInput>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      kind: "webhook",
      name: "",
      url: "",
      events: ["blocked", "failed"],
      recipientIds: [],
      ...scopeDefaults(),
      ...deliveryDefaults(),
    },
  })
  const kind = useWatch({ control: form.control, name: "kind" })

  async function onSubmit(input: CreateInput) {
    const { kind, name, url, events, recipientIds } = input
    const filters = { ...toFilters(input), delivery: toDelivery(input) }
    try {
      const result = await createTarget.mutateAsync(
        kind === "email"
          ? { kind, name, events, recipientIds, ...filters }
          : { kind, name, events, url, ...filters },
      )
      if (result.secret) {
        setSecret(result.secret)
      } else {
        toast.success(`Added ${name}`)
        handleOpenChange(false)
      }
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next)
    if (!next) {
      form.reset()
      setSecret(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="data-[side=right]:sm:max-w-lg">
        {secret ? (
          <CreatedSecretView secret={secret} />
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className={FORM_CLASS}>
            <SheetHeader>
              <SheetTitle>Add a notification target</SheetTitle>
              <SheetDescription>Choose where finished reviews are reported, and which ones.</SheetDescription>
            </SheetHeader>
            <div className={BODY_CLASS}>
              <Controller
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="notification-kind">Type</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="notification-kind" className="w-full" onBlur={field.onBlur}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        <SelectItem value="webhook">Webhook</SelectItem>
                        <SelectItem value="slack">Slack</SelectItem>
                        <SelectItem value="google_chat">Google Chat</SelectItem>
                        <SelectItem value="discord">Discord</SelectItem>
                        <SelectItem value="teams">Microsoft Teams</SelectItem>
                        <SelectItem value="email" disabled={!mailConfigured}>
                          Email{!mailConfigured && " (mail is not configured)"}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <TextField control={form.control} name="name" label="Name" autoComplete="off" placeholder="Team alerts" />
              {kind === "email" ? (
                <CheckboxList control={form.control} name="recipientIds" legend="Recipients" options={memberOptions(members)} />
              ) : (
                <TextField
                  control={form.control}
                  name="url"
                  label={URL_LABELS[kind].add}
                  type="url"
                  autoComplete="off"
                  placeholder={URL_PLACEHOLDERS[kind]}
                />
              )}
              <CheckboxList control={form.control} name="events" legend="Events" options={EVENT_OPTIONS} />
              <ScopeFields control={form.control} />
              <DeliveryFields control={form.control} />
            </div>
            <SheetFooter className={FOOTER_CLASS}>
              <SheetClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </SheetClose>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
                Add target
              </Button>
            </SheetFooter>
          </form>
        )}
      </SheetContent>
    </Sheet>
  )
}

function EditTargetSheet({
  target,
  members,
  onOpenChange,
}: {
  target: NotificationTarget
  members: Member[] | undefined
  onOpenChange: (open: boolean) => void
}) {
  const updateTarget = useUpdateNotificationTarget()
  const form = useForm<EditInput>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name: target.name,
      url: "",
      events: target.events,
      recipientIds: target.recipientIds,
      ...scopeDefaults(target),
      ...deliveryDefaults(target),
    },
  })

  async function onSubmit(input: EditInput) {
    const { name, url, events, recipientIds } = input
    const delivery = toDelivery(input)
    if (target.kind === "email" && recipientIds.length === 0) {
      form.setError("recipientIds", { message: "Choose at least one member" })
      return
    }
    try {
      await updateTarget.mutateAsync({
        id: target.id,
        name,
        events,
        ...(target.kind === "email" ? { recipientIds } : {}),
        ...(target.kind !== "email" && url ? { url } : {}),
        ...toFilters(input),
        ...(sameDelivery(delivery, target) ? {} : { delivery }),
      })
      toast.success(`Saved ${name}`)
      onOpenChange(false)
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="data-[side=right]:sm:max-w-lg">
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className={FORM_CLASS}>
          <SheetHeader>
            <SheetTitle>Edit {target.name}</SheetTitle>
            <SheetDescription>
              {target.kind === "email"
                ? "Change who is emailed and about which reviews."
                : "Change where reviews are sent and which ones. Settings and history are kept."}
            </SheetDescription>
          </SheetHeader>
          <div className={BODY_CLASS}>
            {target.pausedReason && (
              <Alert>
                <AlertTriangle />
                <AlertTitle>{target.pausedReason}</AlertTitle>
                <AlertDescription>
                  {causeHint(target)}{" "}
                  {target.pauseCause === "scope"
                    ? "Saving a choice here clears this notice."
                    : "Switching it back on in the list clears this notice and the failure count."}
                </AlertDescription>
              </Alert>
            )}
            <TextField control={form.control} name="name" label="Name" autoComplete="off" />
            {target.kind !== "email" && (
              <div className="flex flex-col gap-1.5">
                <TextField
                  control={form.control}
                  name="url"
                  label={URL_LABELS[target.kind].edit}
                  type="url"
                  autoComplete="off"
                  placeholder={target.host ? `https://${target.host}/...` : URL_PLACEHOLDERS[target.kind]}
                />
                <p className="text-muted-foreground text-sm">
                  {target.host ? `Sending to ${target.host}. ` : ""}Leave empty to keep the current URL.
                </p>
              </div>
            )}
            {target.kind === "email" && (
              <CheckboxList control={form.control} name="recipientIds" legend="Recipients" options={memberOptions(members)} />
            )}
            <CheckboxList control={form.control} name="events" legend="Events" options={EVENT_OPTIONS} />
            <ScopeFields control={form.control} />
            <DeliveryFields control={form.control} />
          </div>
          <SheetFooter className={FOOTER_CLASS}>
            <SheetClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </SheetClose>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

// Confirms first: the new secret takes over at once, with the old one still
// signing for a grace period, so the receiver has time to switch.
function RotateSecretSheet({
  target,
  onOpenChange,
}: {
  target: NotificationTarget
  onOpenChange: (open: boolean) => void
}) {
  const rotate = useRotateNotificationSecret()
  const [rotated, setRotated] = useState<{ secret: string; previousUntil: string | null } | null>(null)

  async function confirm() {
    try {
      const result = await rotate.mutateAsync(target.id)
      setRotated({ secret: result.secret, previousUntil: result.target.secretRotatedUntil })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rotate the secret")
    }
  }

  // Not while the request runs: the new secret is shown only in its response.
  return (
    <Sheet open onOpenChange={(open) => !rotate.isPending && onOpenChange(open)}>
      <SheetContent className="data-[side=right]:sm:max-w-lg">
        {rotated ? (
          <CreatedSecretView secret={rotated.secret} title="Secret rotated" previousUntil={rotated.previousUntil} />
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>Rotate the secret for {target.name}?</SheetTitle>
              <SheetDescription>
                Deliveries are signed with a new secret from now on. For the next 24 hours they are also signed with
                the current one, so your receiver keeps accepting them while you update it.
              </SheetDescription>
            </SheetHeader>
            <SheetFooter className={FOOTER_CLASS}>
              <SheetClose asChild>
                <Button type="button" variant="outline" disabled={rotate.isPending}>
                  Cancel
                </Button>
              </SheetClose>
              <Button type="button" onClick={confirm} disabled={rotate.isPending}>
                {rotate.isPending && <Loader2 className="animate-spin" />}
                Rotate secret
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function RemoveTargetDialog({
  target,
  onOpenChange,
}: {
  target: NotificationTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const deleteTarget = useDeleteNotificationTarget()

  async function remove() {
    if (!target) return
    try {
      await deleteTarget.mutateAsync(target.id)
      toast.success(`Removed ${target.name}`)
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the target")
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove this target?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{target?.name}</span> stops receiving notifications at once.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={remove} disabled={deleteTarget.isPending}>
            {deleteTarget.isPending && <Loader2 className="animate-spin" />}
            Remove target
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Destination({ target, memberNames }: { target: NotificationTarget; memberNames: MemberNames }) {
  if (target.undecryptable) return <Badge variant="destructive">Can't be decrypted</Badge>
  if (target.kind !== "email") return <span className="font-mono text-xs">{target.host}</span>
  const names = recipientNames(target, memberNames)
  return <span>{names.length ? names.join(", ") : <span className="text-muted-foreground">No current members</span>}</span>
}

function EventBadges({ events }: { events: NotificationEvent[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {EVENT_OPTIONS.filter((option) => events.includes(option.value)).map((option) => (
        <Badge key={option.value} variant="secondary">
          {option.label}
        </Badge>
      ))}
    </div>
  )
}

// Members get the menu too, for the delivery history; changing a target and
// sending tests stay with admins, as the server enforces.
function TargetActions({
  target,
  canManage,
  onViewDeliveries,
  onEdit,
  onRotateSecret,
  onRemove,
}: {
  target: NotificationTarget
  canManage: boolean
  onViewDeliveries: () => void
  onEdit: () => void
  onRotateSecret: () => void
  onRemove: () => void
}) {
  const testTarget = useTestNotificationTarget()

  async function sendTest() {
    try {
      const result = await testTarget.mutateAsync(target.id)
      if (result.ok) toast.success(`Test sent to ${target.name}`)
      else toast.error(`Test to ${target.name} failed: ${result.error}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the test")
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${target.name}`}>
          {testTarget.isPending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem onSelect={onViewDeliveries}>
          <History />
          View deliveries
        </DropdownMenuItem>
        {canManage && (
          <>
            <DropdownMenuItem onSelect={sendTest} disabled={testTarget.isPending}>
              <Send />
              Send test
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            {target.kind === "webhook" && (
              <DropdownMenuItem onSelect={onRotateSecret}>
                <KeyRound />
                Rotate secret
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TargetTable({
  targets,
  members,
  memberNames,
  canManage,
}: {
  targets: NotificationTarget[]
  members: Member[] | undefined
  memberNames: MemberNames
  canManage: boolean
}) {
  // Unsorted keeps the API order.
  const { sort, onSort } = useSort<SortKey>()
  const [editing, setEditing] = useState<NotificationTarget | null>(null)
  const [removing, setRemoving] = useState<NotificationTarget | null>(null)
  const [rotating, setRotating] = useState<NotificationTarget | null>(null)
  // Kept by id so the sheet follows the target through list refetches.
  const [viewingId, setViewingId] = useState<string | null>(null)
  const viewing = targets.find((target) => target.id === viewingId) ?? null

  const sorted = useMemo(() => {
    if (!sort) return targets
    const direction = sort.dir === "asc" ? 1 : -1
    return [...targets].sort((a, b) => direction * compareTargets(a, b, sort.key) || a.name.localeCompare(b.name))
  }, [targets, sort])
  const pagination = usePagination()
  const page = paginate(sorted, pagination.page, pagination.size)

  const head = { sort, onSort }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead label="Name" sortKey="name" {...head} />
            <SortableHead label="Type" sortKey="kind" {...head} />
            <TableHead>Destination</TableHead>
            <TableHead>Events</TableHead>
            <TableHead>Last delivery</TableHead>
            <SortableHead label="Added" sortKey="createdAt" {...head} />
            <SortableHead label="Active" sortKey="active" {...head} />
            <TableHead className="w-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!sorted.length && (
            <NoMatchesRow colSpan={8}>No notification targets match your filters.</NoMatchesRow>
          )}
          {page.rows.map((target) => (
            <TableRow key={target.id}>
              <TableCell>
                <TargetName target={target} />
              </TableCell>
              <TableCell>
                <Badge variant="outline">{KIND_LABELS[target.kind]}</Badge>
              </TableCell>
              <TableCell>
                <Destination target={target} memberNames={memberNames} />
              </TableCell>
              <TableCell>
                <EventBadges events={target.events} />
              </TableCell>
              <TableCell>
                <LastDeliveryCell delivery={target.lastDelivery} />
              </TableCell>
              <TableCell className="text-muted-foreground">{timeAgo(target.createdAt)}</TableCell>
              <TableCell>
                <TargetActiveSwitch target={target} canManage={canManage} />
              </TableCell>
              <TableCell className="text-right">
                <TargetActions
                  target={target}
                  canManage={canManage}
                  onViewDeliveries={() => setViewingId(target.id)}
                  onEdit={() => setEditing(target)}
                  onRotateSecret={() => setRotating(target)}
                  onRemove={() => setRemoving(target)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {page.total > 0 && (
        <TablePagination
          page={page.page}
          size={pagination.size}
          total={page.total}
          onPageChange={pagination.setPage}
          onSizeChange={pagination.setSize}
        />
      )}
      {editing && (
        <EditTargetSheet
          key={editing.id}
          target={editing}
          members={members}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      {rotating && (
        <RotateSecretSheet key={rotating.id} target={rotating} onOpenChange={(open) => !open && setRotating(null)} />
      )}
      <RemoveTargetDialog target={removing} onOpenChange={(open) => !open && setRemoving(null)} />
      {viewing && (
        <DeliveriesSheet key={viewing.id} target={viewing} onOpenChange={(open) => !open && setViewingId(null)} />
      )}
    </>
  )
}

// The search and filters sit above the card, so their state lives here and
// the table only sorts what it is given.
function TargetList({
  targets,
  mailConfigured,
  members,
  canManage,
}: {
  targets: NotificationTarget[]
  mailConfigured: boolean
  members: Member[] | undefined
  canManage: boolean
}) {
  const { setPage } = usePagination()
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState(ALL)
  const [event, setEvent] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const [adding, setAdding] = useState(false)
  const hasTargets = targets.length > 0
  const filtering = kind !== ALL || event !== ALL || status !== ALL

  // A new filter or search starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setPage(1)
    }
  }

  function clearFilters() {
    setKind(ALL)
    setEvent(ALL)
    setStatus(ALL)
    setPage(1)
  }

  const memberNames = useMemo<MemberNames>(
    () => new Map((members ?? []).map((member) => [member.id, member.name])),
    [members],
  )

  const filtered = useMemo(
    () =>
      targets.filter(
        (target) =>
          // Recipient names let a search for a person find the emails they get.
          matchesQuery(
            query,
            target.name,
            KIND_LABELS[target.kind],
            target.host ?? "",
            ...recipientNames(target, memberNames),
          ) &&
          (kind === ALL || target.kind === kind) &&
          (event === ALL || target.events.includes(event as NotificationEvent)) &&
          (status === ALL || target.active === (status === "active")),
      ),
    [targets, query, kind, event, status, memberNames],
  )

  const activeFilters = [
    { label: "Type", value: selectedLabel(kind, KIND_OPTIONS), onRemove: () => filterBy(setKind)(ALL) },
    { label: "Event", value: selectedLabel(event, EVENT_OPTIONS), onRemove: () => filterBy(setEvent)(ALL) },
    { label: "Status", value: selectedLabel(status, STATUS_OPTIONS), onRemove: () => filterBy(setStatus)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  const addButton = canManage && (
    <Button size={hasTargets ? "sm" : "default"} onClick={() => setAdding(true)}>
      <Plus />
      Add target
    </Button>
  )

  return (
    <>
      {hasTargets && (
        <FilterToolbar>
          <ActiveFilterChips filters={activeFilters} />
          {addButton}
          <FilterPopover active={filtering} onClear={clearFilters}>
            <FilterSelect
              id="notification-type-filter"
              label="Type"
              allLabel="All types"
              value={kind}
              onValueChange={filterBy(setKind)}
              options={KIND_OPTIONS}
            />
            <FilterSelect
              id="notification-event-filter"
              label="Event"
              allLabel="All events"
              value={event}
              onValueChange={filterBy(setEvent)}
              options={EVENT_OPTIONS}
            />
            <FilterSelect
              id="notification-status-filter"
              label="Status"
              allLabel="All statuses"
              value={status}
              onValueChange={filterBy(setStatus)}
              options={STATUS_OPTIONS}
            />
          </FilterPopover>
          <SearchInput label="Search notification targets" value={query} onChange={filterBy(setQuery)} />
        </FilterToolbar>
      )}
      {targets.some((target) => target.undecryptable) && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Some targets can't be decrypted</AlertTitle>
          <AlertDescription>They were saved under a different encryption key. Remove and add them again.</AlertDescription>
        </Alert>
      )}
      {!hasTargets ? (
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BellRing />
            </EmptyMedia>
            <EmptyTitle>No notification targets</EmptyTitle>
            <EmptyDescription>
              {canManage
                ? "Add a webhook, a Slack, Discord or Teams channel, a Google Chat space or email to hear about blocked and failed reviews."
                : "A workspace admin can add a webhook, a Slack, Discord or Teams channel, a Google Chat space or email for review notifications."}
            </EmptyDescription>
          </EmptyHeader>
          {addButton && <EmptyContent>{addButton}</EmptyContent>}
        </Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Notification targets</CardTitle>
            <CardDescription>
              Sent once a review finishes, and retried when an endpoint is briefly unavailable. Every delivery is
              recorded; one that fails never affects the review.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TargetTable targets={filtered} members={members} memberNames={memberNames} canManage={canManage} />
          </CardContent>
        </Card>
      )}

      {/* One sheet outside the empty-state/table switch, so adding the first
          target does not remount it and lose the shown secret. */}
      {canManage && (
        <AddTargetSheet open={adding} onOpenChange={setAdding} mailConfigured={mailConfigured} members={members} />
      )}
    </>
  )
}

const TABS = ["targets", "failing", "personal"] as const
type Tab = (typeof TABS)[number]

function TargetsUnavailable({ isError }: { isError: boolean }) {
  if (!isError) return <Skeleton className="h-40 w-full" />
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>Could not load notification targets.</AlertTitle>
    </Alert>
  )
}

export function NotificationTargets() {
  const { workspace } = useAuth()
  const { data, isError } = useNotificationTargets()
  // Members can see the targets; the server lets only admins change them.
  const canManage = workspace?.role === "owner" || workspace?.role === "admin"
  // Names for email recipients, and the picker when adding one.
  const { data: membershipData } = useMembers(workspace?.id ?? "")
  const members = membershipData?.members
  // ?tab= keeps the open tab linkable, e.g. /notifications?tab=failing.
  const [params, setParams] = useSearchParams()
  const requested = params.get("tab")
  const tab: Tab = TABS.find((value) => value === requested) ?? "targets"
  const failing = useMemo(() => failingTargets(data?.targets ?? []), [data])
  // Red when something was paused and needs an admin; neutral when targets are
  // only failing or retrying, which may sort themselves out.
  const urgent = failing.some((row) => row.status === "paused")
  // The personal setting is per workspace, so a team workspace is named; in
  // the personal one there is only one place it could apply.
  const team = workspace && !workspace.personal ? workspace : null

  // The tabs render while targets load or fail: the personal tab does not
  // depend on them.
  return (
    <Tabs className="flex-1" value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
      <TabsList>
        <TabsTrigger value="targets">
          <BellRing />
          <span>Targets</span>
        </TabsTrigger>
        <TabsTrigger value="failing">
          <AlertTriangle />
          <span>Failing targets</span>
          {failing.length > 0 && (
            <Badge variant={urgent ? "destructive" : "secondary"} className="ml-1" data-urgent={urgent}>
              {failing.length}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="personal">
          <Mail />
          <span>My email</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="targets" className="flex flex-col gap-4">
        {!canManage && <p className="text-sm text-muted-foreground">Only owners and admins can change these.</p>}
        {data ? (
          <TargetList targets={data.targets} mailConfigured={data.mailConfigured} members={members} canManage={canManage} />
        ) : (
          <TargetsUnavailable isError={isError} />
        )}
      </TabsContent>
      <TabsContent value="failing">
        {data ? (
          <FailingTargets failing={failing} settings={data.settings} canManage={canManage} />
        ) : (
          <TargetsUnavailable isError={isError} />
        )}
      </TabsContent>
      <TabsContent value="personal" className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {team ? `Only you see this. Applies to ${team.name}.` : "Only you see this."}
        </p>
        <div className="max-w-3xl">
          <PersonalNotifications />
        </div>
      </TabsContent>
    </Tabs>
  )
}
