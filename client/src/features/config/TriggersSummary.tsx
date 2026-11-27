import { useState, type ReactNode } from "react"
import { CheckCircle2, ChevronRight, Loader2, MinusCircle } from "lucide-react"
import { SearchableSelect } from "@/components/SearchableSelect"
import { TagInput } from "@/components/TagInput"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  useTriggerCheck,
  type ConfigOverride,
  type TriggerCheckChange,
  type TriggerCheckEvent,
} from "./api"
import type { TriggerListName } from "./settingsForm"

export interface TriggersSummaryProps {
  // What the check sends, or null while the form has errors or nothing is inherited yet.
  request: { base: ConfigOverride; settings: ConfigOverride } | null
  review?: string
  reviewOnPush?: boolean
  fullReviewOnPush?: boolean
  pauseOnBurst?: boolean
  pauseAfterPushes?: number
  pauseWindowMinutes?: number
  summary?: string
  walkthroughOff: boolean
  command?: boolean
  replies?: boolean
  abortOnClose?: boolean
  lists: Partial<Record<TriggerListName, string[]>>
  // Repository scope with a repository file: the check does not read it.
  repoFile?: string | null
}

const UNKNOWN = "..."

const LIST_LABEL: Record<TriggerListName, string> = {
  ignoreTitles: "Title",
  skipAuthors: "Author",
  skipLabels: "Label",
  skipSourceBranches: "Source",
  skipTargetBranches: "Target",
}

const EVENTS: { value: TriggerCheckEvent; label: string }[] = [
  { value: "opened", label: "Opened or marked ready" },
  { value: "push", label: "New commits pushed" },
  { value: "command", label: "/sentryward review comment" },
]

// Passes the default triggers, so the first answer is "Reviewed" and each
// edit shows what changes it.
const SAMPLE: TriggerCheckChange = {
  title: "Add login form",
  author: "dev",
  labels: [],
  headRef: "feature/login",
  baseRef: "main",
  isDraft: false,
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="text-right font-medium">{props.children}</dd>
    </div>
  )
}

const onOff = (value: boolean | undefined) => (value === undefined ? UNKNOWN : value ? "On" : "Off")

function reviewLabel(review: string | undefined) {
  if (review === "manual") return "Off, manual only"
  if (review === "published") return "Published, drafts wait"
  if (review === "all") return "Drafts and published"
  return UNKNOWN
}

// What a review does on its own and on request with these trigger settings,
// unsaved edits included, and a check of one sample change against them.
export function TriggersSummary(props: TriggersSummaryProps) {
  const manual = props.review === "manual"
  const push =
    props.review === undefined || props.reviewOnPush === undefined
      ? UNKNOWN
      : manual || !props.reviewOnPush
        ? "Off"
        : props.fullReviewOnPush
          ? "Every file"
          : "New commits"
  // The check below has no push history, so the pause is only described here.
  const pause =
    push === "Off" || push === UNKNOWN || !props.pauseOnBurst
      ? null
      : `Pauses after ${props.pauseAfterPushes ?? UNKNOWN} pushes in ${props.pauseWindowMinutes ?? UNKNOWN} min`
  const summary = props.walkthroughOff
    ? "Off, PR summary is off"
    : manual
      ? "Off, automatic reviews are off"
      : props.summary === "published"
        ? "With automatic reviews"
        : props.summary === "manual"
          ? "Requested reviews only"
          : UNKNOWN
  const rules = (Object.keys(LIST_LABEL) as TriggerListName[]).flatMap((name) =>
    (props.lists[name] ?? []).map((value) => ({ name, value })),
  )

  return (
    <Card role="region" aria-label="Triggers summary" className="@6xl:sticky @6xl:top-18">
      <CardHeader>
        <CardTitle>Summary</CardTitle>
        <CardDescription>When Sentryward runs with these settings, including unsaved edits.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="divide-y">
          <Row label="On open or ready">{reviewLabel(props.review)}</Row>
          <Row label="On push">{push}</Row>
          {pause && <Row label="Burst of pushes">{pause}</Row>}
          <Row label="PR summary">{summary}</Row>
          <Row label="Review command">{onOff(props.command)}</Row>
          <Row label="Replies">{onOff(props.replies)}</Row>
          <Row label="Abort on close">{onOff(props.abortOnClose)}</Row>
          <Row label="Skip rules">
            {manual ? "Not used" : `${rules.length} ${rules.length === 1 ? "rule" : "rules"}`}
          </Row>
          {!manual && rules.length > 0 && (
            <div className="flex flex-wrap gap-1 py-2">
              {rules.map(({ name, value }) => (
                <Badge key={`${name}:${value}`} variant="secondary" className="font-normal">
                  <span className="text-muted-foreground">{LIST_LABEL[name]}:</span> {value}
                </Badge>
              ))}
            </div>
          )}
        </dl>
        <Separator />
        <TriggerCheck request={props.request} repoFile={props.repoFile} />
      </CardContent>
    </Card>
  )
}

// A sample change run through the worker's own skip rules on the server, so
// the answer is the reason a real run would give. Hidden until asked for, so
// the summary rows stay in view; the sample lives out here so closing and
// reopening keeps what was typed.
function TriggerCheck(props: { request: TriggersSummaryProps["request"]; repoFile?: string | null }) {
  const [open, setOpen] = useState(false)
  const [event, setEvent] = useState<TriggerCheckEvent>("opened")
  const [change, setChange] = useState<TriggerCheckChange>(SAMPLE)

  return (
    <section aria-label="Will this be reviewed?">
      <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-1">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="group -ml-2 w-fit">
            <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
            Will this be reviewed?
          </Button>
        </CollapsibleTrigger>
        {!open && <p className="text-xs text-muted-foreground">Check a sample change against these settings.</p>}
        {/* Unmounted while closed, so nothing is checked until the form is open. */}
        <CollapsibleContent className="pt-2">
          <TriggerCheckForm
            request={props.request}
            repoFile={props.repoFile}
            event={event}
            onEventChange={setEvent}
            change={change}
            onChange={setChange}
          />
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}

function TriggerCheckForm(props: {
  request: TriggersSummaryProps["request"]
  repoFile?: string | null
  event: TriggerCheckEvent
  onEventChange: (event: TriggerCheckEvent) => void
  change: TriggerCheckChange
  onChange: (update: (current: TriggerCheckChange) => TriggerCheckChange) => void
}) {
  const { event, change } = props
  const update = (patch: Partial<TriggerCheckChange>) => props.onChange((current) => ({ ...current, ...patch }))
  const check = useTriggerCheck(props.request && { ...props.request, event, change })
  const result = check.data

  let answer: ReactNode
  if (!props.request) answer = <p className="text-muted-foreground">Fix the highlighted fields to check a change.</p>
  else if (check.isError) answer = <p className="text-destructive">{check.error.message}</p>
  else if (!result)
    answer = (
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Checking...
      </p>
    )
  else if (result.reason)
    answer = (
      <p className="flex items-start gap-1.5">
        <MinusCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span>
          <span className="font-medium">Skipped.</span> {result.reason}.
        </span>
      </p>
    )
  else
    answer = (
      <p className="flex items-start gap-1.5">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span>
          <span className="font-medium">Reviewed</span>
          {event === "push" && (result.fullReview ? ", every file" : ", new commits only")}
          {result.walkthrough ? ", with the PR summary." : ", without the PR summary."}
        </span>
      </p>
    )

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor="check-event">Event</FieldLabel>
        <SearchableSelect
          id="check-event"
          value={event}
          onValueChange={(value) => props.onEventChange(value as TriggerCheckEvent)}
          options={EVENTS}
          searchable={false}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="check-title">Title</FieldLabel>
        <Input id="check-title" value={change.title} onChange={(e) => update({ title: e.target.value })} />
      </Field>
      <Field>
        <FieldLabel htmlFor="check-author">Author</FieldLabel>
        <Input id="check-author" value={change.author} onChange={(e) => update({ author: e.target.value })} />
      </Field>
      <Field>
        <FieldLabel htmlFor="check-labels">Labels</FieldLabel>
        <TagInput
          id="check-labels"
          value={change.labels}
          onChange={(labels) => update({ labels })}
          placeholder="Type a label, then Enter"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="check-head">Source branch</FieldLabel>
          <Input id="check-head" value={change.headRef} onChange={(e) => update({ headRef: e.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor="check-base">Target branch</FieldLabel>
          <Input id="check-base" value={change.baseRef} onChange={(e) => update({ baseRef: e.target.value })} />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="check-draft" checked={change.isDraft} onCheckedChange={(isDraft) => update({ isDraft })} />
        <Label htmlFor="check-draft">Draft</Label>
      </div>
      <div role="status" aria-live="polite" className="rounded-md border bg-muted/30 p-3">
        {answer}
      </div>
      {props.repoFile && (
        <p className="text-xs text-muted-foreground">
          Does not include <code>{props.repoFile}</code> in the repository, which wins over these settings.
        </p>
      )}
    </div>
  )
}
