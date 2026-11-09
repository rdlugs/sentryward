import { useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Link } from "react-router"
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ChevronRight, Info, MessageSquareOff, PanelRightClose, PanelRightOpen, Plus, RotateCcw, Trash2 } from "lucide-react"
import { SearchableSelect } from "@/components/SearchableSelect"
import { SegmentedControl } from "@/components/SegmentedControl"
import { TagInput } from "@/components/TagInput"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
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
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DragHandle } from "@/features/forge/SortableGrid"
import { cn } from "@/lib/utils"
import {
  STATUS_LABELS,
  useApiKeyStatuses,
  useApiKeys,
  useLlmCapabilities,
  useLlmModels,
  type ApiKey,
  type LlmConnectionStatus,
} from "@/features/llm-connections/api"
import { isCheckable, needsAttention } from "@/features/llm-connections/health"
import { LLM_PROVIDERS } from "@/features/llm-connections/providers"
import {
  useConfigSchema,
  type ConfigOverride,
  type ConfigSchema,
  type EffectiveConfig,
  type LlmProviderName,
  type Rule,
  type ThinkingLevel,
} from "./api"
import { LlmRunSummary } from "./LlmRunSummary"
import { ModelCombobox, type ModelSuggestions } from "./ModelCombobox"
import { FindingsSummary } from "./FindingsSummary"
import { ReviewPreview, type PreviewView } from "./ReviewPreview"
import { SeverityScale } from "./SeverityScale"
import { TriggersSummary } from "./TriggersSummary"
import { CONFIG_TABS, TAB_ERRORS, type ConfigTab } from "./tabs"
import {
  AUTO,
  at,
  CHOICES,
  choiceKey,
  EMPTY_RULE,
  FLAGS,
  INHERIT,
  LISTS,
  MAX_FALLBACK_MODELS,
  MAX_RULE_PATTERN,
  MAX_SUMMARY_INSTRUCTIONS,
  NUMBERS,
  ruleRowErrors,
  toSettings,
  type ChoiceName,
  type FlagName,
  type ListName,
  type FormErrors,
  type FormState,
  type NumberName,
  type RuleRow,
} from "./settingsForm"

const SOURCE_LABEL: Record<string, string> = {
  default: "default",
  profile: "profile",
  global: "global config",
  repoSettings: "these settings",
  repoFile: "repository file",
  trigger: "trigger",
}

// Shorter than SOURCE_LABEL, for the tag beside an effective value.
const BADGE_LABEL: Record<string, string> = {
  default: "default",
  global: "global",
  repoSettings: "repo override",
  trigger: "trigger",
}

// `cost` tags what an optional part of the PR summary adds to its model call.
// Qualitative on purpose: nothing here is measured (see generateWalkthrough in
// server/src/review/llm/walkthrough.ts for what each one changes).
const FLAG_INFO: Record<FlagName, { label: string; description: ReactNode; cost?: string }> = {
  requireEvidence: {
    label: "Require evidence",
    description: "Critical and major findings without evidence are demoted instead of blocking.",
  },
  suppressIgnored: {
    label: "Suppress dismissed findings",
    description:
      "Do not report findings this team dismissed as false positives or intentional again, and tell the reviewer what the repository has recently rejected.",
  },
  fullFile: { label: "Comment on untouched lines", description: "Allow findings outside the lines the change touched." },
  committableSuggestions: {
    label: "Committable suggestions",
    description: "Offer fixes as suggestions that can be applied from the forge.",
  },
  toolFindings: {
    label: "Static analysis findings",
    description:
      "Report what analyzers already found on changed lines: GitHub check run annotations, GitLab Code Quality and SAST reports.",
  },
  toolFindingsBlock: {
    label: "Static analysis can block",
    description: "Let static analysis findings at or above the blocking severity fail the review.",
  },
  fileContext: {
    label: "Surrounding code",
    description:
      "Show the reviewer the enclosing function, imports, called definitions and callers of the changed code, read from the head revision.",
  },
  disableCache: {
    label: "Disable cache",
    description: "Disable caching of code and dependencies; fetch them fresh on each run.",
  },
  // "PR summary" is the one name users see for the walkthrough; the config
  // key and the YAML name stay `walkthrough`.
  walkthrough: {
    label: "PR summary",
    description:
      "Summarise what the change does: at the top of the summary comment when that is posted, otherwise as a comment of its own. When automatic reviews include it is set on the Triggers tab.",
  },
  postInline: { label: "Post inline comments", description: "Comment on the lines each finding refers to." },
  postSummary: { label: "Post summary comment", description: "Post the review summary as a comment on the change." },
  summaryOnlyWithFindings: {
    label: "Only when there are findings",
    description:
      "Start no summary comment, PR summary included, for a completed review that found nothing. One an earlier review posted is still updated, and the commit status still reports the verdict.",
  },
  postCheck: { label: "Post commit status", description: "Report the verdict as the sentryward/review status." },
  resolveFixedThreads: {
    label: "Resolve fixed threads",
    description: "Resolve a finding's inline thread once a later review no longer reports it, and reopen it if it returns.",
  },
  findingCounts: {
    label: "Show finding counts",
    description: "Add a line under the verdict counting the findings by severity and where they are listed.",
  },
  findingLifecycle: {
    label: "Show changes since the last review",
    description: "List which findings are new, still open or reopened, and which earlier ones were fixed or invalidated.",
  },
  reviewStats: {
    label: "Show review details",
    description: "Add a line under the summary with the commit, models and how much was reviewed.",
  },
  agentPrompts: {
    label: "Prompt for AI agents per comment",
    description: "Add a ready-to-paste prompt for a coding agent to each actionable inline comment.",
  },
  agentPromptAll: {
    label: "Prompt for all review comments",
    description: "Add one prompt covering every finding to the summary comment, to hand the whole review to a coding agent.",
  },
  walkthroughLabels: {
    label: "Show labels in the summary",
    description: "Show the PR summary's labels as text in the comment. These are not native PR/MR labels.",
  },
  walkthroughBlastRadius: {
    label: "Show blast radius in the summary",
    description: "Show the estimated blast radius as text in the PR summary.",
  },
  blastRadiusLabel: {
    label: "Publish blast radius label",
    description:
      'Add a native PR/MR label with the estimated blast radius (e.g. "Large blast radius"). Supported on GitHub and GitLab.',
  },
  effortLabel: {
    label: "Publish review time estimate label",
    description:
      'Add a native PR/MR label with the estimated review effort (e.g. "10-20 Minutes"). Supported on GitHub and GitLab.',
  },
  sequenceDiagrams: {
    label: "Sequence diagrams",
    description: "Include a sequence diagram of the main flow in the PR summary, drawn with Mermaid. The model writes the diagram as extra output.",
    cost: "More output",
  },
  estimateEffort: {
    label: "Show review effort in the summary",
    description: "Include the estimated code review effort as text in the PR summary. The estimate is made either way, for the label.",
    cost: "No extra cost",
  },
  assessLinkedIssues: {
    label: "Assess linked issues",
    description:
      "Include an assessment of how well the changes address linked issues in the PR summary. Sends the linked issues' text to the model, only when the change links any.",
    cost: "Longer prompt",
  },
  relatedIssues: {
    label: "Related issues",
    description:
      "Include potentially related issues in the PR summary. Sends candidate issues' text to the model, only when some are found.",
    cost: "Longer prompt",
  },
  highLevelSummary: {
    label: "High-level summary",
    description:
      "Generate a high-level summary of the changes in the PR/MR description or the PR summary. The model writes it as extra output.",
    cost: "More output",
  },
  reviewOnPush: {
    label: "Review automatically on push",
    description: "Review the new commits on every push to the PR/MR.",
  },
  fullReviewOnPush: {
    label: "Full review on push",
    description: "Review every file of the PR/MR on push, not only the files the new commits touched.",
  },
  command: {
    label: "Allow review command",
    description: (
      <>
        Commenting <code>/sentryward review</code> requests a review.
      </>
    ),
  },
  replies: {
    label: "Respond to replies",
    description: (
      <>
        Answer questions in a finding&apos;s thread, and dismiss it on{" "}
        <code>/sentryward ignore false-positive|intentional</code>.
      </>
    ),
  },
  abortOnClose: {
    label: "Abort on close",
    description: "Abort the in-progress review if the PR is closed or merged.",
  },
}

function connectionLabel(provider: LlmProviderName | null) {
  return provider ? LLM_PROVIDERS[provider].label : "not configured"
}

function configuredConnectionLabel(llm: EffectiveConfig["llm"]) {
  if (llm.connection) return connectionLabel(llm.connection)
  if (llm.baseUrl) return llm.endpointKey ? `${connectionLabel(llm.endpointKey)} (legacy)` : "custom endpoint (legacy)"
  return "not configured"
}

const THINKING_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low (2k tokens)" },
  { value: "medium", label: "Medium (8k tokens)" },
  { value: "high", label: "High (24k tokens)" },
]

const CHOICE_INFO: Record<
  ChoiceName,
  // nullLabel names a saved null, e.g. "same as thinking".
  { label: string; description: ReactNode; options: { value: string; label: string }[]; nullLabel?: string }
> = {
  review: {
    label: "Code review trigger",
    // One line per option, so what happens to drafts is spelled out.
    description: (
      <span className="flex flex-col gap-0.5">
        <span>Which pull and merge requests are reviewed automatically when opened or marked ready.</span>
        <span>
          <strong className="font-medium text-foreground">Manual only</strong>: only{" "}
          <code>/sentryward review</code> and reviews requested here.
        </span>
        <span>
          <strong className="font-medium text-foreground">Published PRs</strong>: drafts wait until they are marked
          ready.
        </span>
        <span>
          <strong className="font-medium text-foreground">Draft and published PRs</strong>: drafts are reviewed too.
        </span>
      </span>
    ),
    options: [
      { value: "manual", label: "Manual only" },
      { value: "published", label: "Published PRs" },
      { value: "all", label: "Draft and published PRs" },
    ],
  },
  summary: {
    label: "PR summary trigger",
    description: "When automatic reviews include the PR summary. Requested reviews always do while the PR summary is on.",
    options: [
      { value: "manual", label: "Manual only" },
      { value: "published", label: "Published PRs" },
    ],
  },
  inlineMinSeverity: {
    label: "Inline comments from",
    description: "Comment inline only on findings at or above this severity. The rest are written out in the summary comment.",
    options: [
      { value: "critical", label: "Critical only" },
      { value: "major", label: "Major and above" },
      { value: "minor", label: "Minor and above" },
      { value: "info", label: "Every severity" },
    ],
  },
  highLevelSummaryPlacement: {
    label: "Summary placement",
    description: "Where the high-level summary is written.",
    options: [
      { value: "description", label: "PR/MR description" },
      { value: "walkthrough", label: "PR summary" },
    ],
  },
  verify: {
    label: "Verify findings",
    description:
      "Check findings with a second model call before they count. Refuted findings are dropped, uncertain ones demoted instead of blocking.",
    options: [
      { value: "off", label: "Off" },
      { value: "blocking", label: "Blocking findings" },
      { value: "all", label: "All findings" },
    ],
  },
  context: {
    label: "Review context",
    // One line per option, so the two modes compare at a glance.
    description: (
      <span className="flex flex-col gap-0.5">
        <span>
          <strong className="font-medium text-foreground">Static</strong>: each pass sees the diff and the code
          gathered for it.
        </span>
        <span>
          <strong className="font-medium text-foreground">Agentic</strong>: the model may also read files and search
          code until it reports, within the agent limits below. Models that cannot call tools fall back to static.
        </span>
      </span>
    ),
    options: [
      { value: "static", label: "Static" },
      { value: "agentic", label: "Agentic" },
    ],
  },
  thinking: {
    label: "Thinking",
    description:
      "Lets review passes reason before answering, at the cost of output tokens. The PR summary never thinks. Models or endpoints without thinking run without it, with a warning.",
    options: THINKING_OPTIONS,
  },
  verifyThinking: {
    label: "Verification thinking",
    description: "Thinking for the verification calls.",
    options: THINKING_OPTIONS,
    nullLabel: "Same as thinking",
  },
  thinkingSupport: {
    label: "Thinking support",
    description:
      "What the selected connection's models support. Auto uses what probes and reviews detected; set it when detection is wrong.",
    options: [
      { value: "auto", label: "Auto (detected)" },
      { value: "options", label: "Thinking options" },
      { value: "model", label: "The model thinks by itself" },
      { value: "none", label: "No thinking" },
    ],
  },
  toolSupport: {
    label: "Tool support",
    description: "Whether the connection passes tool calls through, which agentic context needs.",
    options: [
      { value: "auto", label: "Auto (detected)" },
      { value: "true", label: "Tools work" },
      { value: "false", label: "No tools" },
    ],
  },
}

const SUMMARY_INSTRUCTIONS_EXAMPLE =
  "Create concise release notes as a bullet-point list, followed by a Markdown table showing lines added and removed by each contributing author."

// Starting points for the high-level summary instructions, offered as buttons.
const SUMMARY_EXAMPLES = [
  {
    label: "Release notes",
    text: "Write release notes as a bullet list grouped under New Features, Bug Fixes and Documentation. Leave out groups with nothing in them.",
  },
  {
    label: "Changelog entry",
    text: "Write one changelog entry in the Keep a Changelog style: an Added, Changed, Fixed or Removed heading with one line per change, in the past tense.",
  },
  {
    label: "User-facing summary",
    text: "Summarise the change in two or three sentences for people who use the product, not its developers. Leave out file names and implementation details.",
  },
]

// The Display tab's settings: every output flag. A preset sets all of them.
const DISPLAY_FLAGS: FlagName[] = FLAGS.filter((flag) => flag.section === "output").map((flag) => flag.name)

// Settings whose effect only shows in the preview's inline thread; changing
// one switches the preview there, any other Display setting to the summary.
const INLINE_FLAGS = new Set<FlagName>(["postInline", "agentPrompts", "resolveFixedThreads"])
// The inline limits, which decide which findings get a thread.
const INLINE_CHOICES = new Set<ChoiceName>(["inlineMinSeverity"])
const INLINE_NUMBERS = new Set<NumberName>(["maxInlineComments"])

type DisplayPreset = "minimal" | "standard" | "everything"

// Minimal is the quietest setup: inline comments (and closing their threads)
// only. Standard is the server's defaults, themselves a quiet setup;
// Everything turns every switch on, labels included.
const DISPLAY_PRESETS: { value: DisplayPreset; label: string }[] = [
  { value: "minimal", label: "Minimal" },
  { value: "standard", label: "Standard" },
  { value: "everything", label: "Everything" },
]
const MINIMAL_ON = new Set<FlagName>(["postInline", "resolveFixedThreads"])
// Switches that post less when on, which Everything leaves off.
const LESS_FLAGS = new Set<FlagName>(["summaryOnlyWithFindings"])

// Whether the Display tab shows its preview, per browser. Storage can throw
// (private mode, blocked site data), so it falls back to shown.
const PREVIEW_STORAGE_KEY = "sentryward-config-preview"

function readPreviewOpen() {
  try {
    return localStorage.getItem(PREVIEW_STORAGE_KEY) !== "hidden"
  } catch {
    return true
  }
}

function savePreviewOpen(open: boolean) {
  try {
    if (open) localStorage.removeItem(PREVIEW_STORAGE_KEY)
    else localStorage.setItem(PREVIEW_STORAGE_KEY, "hidden")
  } catch {
    // Not persisted; the choice still applies until the page reloads.
  }
}

// How each list matches, from skipFilterReason in
// server/src/review/config/filters.ts: titles and branches on a substring
// (titles ignoring case), logins and labels exactly (labels case-sensitively,
// as the forges treat them). Shown as a tag so the difference is not lost in
// the description.
const LIST_INFO: Record<ListName, { label: string; description: string; placeholder: string; match: string }> = {
  ignoreTitles: {
    label: "Ignore by title",
    description: "Phrases in the PR/MR title.",
    placeholder: "WIP",
    match: "contains, any case",
  },
  skipAuthors: {
    label: "Skip by author",
    description: "Logins of whoever opened or pushed the PR/MR.",
    placeholder: "dependabot[bot]",
    match: "exact, any case",
  },
  skipLabels: {
    label: "Skip by label",
    description: "Labels on the PR/MR.",
    placeholder: "no-review",
    match: "exact, case-sensitive",
  },
  skipSourceBranches: {
    label: "Skip by source branch",
    description: "Part of the branch the PR/MR is opened from.",
    placeholder: "release/",
    match: "contains",
  },
  skipTargetBranches: {
    label: "Skip by target branch",
    description: "Part of the branch the PR/MR targets.",
    placeholder: "legacy",
    match: "contains",
  },
}

// A titled group of fields within a tab.
function Section(props: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    // The legend stays a direct child so it names the fieldset.
    <FieldSet>
      <FieldLegend>{props.title}</FieldLegend>
      <FieldDescription className="-mt-3">{props.description}</FieldDescription>
      {props.children}
    </FieldSet>
  )
}

// Switches as rows of one bordered list, so a run of them reads as a group.
function ToggleList(props: { children: ReactNode }) {
  return <div className="divide-y rounded-lg border *:px-4 *:py-3">{props.children}</div>
}

// A row of a ToggleList that only applies while the row above is on, indented
// under it so the two read as one setting. The inner wrapper keeps the list's
// own row padding on the outer one. Several settings stack in one row.
function Nested(props: { children: ReactNode }) {
  return (
    <div>
      <div className="ml-2 flex flex-col gap-4 border-l-2 pl-4">{props.children}</div>
    </div>
  )
}

// Settings about one thing inside a Nested row, e.g. the effort estimate's
// text and its native label, so the second one is not hunted for elsewhere.
function Topic(props: { title: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={props.title} className="flex flex-col gap-3">
      <span aria-hidden className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.title}
      </span>
      {props.children}
    </div>
  )
}

const NUMBER_INFO: Record<NumberName, { label: string; description: string }> = {
  // The server drops temperature and adds the thinking budget to the reply
  // while thinking is on (thinkingSettings in server/src/review/llm/providers.ts).
  temperature: { label: "Temperature", description: "Lower is more deterministic. Ignored while thinking is on." },
  maxTokens: {
    label: "Max output tokens",
    description: "Per model call. While thinking is on, the thinking budget is added on top.",
  },
  // Matches promptCeiling in server/src/review/context/budget.ts.
  contextBudget: {
    label: "Context budget",
    description: `Prompt token ceiling per chunk. "${AUTO}" takes the provider's context window less the reply: max output tokens plus the thinking budget.`,
  },
  maxFindings: { label: "Max findings", description: "The most findings a review reports." },
  maxChunks: { label: "Max chunks", description: "Large changes are split into at most this many passes." },
  impactDepth: {
    label: "Caller depth",
    description: "How many hops of callers surrounding code follows from a changed function: 1 is its direct callers, 2 also theirs.",
  },
  minConfidence: {
    label: "Min confidence",
    description: "Findings below this self-reported confidence (0 to 1) are dropped. It is the model's own estimate, not a measured probability.",
  },
  maxSteps: { label: "Agent steps", description: "Model calls per agentic pass, the final report included." },
  maxToolTokens: { label: "Agent tool tokens", description: "What tools may return in one pass before the model must report." },
  maxSearches: { label: "Agent searches", description: "Code searches across the whole review. GitHub rate-limits search." },
  maxInlineComments: {
    label: "Max inline comments",
    description:
      'At most this many inline comments per review, the most severe first. The rest are written out in the summary comment. "none" posts every one.',
  },
}

// "x (from y)" for any config value, e.g. "critical (from global config)".
function describe(value: unknown, source: string | undefined) {
  let shown: string
  if (typeof value === "boolean") shown = value ? "on" : "off"
  else if (value === null) shown = AUTO
  else if (Array.isArray(value)) shown = value.length ? value.join(", ") : "none"
  else if (typeof value === "object" && value !== undefined) shown = Object.keys(value).join(", ") || "none"
  else shown = String(value)
  return `${shown}${source ? ` (from ${SOURCE_LABEL[source] ?? source})` : ""}`
}

// The layer a field's effective value comes from, as a tag beside the value.
// The repository file wins over everything set in the dashboard, so its tag
// says so.
function SourceBadge(props: { source: string; profile: string; repoFile?: string | null }) {
  const file = props.repoFile ?? ".sentryward.yaml"
  const label =
    props.source === "profile"
      ? `profile: ${props.profile}`
      : props.source === "repoFile"
        ? file
        : (BADGE_LABEL[props.source] ?? props.source)
  const badge = (
    <Badge variant="outline" className="h-4 px-1.5 text-[0.65rem] font-normal">
      {label}
    </Badge>
  )
  if (props.source !== "repoFile") return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={`Set in ${file}, which wins over these settings`}>
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent>Set in {file} in the repository, which wins over these settings. Change it there.</TooltipContent>
    </Tooltip>
  )
}

function ResetButton(props: { label: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Reset ${props.label} to inherited`}
          onClick={props.onClick}
          disabled={props.disabled}
        >
          <RotateCcw />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.hint ? `Inherit: ${props.hint}` : "Inherit"}</TooltipContent>
    </Tooltip>
  )
}

// What leaving a field empty gives, behind an icon beside the label: the
// placeholder already shows the inherited value, so the sentence is a detail.
// Screen readers still get it through the field's description.
function EmptyHint(props: { hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-hidden tabIndex={-1} className="text-muted-foreground hover:text-foreground">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{props.hint}</TooltipContent>
    </Tooltip>
  )
}

// The label row shared by the fields: the label, its tags, and the value a
// review gets when it comes from somewhere else, so it reads beside the name
// instead of as another line under the description.
function LabelRow(props: { children: ReactNode; effective?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {props.children}
      {props.effective && <span className="text-xs text-muted-foreground">{props.effective}</span>}
    </div>
  )
}

// A text field where empty means "not set here"; `emptyHint` says what that gives.
function TextField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  description: ReactNode
  emptyHint: string
  placeholder?: string
  multiline?: boolean
  inputMode?: "numeric" | "decimal"
  type?: string
  min?: number
  max?: number
  step?: number
  effective?: ReactNode
  // Shown under the description, e.g. what "auto" resolves to.
  extra?: ReactNode
  error?: string
  disabled?: boolean
}) {
  const shared = {
    id: props.id,
    value: props.value,
    placeholder: props.placeholder,
    disabled: props.disabled,
    "aria-invalid": props.error ? true : undefined,
  }
  return (
    <Field data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <LabelRow effective={props.effective}>
        <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
        <EmptyHint hint={props.emptyHint} />
      </LabelRow>
      {props.multiline ? (
        <Textarea {...shared} rows={4} onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <Input
          {...shared}
          type={props.type}
          inputMode={props.inputMode}
          min={props.min}
          max={props.max}
          step={props.step}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
      <FieldDescription>
        {props.description}
        <span className="sr-only"> {props.emptyHint}</span>
      </FieldDescription>
      {props.extra}
      {props.error && <FieldError>{props.error}</FieldError>}
    </Field>
  )
}

// One line per category in CATEGORIES (server/src/review/core/severity.ts), so
// the picker says what each one covers. A category missing here shows no line.
const CATEGORY_INFO: Record<string, string> = {
  security: "Injection, auth, secrets and unsafe data handling.",
  bug: "Code that does not do what it is meant to.",
  performance: "Needless work, slow queries and memory growth.",
  logic: "Wrong conditions, edge cases and ordering.",
  reliability: "Error handling, retries, races and resource leaks.",
  maintainability: "Code that is hard to change safely later.",
  testing: "Missing or weak tests for the change.",
  style: "Naming, formatting and local conventions.",
  docs: "Comments and docs that are missing or out of date.",
}

function CategoriesField(props: {
  options: string[]
  value: string[] | undefined
  inherited: string[] | undefined
  onChange: (value: string[] | undefined) => void
  resettable: boolean
  inheritedHint?: string
  effective?: ReactNode
  error?: string
  disabled?: boolean
}) {
  const overridden = props.resettable && props.value !== undefined
  const checked = props.value ?? props.inherited
  // Like a toggle, there is nothing truthful to show before the inherited value loads.
  const disabled = props.disabled || checked === undefined

  function toggle(category: string, on: boolean) {
    const current = new Set(checked)
    if (on) current.add(category)
    else current.delete(category)
    // Kept in the schema's order so an unchanged selection compares equal.
    props.onChange(props.options.filter((option) => current.has(option)))
  }

  return (
    <FieldSet data-disabled={disabled} data-invalid={props.error ? true : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLegend variant="label">Categories</FieldLegend>
        {checked && (
          <span className="text-xs text-muted-foreground">
            {checked.length} of {props.options.length} on
          </span>
        )}
        {overridden && <Badge variant="secondary">Overridden</Badge>}
        {props.effective && <span className="text-xs text-muted-foreground">{props.effective}</span>}
        {overridden && (
          <ResetButton
            label="Categories"
            hint={props.inheritedHint}
            onClick={() => props.onChange(undefined)}
            disabled={props.disabled}
          />
        )}
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => props.onChange([...props.options])}
            disabled={disabled || checked?.length === props.options.length}
          >
            All
          </Button>
          {/* Saving none is refused by the schema; the field error says why. */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => props.onChange([])}
            disabled={disabled || checked?.length === 0}
          >
            None
          </Button>
        </div>
      </div>
      <FieldDescription>What kinds of issues the reviewer looks for.</FieldDescription>
      <div className="grid grid-cols-2 gap-2 @md/field-group:grid-cols-3 @2xl/field-group:grid-cols-4">
        {props.options.map((category) => {
          const id = `category-${category}`
          // A label wrapping a field renders as a selectable card (see FieldLabel).
          return (
            <FieldLabel key={category} htmlFor={id}>
              <Field orientation="horizontal" data-disabled={disabled}>
                {/* Named by the category alone; the line under it describes it. */}
                <Checkbox
                  id={id}
                  aria-label={category}
                  aria-describedby={CATEGORY_INFO[category] ? `${id}-description` : undefined}
                  checked={checked?.includes(category) ?? false}
                  onCheckedChange={(on) => toggle(category, on === true)}
                  disabled={disabled}
                />
                <FieldContent>
                  <FieldTitle className="capitalize">{category}</FieldTitle>
                  {CATEGORY_INFO[category] && (
                    <FieldDescription id={`${id}-description`} className="text-xs">
                      {CATEGORY_INFO[category]}
                    </FieldDescription>
                  )}
                </FieldContent>
              </Field>
            </FieldLabel>
          )
        })}
      </div>
      {props.error && <FieldError>{props.error}</FieldError>}
    </FieldSet>
  )
}

function LanguageInstructionsField(props: {
  rows: FormState["languageInstructions"]
  onChange: (rows: FormState["languageInstructions"]) => void
  isRepo: boolean
  effective?: ReactNode
  error?: string
  disabled?: boolean
}) {
  const { rows } = props
  const update = (index: number, change: Partial<FormState["languageInstructions"][number]>) =>
    props.onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)))

  return (
    <FieldSet data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLegend variant="label">Language guidance</FieldLegend>
      <FieldDescription>
        Extra guidance for files in one language.
        {props.isRepo && " Added to the inherited languages; a language listed here replaces its inherited guidance."}
      </FieldDescription>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <Input
              aria-label={`Language ${index + 1}`}
              value={row.language}
              onChange={(e) => update(index, { language: e.target.value })}
              placeholder="TypeScript"
              disabled={props.disabled}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove language ${index + 1}`}
              onClick={() => props.onChange(rows.filter((_, i) => i !== index))}
              disabled={props.disabled}
            >
              <Trash2 />
            </Button>
          </div>
          <Textarea
            aria-label={`Guidance for language ${index + 1}`}
            value={row.text}
            onChange={(e) => update(index, { text: e.target.value })}
            placeholder="Prefer type narrowing over casts."
            rows={2}
            disabled={props.disabled}
          />
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => props.onChange([...rows, { language: "", text: "" }])}
          disabled={props.disabled}
        >
          <Plus />
          Add language
        </Button>
      </div>
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      {props.error && <FieldError>{props.error}</FieldError>}
    </FieldSet>
  )
}

// Rules another layer sets, with that layer, e.g. "no-secrets · critical (from global config)".
function RuleList(props: { label: string; rules: Rule[]; sources?: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">{props.label}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {props.rules.map((rule) => {
          const source = props.sources?.[`rules.${rule.id}`]
          return (
            <li key={rule.id} className="flex flex-wrap items-baseline gap-x-2">
              <code className="font-mono">{rule.id}</code>
              <span className="text-muted-foreground">
                {rule.severity}
                {rule.pattern !== undefined && " · pattern"}
                {source && ` (from ${SOURCE_LABEL[source] ?? source})`}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// The select's stand-in for a rule without a category, which files it under maintainability.
const NO_CATEGORY = "__none"

function RulesField(props: {
  rows: RuleRow[]
  onChange: (rows: RuleRow[]) => void
  isRepo: boolean
  severities: string[]
  categories: string[]
  // The rules from the layers below, which these add to.
  inherited?: Rule[]
  inheritedSources?: Record<string, string>
  config?: EffectiveConfig
  sources?: Record<string, string>
  patternErrors?: Record<string, string | null>
  error?: string
  disabled?: boolean
}) {
  const { rows } = props
  const rowErrors = ruleRowErrors(rows, props.patternErrors)
  const update = (index: number, change: Partial<RuleRow>) =>
    props.onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)))
  const inheritedIds = new Map((props.inherited ?? []).map((rule) => [rule.id, props.inheritedSources?.[`rules.${rule.id}`]]))
  const severityOptions = props.severities.map((value) => ({ value, label: value }))
  const categoryOptions = [
    { value: NO_CATEGORY, label: "maintainability", description: "The default" },
    ...props.categories.filter((value) => value !== "maintainability").map((value) => ({ value, label: value })),
  ]

  return (
    <FieldSet data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLegend variant="label">Team rules</FieldLegend>
      <FieldDescription>
        Conventions every review checks, with a severity. A rule with a pattern is matched against added lines without a
        model; the rest are given to the model.{" "}
        {props.isRepo
          ? "Added to the global config's rules. The repository file can add more but not replace these: a rule whose id is already set is ignored, with a warning."
          : "Applied to every repository. Repository settings and files can add rules but not replace these: a rule whose id is already set is ignored, with a warning."}
      </FieldDescription>
      {props.inherited && props.inherited.length > 0 && (
        <RuleList label="Inherited" rules={props.inherited} sources={props.inheritedSources} />
      )}
      {rows.map((row, index) => {
        const errors = rowErrors[index] ?? {}
        const n = index + 1
        const shadowedBy = inheritedIds.has(row.id.trim()) ? inheritedIds.get(row.id.trim()) : undefined
        return (
          <div key={index} className="flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex items-start gap-2">
              <div className="grid flex-1 gap-3 @md/field-group:grid-cols-3">
                <Field data-invalid={errors.id ? true : undefined}>
                  <FieldLabel htmlFor={`rule-${n}-id`}>Id</FieldLabel>
                  <Input
                    id={`rule-${n}-id`}
                    aria-label={`Rule ${n} id`}
                    value={row.id}
                    onChange={(e) => update(index, { id: e.target.value })}
                    placeholder="no-db-in-controllers"
                    className="font-mono"
                    disabled={props.disabled}
                    aria-invalid={errors.id ? true : undefined}
                  />
                  {errors.id && <FieldError>{errors.id}</FieldError>}
                  {!errors.id && inheritedIds.has(row.id.trim()) && (
                    <FieldDescription className="text-destructive">
                      {shadowedBy ? `The ${SOURCE_LABEL[shadowedBy] ?? shadowedBy}` : "An inherited rule"} already uses this
                      id, so that rule applies instead of this one.
                    </FieldDescription>
                  )}
                </Field>
                <Field data-invalid={errors.severity ? true : undefined}>
                  <FieldLabel htmlFor={`rule-${n}-severity`}>Severity</FieldLabel>
                  <SearchableSelect
                    id={`rule-${n}-severity`}
                    value={row.severity || undefined}
                    onValueChange={(severity) => update(index, { severity })}
                    options={severityOptions}
                    disabled={props.disabled}
                    aria-invalid={errors.severity ? true : undefined}
                  />
                  {errors.severity && <FieldError>{errors.severity}</FieldError>}
                </Field>
                <Field>
                  <FieldLabel htmlFor={`rule-${n}-category`}>Category</FieldLabel>
                  <SearchableSelect
                    id={`rule-${n}-category`}
                    value={row.category || NO_CATEGORY}
                    onValueChange={(category) => update(index, { category: category === NO_CATEGORY ? "" : category })}
                    options={categoryOptions}
                    disabled={props.disabled}
                  />
                </Field>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove rule ${n}`}
                onClick={() => props.onChange(rows.filter((_, i) => i !== index))}
                disabled={props.disabled}
              >
                <Trash2 />
              </Button>
            </div>
            <Field data-invalid={errors.description ? true : undefined}>
              <FieldLabel htmlFor={`rule-${n}-description`}>Description</FieldLabel>
              <Textarea
                id={`rule-${n}-description`}
                value={row.description}
                onChange={(e) => update(index, { description: e.target.value })}
                placeholder="Controllers must not import Prisma directly; go through a service."
                rows={2}
                disabled={props.disabled}
                aria-invalid={errors.description ? true : undefined}
              />
              {errors.description && <FieldError>{errors.description}</FieldError>}
            </Field>
            <div className="grid gap-3 @md/field-group:grid-cols-2">
              <Field data-invalid={errors.paths ? true : undefined}>
                <FieldLabel htmlFor={`rule-${n}-paths`}>Paths</FieldLabel>
                <Textarea
                  id={`rule-${n}-paths`}
                  value={row.paths}
                  onChange={(e) => update(index, { paths: e.target.value })}
                  placeholder="server/src/controllers/**"
                  rows={2}
                  className="font-mono"
                  disabled={props.disabled}
                />
                <FieldDescription>One glob per line; empty covers every reviewed file.</FieldDescription>
                {errors.paths && <FieldError>{errors.paths}</FieldError>}
              </Field>
              <Field data-invalid={errors.pattern ? true : undefined}>
                <FieldLabel htmlFor={`rule-${n}-pattern`}>Pattern</FieldLabel>
                <Input
                  id={`rule-${n}-pattern`}
                  value={row.pattern}
                  onChange={(e) => update(index, { pattern: e.target.value })}
                  placeholder={"from [\"']@prisma/client"}
                  maxLength={MAX_RULE_PATTERN + 1}
                  className="font-mono"
                  disabled={props.disabled}
                  aria-invalid={errors.pattern ? true : undefined}
                />
                <FieldDescription>Optional regular expression (RE2: no lookarounds or backreferences).</FieldDescription>
                {errors.pattern && <FieldError>{errors.pattern}</FieldError>}
              </Field>
            </div>
            {!row.pattern && (
              <div className="grid gap-3 @md/field-group:grid-cols-2">
                {(["good", "bad"] as const).map((field) => (
                  <Field key={field} data-invalid={errors[field] ? true : undefined}>
                    <FieldLabel htmlFor={`rule-${n}-${field}`}>{field === "good" ? "Good example" : "Bad example"}</FieldLabel>
                    <Textarea
                      id={`rule-${n}-${field}`}
                      value={row[field]}
                      onChange={(e) => update(index, { [field]: e.target.value })}
                      rows={3}
                      className="font-mono"
                      disabled={props.disabled}
                    />
                    {errors[field] && <FieldError>{errors[field]}</FieldError>}
                  </Field>
                ))}
              </div>
            )}
          </div>
        )
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => props.onChange([...rows, { ...EMPTY_RULE }])}
          disabled={props.disabled}
        >
          <Plus />
          Add rule
        </Button>
      </div>
      {props.config && props.config.rules.length > 0 && (
        <RuleList label="Effective" rules={props.config.rules} sources={props.sources} />
      )}
      {props.config && props.config.rules.length === 0 && (
        <FieldDescription className="text-xs">Effective: none</FieldDescription>
      )}
      {props.error && <FieldError>{props.error}</FieldError>}
    </FieldSet>
  )
}

// Rows are plain strings (blank or repeated while typing), so each gets an id
// that follows it through drags; the index would make dnd-kit swap the wrong rows.
let nextFallbackId = 0
const fallbackId = () => `fallback-${nextFallbackId++}`

function FallbackModelsField(props: {
  rows: string[]
  onChange: (rows: string[]) => void
  emptyHint: string
  effective?: ReactNode
  error?: string
  disabled?: boolean
  suggestions?: ModelSuggestions
  warning?: ReactNode
}) {
  const { rows } = props
  const [ids, setIds] = useState(() => rows.map(fallbackId))
  // The form was loaded or reset underneath us: start the ids over.
  if (ids.length !== rows.length) setIds(rows.map(fallbackId))

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so clicking the handle stays a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    setIds(arrayMove(ids, from, to))
    props.onChange(arrayMove(rows, from, to))
  }

  function add() {
    setIds([...ids, fallbackId()])
    props.onChange([...rows, ""])
  }

  function remove(index: number) {
    setIds(ids.filter((_, i) => i !== index))
    props.onChange(rows.filter((_, i) => i !== index))
  }

  return (
    <FieldSet data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLegend variant="label">Fallback models</FieldLegend>
      {rows.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ol aria-label="Fallback model order" className="flex flex-col gap-2">
              {rows.map((model, index) => (
                <SortableFallbackRow
                  key={ids[index] ?? index}
                  id={ids[index] ?? String(index)}
                  index={index}
                  model={model}
                  onChange={(value) => props.onChange(rows.map((row, i) => (i === index ? value : row)))}
                  onRemove={() => remove(index)}
                  disabled={props.disabled}
                  invalid={Boolean(props.error)}
                  suggestions={props.suggestions}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={props.disabled || rows.length >= MAX_FALLBACK_MODELS}
        >
          <Plus />
          Add fallback model
        </Button>
      </div>
      <FieldDescription>
        Tried in order when the model fails, up to {MAX_FALLBACK_MODELS}. Drag to reorder. {props.emptyHint}
      </FieldDescription>
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      {props.warning}
      {props.error && <FieldError>{props.error}</FieldError>}
    </FieldSet>
  )
}

function SortableFallbackRow(props: {
  id: string
  index: number
  model: string
  onChange: (value: string) => void
  onRemove: () => void
  disabled?: boolean
  invalid: boolean
  suggestions?: ModelSuggestions
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: props.disabled,
  })
  const n = props.index + 1

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("flex items-center gap-2", isDragging && "relative z-10 opacity-80")}
    >
      {!props.disabled && (
        <DragHandle
          label={`Reorder fallback model ${n}`}
          handleRef={setActivatorNodeRef}
          attributes={attributes}
          listeners={listeners}
        />
      )}
      <ModelCombobox
        aria-label={`Fallback model ${n}`}
        value={props.model}
        onChange={props.onChange}
        placeholder="openai/gpt-5"
        disabled={props.disabled}
        aria-invalid={props.invalid ? true : undefined}
        suggestions={props.suggestions}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove fallback model ${n}`}
        onClick={props.onRemove}
        disabled={props.disabled}
      >
        <Trash2 />
      </Button>
    </li>
  )
}

function ChoiceField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  // Present in a repository, where the field can fall back to the global config;
  // the description says what that currently resolves to.
  inherit?: { description?: string }
  // Shown instead of "inherit" when there is no Inherit option.
  fallback?: string
  description?: ReactNode
  effective?: ReactNode
  // Shown under the description, e.g. why the field is greyed out.
  hint?: ReactNode
  error?: string
  disabled?: boolean
}) {
  const { inherit } = props
  const value = !inherit && props.value === INHERIT ? (props.fallback ?? INHERIT) : props.value
  return (
    <Field data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <LabelRow effective={props.effective}>
        <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      </LabelRow>
      <SearchableSelect
        id={props.id}
        value={value}
        onValueChange={props.onChange}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        options={
          inherit ? [{ value: INHERIT, label: "Inherit", description: inherit.description }, ...props.options] : props.options
        }
      />
      {props.description && <FieldDescription>{props.description}</FieldDescription>}
      {props.hint}
      {props.error && <FieldError>{props.error}</FieldError>}
    </Field>
  )
}

// A switch over a tri-state value: it shows the override when there is one and
// the inherited value otherwise, so "inherit" stays reachable through reset.
function ToggleField(props: {
  name: FlagName
  value: boolean | undefined
  inherited: boolean | undefined
  onChange: (value: boolean | undefined) => void
  // Only a repository can go back to inheriting; the global config just holds a value.
  resettable: boolean
  inheritedHint?: string
  effective?: ReactNode
  disabled?: boolean
  // Why the switch is greyed out, e.g. "Needs Post summary comment". Read out
  // with the switch, since greying alone tells assistive tech nothing.
  offReason?: string
  // Shown under the description, e.g. a consequence of the current value.
  extra?: ReactNode
}) {
  const { label, description, cost } = FLAG_INFO[props.name]
  const id = `flag-${props.name}`
  const reasonId = `${id}-off`
  const overridden = props.resettable && props.value !== undefined
  // Without an override or a resolved value there is nothing truthful to show yet.
  const disabled = props.disabled || (!overridden && props.inherited === undefined)

  return (
    <Field orientation="horizontal" data-disabled={disabled}>
      <FieldContent>
        <LabelRow effective={props.effective}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          {cost && (
            <Badge variant="outline" className="h-4 px-1.5 text-[0.65rem] font-normal">
              {cost}
            </Badge>
          )}
          {overridden && <Badge variant="secondary">Overridden</Badge>}
        </LabelRow>
        <FieldDescription>{description}</FieldDescription>
        {props.offReason && (
          <FieldDescription id={reasonId} className="text-xs">
            {props.offReason}
          </FieldDescription>
        )}
        {props.extra}
      </FieldContent>
      <div className="flex items-center gap-2">
        {overridden && (
          <ResetButton
            label={label}
            hint={props.inheritedHint}
            onClick={() => props.onChange(undefined)}
            disabled={props.disabled}
          />
        )}
        <Switch
          id={id}
          checked={props.value ?? props.inherited ?? false}
          onCheckedChange={(checked) => props.onChange(checked)}
          disabled={disabled}
          aria-describedby={props.offReason ? reasonId : undefined}
        />
      </div>
    </Field>
  )
}

// Why a saved connection may fail, for the picker, or undefined while it looks fine.
function attentionLabel(key: ApiKey, status: LlmConnectionStatus | undefined) {
  if (!needsAttention(key, status)) return undefined
  if (key.blocked || status === "blocked") return STATUS_LABELS.blocked
  if (key.undecryptable) return "Unreadable key"
  return status ? STATUS_LABELS[status] : undefined
}

// Says why a field is greyed out and opens the tab with the setting that turns
// it on. Without a tab the setting is on the same tab, so there is nothing to
// open (toggles on one tab use ToggleField's offReason instead).
function OffHint(props: { setting: string; tab?: ConfigTab; onTabChange: (tab: ConfigTab) => void }) {
  const { tab } = props
  if (!tab) return <FieldDescription className="text-xs">Only used when {props.setting} is on.</FieldDescription>
  const tabLabel = CONFIG_TABS.find((item) => item.value === tab)!.label
  return (
    <FieldDescription className="text-xs">
      Only used when {props.setting} is on (
      <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => props.onTabChange(tab)}>
        {tabLabel} tab
      </Button>
      ).
    </FieldDescription>
  )
}

// What "auto" resolves to, the same way as promptCeiling on the server.
function autoContextBudget(
  schema: ConfigSchema | undefined,
  model: string,
  maxTokens: number | undefined,
  thinking: ThinkingLevel | undefined,
) {
  if (!schema?.contextWindows || !model || maxTokens === undefined) return undefined
  const provider = model.split("/")[0] ?? ""
  const window = schema.contextWindows[provider] ?? schema.defaultContextWindow
  return { window, provider, budget: window - (maxTokens + (schema.thinkingBudgets[thinking ?? "off"] ?? 0)) }
}

// The editable subset of a review config, shared by the global config and a
// repository's overrides, split into tabs. `config`/`sources` describe the
// effective values; `inherited`/`inheritedSources` describe what a field gets
// when this scope does not set it (the profile and defaults for the global
// config, the global config for a repository). Form state lives in the caller,
// so switching tabs keeps unsaved edits and one save covers every tab.
export function ConfigFields(props: {
  mode: "global" | "repo"
  form: FormState
  onChange: (form: FormState) => void
  tab: ConfigTab
  onTabChange: (tab: ConfigTab) => void
  // Where the page's scope card wants the Profile field: both apply to every
  // tab, but the profile's form state lives here, so it is portalled into the
  // card. null while the slot mounts; undefined renders it above the tabs.
  profileSlot?: HTMLElement | null
  // Shown between the tab list and the open tab, e.g. warnings for the scope.
  notices?: ReactNode
  // The save bar, at the bottom of every tab.
  footer: ReactNode
  config?: EffectiveConfig
  sources?: Record<string, string>
  inherited?: EffectiveConfig
  inheritedSources?: Record<string, string>
  // The repository file that applies, named in the tags of the fields it sets.
  repoFile?: string | null
  errors?: FormErrors
  // The server's RE2 answers for rule patterns (useRulePatternErrors).
  rulePatternErrors?: Record<string, string | null>
  disabled?: boolean
  guidanceLabel?: string
}) {
  const { mode, form, config, sources, inherited, disabled } = props
  const errors = props.errors ?? {}
  const isRepo = mode === "repo"
  const schema = useConfigSchema()
  const apiKeys = useApiKeys()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(readPreviewOpen)
  // The preview view the last changed Display setting shows up in (ReviewPreview).
  const [previewFocus, setPreviewFocus] = useState<{ view: PreviewView; seq: number }>()
  // An example picked while the instructions hold text, waiting for a confirm.
  const [pendingExample, setPendingExample] = useState<(typeof SUMMARY_EXAMPLES)[number]>()
  function focusPreview(view: PreviewView) {
    setPreviewFocus((last) => ({ view, seq: (last?.seq ?? 0) + 1 }))
  }
  // The model pickers list what the connection that will run the review
  // offers: the inherited one while this scope does not pick its own.
  const modelsProvider =
    disabled || form.connection === INHERIT
      ? (inherited?.llm.connection ?? null)
      : (form.connection as LlmProviderName)
  const llmModels = useLlmModels(modelsProvider)
  const modelSuggestions: ModelSuggestions | undefined = modelsProvider
    ? { models: llmModels.data?.models ?? [], loading: llmModels.isPending, error: llmModels.isError }
    : undefined
  // An official API only runs its own models (the worker refuses the rest);
  // a custom host may serve any provider's protocol.
  const officialProvider =
    modelsProvider && apiKeys.data?.keys.some((key) => key.provider === modelsProvider && key.stored && !key.baseUrl)
      ? modelsProvider
      : null
  const runsOn = (model: string) => !officialProvider || !model.trim() || model.trim().startsWith(`${officialProvider}/`)
  const mismatchHint = officialProvider && (
    <FieldDescription className="text-destructive">
      The {LLM_PROVIDERS[officialProvider].label} connection can only run {officialProvider}/... models.
    </FieldDescription>
  )
  type TextKey = "profile" | "model" | "walkthroughModel" | "verifyModel" | "severityFloor" | "blockOn" | "ignorePaths" | "instructions"
  const setField = (key: TextKey) => (value: string) => props.onChange({ ...form, [key]: value })
  const setFlag = (name: FlagName) => (value: boolean | undefined) => {
    if (DISPLAY_FLAGS.includes(name)) focusPreview(INLINE_FLAGS.has(name) ? "inline" : "summary")
    props.onChange({ ...form, flags: { ...form.flags, [name]: value } })
  }
  const setNumber = (name: NumberName) => (value: string) => {
    if (INLINE_NUMBERS.has(name)) focusPreview("inline")
    props.onChange({ ...form, numbers: { ...form.numbers, [name]: value } })
  }

  // Only worth showing when the value comes from somewhere else (a profile, a
  // default, the repository file): what this scope sets is already in its input.
  function effective(path: string, value: unknown) {
    if (!config) return undefined
    const source = sources?.[path]
    if (source === (isRepo ? "repoSettings" : "global")) return undefined
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span>Effective: {describe(value, undefined)}</span>
        {source && <SourceBadge source={source} profile={config.profile} repoFile={props.repoFile} />}
      </span>
    )
  }

  function effectiveLine(path: string, value: unknown) {
    const line = effective(path, value)
    return line && <FieldDescription className="text-xs">{line}</FieldDescription>
  }

  // A field the repository file sets cannot be changed from here: the file
  // wins, so an override saved here would do nothing.
  function locked(path: string) {
    return disabled || fromRepoFile(path)
  }

  function fromRepoFile(path: string) {
    return isRepo && sources?.[path] === "repoFile"
  }

  // What "Inherit" resolves to right now, e.g. "critical (from global config)".
  function inheritedHint(path: string, value: unknown) {
    if (!inherited || value === undefined) return undefined
    return describe(value, props.inheritedSources?.[path])
  }

  function choice(path: string, value: string | undefined) {
    return isRepo ? { inherit: { description: inheritedHint(path, value) } } : { fallback: value }
  }

  function inheritedFlag(name: FlagName) {
    const { section } = FLAGS.find((flag) => flag.name === name)!
    return inherited ? (inherited[section] as Record<string, unknown>)[name] as boolean : undefined
  }

  // `off` greys out settings that do nothing right now, e.g. labels without a
  // summary. `needs` names the setting on the same tab that turns them on; it is
  // only said when that is the reason, not when the field is locked anyway.
  // `extras` adds a line under a setting's description.
  function toggles(
    names: FlagName[],
    off = false,
    needs?: string,
    extras?: Partial<Record<FlagName, ReactNode>>,
  ) {
    return names.map((name) => {
      const { section } = FLAGS.find((flag) => flag.name === name)!
      const path = `${section}.${name}`
      const fallback = inheritedFlag(name)
      return (
        <ToggleField
          key={name}
          name={name}
          value={form.flags[name]}
          inherited={fallback}
          onChange={setFlag(name)}
          resettable={isRepo}
          inheritedHint={inheritedHint(path, fallback)}
          effective={config && effective(path, (config[section] as Record<string, unknown>)[name])}
          disabled={locked(path) || off}
          offReason={off && needs && !locked(path) ? `Needs ${needs}` : undefined}
          extra={extras?.[name]}
        />
      )
    })
  }

  // What leaving a text field empty gives in this scope.
  function emptyHint(path: string, value: unknown) {
    if (isRepo) return `Leave empty to inherit${inherited ? ` ${inheritedHint(path, value)}` : ""}.`
    return `Leave empty to use the default${inherited ? ` (${describe(value, undefined)})` : ""}.`
  }

  // A model for one purpose; empty falls through the layers and then to llm.model.
  // `off` names the setting (and its tab) without which the model is never
  // called; the field is greyed out but keeps its value.
  function purposeModelField(
    name: "walkthroughModel" | "verifyModel",
    label: string,
    off?: { setting: string; tab: ConfigTab },
  ) {
    const path = `llm.${name}`
    const shown = (llm: EffectiveConfig["llm"]) => llm[name] ?? `same as model (${llm.model})`
    return (
      <Field data-disabled={locked(path) || Boolean(off)}>
        <FieldLabel htmlFor={name}>{label}</FieldLabel>
        <ModelCombobox
          id={name}
          aria-label={label}
          value={form[name]}
          onChange={setField(name)}
          placeholder={inherited ? shown(inherited.llm) : config ? shown(config.llm) : "Same as model"}
          disabled={locked(path) || Boolean(off)}
          aria-invalid={errors[name] ? true : undefined}
          suggestions={modelSuggestions}
        />
        <FieldDescription>{emptyHint(path, inherited && shown(inherited.llm))}</FieldDescription>
        {off && <OffHint setting={off.setting} tab={off.tab} onTabChange={props.onTabChange} />}
        {config && effectiveLine(path, shown(config.llm))}
        {!disabled && !runsOn(form[name]) && mismatchHint}
        {errors[name] && <FieldError>{errors[name]}</FieldError>}
      </Field>
    )
  }

  function choiceField(name: ChoiceName, off = false, hint?: ReactNode) {
    const spec = CHOICES.find((choice) => choice.name === name)!
    const path = `${spec.section}.${choiceKey(spec)}`
    const raw = inherited ? at(inherited, path) : undefined
    // Booleans are offered as "true" and "false".
    const fallback = typeof raw === "boolean" ? String(raw) : (raw as string | null | undefined)
    const info = CHOICE_INFO[name]
    const label = (value: unknown) =>
      value === null && info.nullLabel
        ? info.nullLabel
        : (info.options.find((option) => option.value === String(value))?.label ?? value)
    return (
      <ChoiceField
        id={`choice-${name}`}
        label={info.label}
        value={form.choices[name]}
        onChange={(value) => {
          if (spec.section === "output") focusPreview(INLINE_CHOICES.has(name) ? "inline" : "summary")
          props.onChange({ ...form, choices: { ...form.choices, [name]: value } })
        }}
        options={info.options}
        // The global config selects the fallback itself, so it stays the raw value.
        {...(isRepo
          ? { inherit: { description: inheritedHint(path, fallback === undefined ? undefined : label(fallback)) } }
          : { fallback: fallback ?? undefined })}
        description={info.description}
        hint={off ? hint : undefined}
        effective={config && effective(path, label(at(config, path)))}
        disabled={locked(path) || off}
      />
    )
  }

  // `off` greys out a list the worker never checks right now (automatic
  // reviews are off); the saved value is kept.
  function listField(name: ListName, off = false) {
    const path = `triggers.${name}`
    const fallback = inherited?.triggers[name]
    const info = LIST_INFO[name]
    const id = `list-${name}`
    const error = errors[name]
    const fieldOff = locked(path) || off
    // Only worth a hint when leaving it empty actually inherits something.
    const hint = isRepo && fallback?.length ? ` ${emptyHint(path, fallback)}` : ""
    // A list here replaces the inherited one rather than adding to it.
    const replaces = isRepo && !disabled && form.lists[name].length > 0 && Boolean(fallback?.length)
    return (
      <Field data-disabled={fieldOff} data-invalid={error ? true : undefined}>
        <LabelRow effective={config && effective(path, config.triggers[name])}>
          <FieldLabel htmlFor={id}>{info.label}</FieldLabel>
          <Badge variant="outline" className="h-4 px-1.5 text-[0.65rem] font-normal">
            {info.match}
          </Badge>
        </LabelRow>
        <TagInput
          id={id}
          value={form.lists[name]}
          onChange={(value) => props.onChange({ ...form, lists: { ...form.lists, [name]: value } })}
          placeholder={fallback?.length ? fallback.join(", ") : `e.g. ${info.placeholder}, then Enter`}
          disabled={fieldOff}
          aria-invalid={error ? true : undefined}
        />
        <FieldDescription>
          {info.description}
          {hint}
        </FieldDescription>
        {replaces && (
          <FieldDescription className="text-xs">Replaces the inherited list: {fallback!.join(", ")}.</FieldDescription>
        )}
        {error && <FieldError>{error}</FieldError>}
      </Field>
    )
  }


  // `off` greys out a value the model call ignores right now, e.g. temperature while thinking.
  function numberField(name: NumberName, extra?: ReactNode, off = false) {
    const spec = NUMBERS.find((number) => number.name === name)!
    const path = `${spec.section}.${name}`
    const fallback = inherited ? (at(inherited, path) as number | null) : undefined
    // A saved null is shown as the word typed for it, e.g. "auto" or "none".
    const shown = (value: unknown) => (value === null && spec.nullable ? spec.nullable : value)
    const { label, description } = NUMBER_INFO[name]
    return (
      <TextField
        id={`number-${name}`}
        label={label}
        value={form.numbers[name]}
        onChange={setNumber(name)}
        description={description}
        emptyHint={emptyHint(path, shown(fallback))}
        placeholder={fallback === undefined ? undefined : String(shown(fallback))}
        // A word for null, such as the context budget's "auto", would be rejected by a number input.
        type={spec.nullable ? "text" : "number"}
        inputMode={spec.integer ? "numeric" : "decimal"}
        min={spec.nullable ? undefined : spec.min}
        max={spec.nullable ? undefined : spec.max}
        step={spec.nullable ? undefined : spec.step}
        effective={config && effective(path, shown(at(config, path)))}
        extra={extra}
        error={errors[name]}
        disabled={locked(path) || off}
      />
    )
  }

  // A repository that follows the global config ignores its overrides, so it
  // shows (and previews) the global values.
  const shownFlag = (name: FlagName) => (disabled ? inheritedFlag(name) : (form.flags[name] ?? inheritedFlag(name))) ?? false
  const walkthroughOn = shownFlag("walkthrough")
  const postSummaryOn = shownFlag("postSummary")
  const postInlineOn = shownFlag("postInline")
  const reviewOnPushOn = shownFlag("reviewOnPush")
  const toolFindingsOn = shownFlag("toolFindings")
  const highLevelSummaryOn = walkthroughOn && shownFlag("highLevelSummary")
  const inheritedSummaryInstructions = inherited?.output.highLevelSummaryInstructions
  // Only a setting known to be off greys out a model field, so nothing
  // flickers while the inherited values load. The repository file wins over
  // both the form and what it inherits.
  const verifyChoice = fromRepoFile("review.verify")
    ? config?.review.verify
    : disabled || form.choices.verify === INHERIT
      ? inherited?.review.verify
      : form.choices.verify
  const verifyOn = verifyChoice !== "off"

  // What a review would run with for one field, unsaved edits included, the
  // same way as verifyChoice: the repository file wins, a repository that
  // follows the global config shows the inherited value, and an unset field
  // inherits. undefined while the inherited values load.
  function resolvedChoice(name: ChoiceName) {
    const spec = CHOICES.find((choice) => choice.name === name)!
    const path = `${spec.section}.${choiceKey(spec)}`
    const raw = fromRepoFile(path)
      ? at(config, path)
      : disabled || form.choices[name] === INHERIT
        ? at(inherited, path)
        : form.choices[name]
    return raw === undefined || raw === null ? undefined : String(raw)
  }
  function resolvedFlag(name: FlagName) {
    const { section } = FLAGS.find((flag) => flag.name === name)!
    if (fromRepoFile(`${section}.${name}`))
      return (config?.[section] as Record<string, unknown> | undefined)?.[name] as boolean | undefined
    return disabled ? inheritedFlag(name) : (form.flags[name] ?? inheritedFlag(name))
  }
  function resolvedNumber(name: NumberName) {
    const spec = NUMBERS.find((number) => number.name === name)!
    const path = `${spec.section}.${name}`
    const typed = form.numbers[name].trim()
    const raw = fromRepoFile(path) ? at(config, path) : disabled || !typed ? at(inherited, path) : Number(typed)
    return typeof raw === "number" ? raw : undefined
  }
  function resolvedText(key: "severityFloor" | "blockOn") {
    const path = `review.${key}`
    if (fromRepoFile(path)) return config?.review[key]
    return disabled || form[key] === INHERIT ? inherited?.review[key] : form[key]
  }
  const contextChoice = resolvedChoice("context")
  // Only a value known to be off greys a field out, so nothing flickers while
  // the inherited values load.
  const agentLimitsOff = contextChoice === "static"
  const fileContextOff = resolvedFlag("fileContext") === false
  const severityFloorValue = resolvedText("severityFloor")
  const blockOnValue = resolvedText("blockOn")

  // A slider beside the confidence input, for a value that is easier to judge
  // on a scale. The input stays the field: empty still inherits, and the
  // slider shows the inherited value until it is moved.
  const confidenceSpec = NUMBERS.find((number) => number.name === "minConfidence")!
  const confidenceValue = resolvedNumber("minConfidence")
  const confidenceSlider = (
    <input
      type="range"
      aria-label="Min confidence slider"
      className="w-full accent-primary disabled:opacity-50"
      min={confidenceSpec.min}
      max={confidenceSpec.max}
      step={confidenceSpec.step}
      value={confidenceValue ?? confidenceSpec.min}
      onChange={(e) => setNumber("minConfidence")(e.target.value)}
      disabled={locked("review.minConfidence") || confidenceValue === undefined}
    />
  )
  const walkthroughValue = fromRepoFile("output.walkthrough")
    ? config?.output.walkthrough
    : disabled
      ? inheritedFlag("walkthrough")
      : (form.flags.walkthrough ?? inheritedFlag("walkthrough"))
  const walkthroughKnownOff = walkthroughValue === false

  // The Display tab's presets. Each gives every Display switch a value; the
  // form takes them like manual changes (unsaved, overrides in a repository),
  // except where the repository file sets the field and would win anyway.
  function presetFlags(preset: DisplayPreset) {
    const defaults = schema.data?.defaults.output as Record<string, unknown> | undefined
    if (preset === "standard" && !defaults) return undefined
    return Object.fromEntries(
      DISPLAY_FLAGS.map((name) => [
        name,
        preset === "everything" ? !LESS_FLAGS.has(name) : preset === "minimal" ? MINIMAL_ON.has(name) : Boolean(defaults![name]),
      ]),
    ) as Partial<Record<FlagName, boolean>>
  }
  function applyPreset(preset: DisplayPreset) {
    const values = presetFlags(preset)
    if (!values) return
    const flags = { ...form.flags }
    for (const name of DISPLAY_FLAGS) {
      if (!locked(`output.${name}`)) flags[name] = values[name]
    }
    focusPreview("summary")
    props.onChange({ ...form, flags })
  }
  // The preset the settings match right now, if any.
  const activePreset = DISPLAY_PRESETS.find((preset) => {
    const values = presetFlags(preset.value)
    return values && DISPLAY_FLAGS.every((name) => resolvedFlag(name) === values[name])
  })?.value

  // With the summary comment off, the PR summary is still posted as a comment
  // of its own (summaryPlacement in server/src/review/publish/publisher.ts).
  // Native labels need the PR summary too, so with it and the three post
  // switches off nothing at all reaches the change. Only values known to be
  // off count, so nothing flickers while the inherited values load.
  const standaloneSummary = resolvedFlag("postSummary") === false && resolvedFlag("walkthrough") === true
  const nothingPosted = (["postInline", "postSummary", "postCheck", "walkthrough"] as const).every(
    (name) => resolvedFlag(name) === false,
  )

  // The high-level summary instructions, counted the way validation does.
  const summaryLength = form.summaryInstructions.trim().length
  const setSummaryInstructions = (summaryInstructions: string) => {
    focusPreview("summary")
    props.onChange({ ...form, summaryInstructions })
  }
  function pickExample(example: (typeof SUMMARY_EXAMPLES)[number]) {
    // Typed instructions are never replaced without a confirm.
    if (form.summaryInstructions.trim()) setPendingExample(example)
    else {
      setPendingExample(undefined)
      setSummaryInstructions(example.text)
    }
  }
  const summaryFieldOff = locked("output.highLevelSummaryInstructions") || !highLevelSummaryOn

  // The Triggers tab. With automatic reviews off the worker drops every
  // webhook job before looking at push, summary or skip settings (skipReason
  // in server/src/review/config/filters.ts), so those grey out; only a value
  // known to be manual does it, so nothing flickers while inherited values load.
  const reviewChoice = resolvedChoice("review")
  const reviewManual = reviewChoice === "manual"
  function resolvedList(name: ListName) {
    const path = `triggers.${name}`
    if (fromRepoFile(path)) return config?.triggers[name]
    return disabled || form.lists[name].length === 0 ? inherited?.triggers[name] : form.lists[name]
  }
  const summaryHint = walkthroughKnownOff ? (
    <OffHint setting="PR summary" tab="display" onTabChange={props.onTabChange} />
  ) : reviewManual ? (
    <FieldDescription className="text-xs">Only used for automatic reviews.</FieldDescription>
  ) : undefined

  // What a review would run with, unsaved edits included: a field the
  // repository file sets gives the file's value, an empty one the inherited.
  const effectiveModel =
    (locked("llm.model") ? config?.llm.model : form.model.trim() || inherited?.llm.model) ?? ""
  const typedMaxTokens = form.numbers.maxTokens.trim() ? Number(form.numbers.maxTokens) : undefined
  const effectiveMaxTokens = locked("llm.maxTokens")
    ? config?.llm.maxTokens
    : typedMaxTokens !== undefined && Number.isFinite(typedMaxTokens)
      ? typedMaxTokens
      : inherited?.llm.maxTokens
  const effectiveThinking = locked("llm.thinking")
    ? config?.llm.thinking
    : form.choices.thinking === INHERIT
      ? inherited?.llm.thinking
      : (form.choices.thinking as ThinkingLevel)
  const autoBudget = autoContextBudget(schema.data, effectiveModel, effectiveMaxTokens, effectiveThinking)
  const typedBudget = form.numbers.contextBudget.trim()
  const budgetValue = typedBudget && typedBudget !== AUTO ? Number(typedBudget) : undefined
  const budgetHint = autoBudget && (
    <>
      <FieldDescription className="text-xs">
        {AUTO} = {autoBudget.budget.toLocaleString("en-US")} tokens: the {autoBudget.provider} window of{" "}
        {autoBudget.window.toLocaleString("en-US")} less the reply.
      </FieldDescription>
      {budgetValue !== undefined && budgetValue > autoBudget.budget && (
        <FieldDescription className="text-xs text-destructive">
          More than the {autoBudget.budget.toLocaleString("en-US")} tokens the{" "}
          {autoBudget.window.toLocaleString("en-US")} token window leaves after the reply, so a full chunk can overflow
          it.
        </FieldDescription>
      )}
    </>
  )

  const capabilities = useLlmCapabilities(modelsProvider)
  const runningKey = apiKeys.data?.keys.find((key) => key.provider === modelsProvider)
  // Each endpoint behind a connection detects on its own, so prefer the one in use.
  const modelCapabilities = (capabilities.data?.capabilities ?? []).filter((item) => item.model === effectiveModel)
  const detected =
    modelCapabilities.find((item) => item.endpoint === (runningKey?.baseUrl ?? null)) ?? modelCapabilities[0]
  // What the scope resolves to, so an override inherited from the global
  // config counts too; unknown (still loading) is no override.
  const capabilityOverride = (
    [
      ["thinkingSupport", "thinking"],
      ["toolSupport", "tools"],
    ] as const
  ).some(([name, key]) => {
    const value = form.choices[name] === INHERIT ? inherited?.llm.capabilities[key] : form.choices[name]
    return String(value ?? "auto") !== "auto"
  })
  // Once an override has opened the section, clearing it leaves it open
  // instead of collapsing it under the cursor. Set during render (React's
  // "adjusting state when a prop changes"), so there is no extra effect pass.
  if (capabilityOverride && !advancedOpen) setAdvancedOpen(true)

  // The preview follows the form, unsaved edits included: the server layers
  // what the form sets over what it inherits. Values the server would reject
  // hold the preview back (the connection is not part of it).
  const blocking = Object.entries(errors).some(([key, message]) => key !== "connection" && message)
  const previewRequest =
    inherited && !blocking
      ? { base: inherited as ConfigOverride, settings: disabled ? {} : toSettings({}, form) }
      : null

  const storedConnections = (apiKeys.data?.keys ?? []).filter((key) => key.stored)
  // Checked live: the picker is where a broken connection should show up.
  const statuses = useApiKeyStatuses(storedConnections.filter(isCheckable))
  const runningAttention = runningKey && attentionLabel(runningKey, statuses[runningKey.provider])
  const selectedProvider = form.connection === INHERIT ? null : (form.connection as LlmProviderName)
  const selectedIsMissing = selectedProvider && !storedConnections.some((key) => key.provider === selectedProvider)
  const connectionOptions = [
    ...storedConnections.map((key) => ({
      value: key.provider,
      label: LLM_PROVIDERS[key.provider].label,
      description: key.baseUrl ?? (key.last4 ? `key ending in ${key.last4}` : "saved connection"),
      icon: LLM_PROVIDERS[key.provider].icon,
      badge: attentionLabel(key, statuses[key.provider]) && (
        <Badge variant="destructive" className="ml-auto">
          {attentionLabel(key, statuses[key.provider])}
        </Badge>
      ),
    })),
    ...(selectedIsMissing
      ? [{
          value: selectedProvider,
          label: `${LLM_PROVIDERS[selectedProvider].label} (not configured)`,
          disabled: true,
        }]
      : []),
  ]

  const severities = (schema.data?.severities ?? []).map((s) => ({ value: s, label: s }))
  const profiles = Object.keys(schema.data?.profiles ?? {}).map((p) => ({ value: p, label: p }))

  // The fallbacks a review would try: the repository file's, the ones typed
  // here, or the inherited ones when none are.
  const typedFallbacks = form.fallbackModels.map((model) => model.trim()).filter(Boolean)
  const effectiveFallbacks =
    (locked("llm.fallbackModels")
      ? config?.llm.fallbackModels
      : typedFallbacks.length
        ? typedFallbacks
        : inherited?.llm.fallbackModels) ?? []
  // The server drops temperature while thinking is on, unless the model cannot
  // think. An invalid value stays editable so the error can be fixed.
  const thinkingOn = effectiveThinking !== undefined && effectiveThinking !== "off" && detected?.thinking !== "none"
  const temperatureOff = thinkingOn && !errors.temperature

  const panels: Record<ConfigTab, ReactNode> = {
    llm: (
      <>
        <Section
          title="Connection and models"
          description="Which saved connection runs the review, the model it runs, the ones tried when it fails, and optional models for the PR summary and verification."
        >
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            <div className="flex flex-col gap-2">
              <ChoiceField
                id="llm-connection"
                label="LLM connection"
                value={form.connection}
                onChange={(connection) => props.onChange({ ...form, connection })}
                options={connectionOptions}
                inherit={
                  isRepo
                    ? { description: inherited && inheritedHint("llm.connection", configuredConnectionLabel(inherited.llm)) }
                    : undefined
                }
                description={
                  <>
                    Uses the latest key and API host configured in{" "}
                    <Link className="underline underline-offset-4" to="/llm-connections">LLM Connections</Link>.
                  </>
                }
                effective={config && effective("llm.connection", configuredConnectionLabel(config.llm))}
                error={errors.connection}
                disabled={locked("llm.connection") || apiKeys.isPending}
              />
              {apiKeys.isSuccess && storedConnections.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No saved connections. Add one in{" "}
                  <Link className="underline underline-offset-4" to="/llm-connections">
                    LLM Connections
                  </Link>
                  .
                </p>
              )}
              {apiKeys.isError && <p className="text-sm text-destructive">Could not load LLM connections.</p>}
              {runningAttention && (
                <p className="text-sm text-destructive">
                  {LLM_PROVIDERS[runningKey.provider].label}: {runningAttention}. Reviews on this connection may fail; check
                  it in{" "}
                  <Link className="underline underline-offset-4" to="/llm-connections">
                    LLM Connections
                  </Link>
                  .
                </p>
              )}
            </div>
            {/* Price, detected capabilities and the test live in the "What will run" panel. */}
            <Field data-disabled={locked("llm.model")}>
              <FieldLabel htmlFor="model">Model</FieldLabel>
              <ModelCombobox
                id="model"
                value={form.model}
                onChange={setField("model")}
                placeholder={inherited?.llm.model ?? config?.llm.model ?? "anthropic/claude-sonnet-5-5"}
                disabled={locked("llm.model")}
                aria-invalid={errors.model ? true : undefined}
                suggestions={modelSuggestions}
              />
              <FieldDescription>
                The model that reviews the change, as provider/model.{" "}
                {emptyHint("llm.model", inherited?.llm.model)}
              </FieldDescription>
              {config && effectiveLine("llm.model", config.llm.model)}
              {!disabled && !runsOn(form.model) && mismatchHint}
              {errors.model && <FieldError>{errors.model}</FieldError>}
            </Field>
          </div>
          <FallbackModelsField
            rows={form.fallbackModels}
            onChange={(fallbackModels) => props.onChange({ ...form, fallbackModels })}
            emptyHint={emptyHint("llm.fallbackModels", inherited?.llm.fallbackModels)}
            effective={config && effective("llm.fallbackModels", config.llm.fallbackModels)}
            error={errors.fallbackModels}
            disabled={locked("llm.fallbackModels")}
            suggestions={modelSuggestions}
            warning={!disabled && !form.fallbackModels.every(runsOn) ? mismatchHint : undefined}
          />
          {/* Always visible: collapsing them could hide an override. */}
          <FieldSet>
            <FieldLegend variant="label">Per-purpose models</FieldLegend>
            <div className="grid gap-4 @md/field-group:grid-cols-2">
              {purposeModelField(
                "walkthroughModel",
                "PR summary model",
                walkthroughKnownOff ? { setting: "PR summary", tab: "display" } : undefined,
              )}
              {purposeModelField(
                "verifyModel",
                "Verification model",
                verifyOn ? undefined : { setting: "Verify findings", tab: "findings" },
              )}
            </div>
          </FieldSet>
        </Section>
        <FieldSeparator />
        <Section title="Model calls" description="How each request to the model is made.">
          {/* Thinking sits beside max output tokens because its budget is added on top. */}
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            {choiceField("thinking")}
            {numberField("maxTokens")}
            {numberField(
              "temperature",
              temperatureOff && (
                <FieldDescription className="text-xs">Thinking is on, so the temperature is not sent.</FieldDescription>
              ),
              temperatureOff,
            )}
            {numberField("contextBudget", budgetHint)}
            {choiceField(
              "verifyThinking",
              !verifyOn,
              <OffHint setting="Verify findings" tab="findings" onTabChange={props.onTabChange} />,
            )}
          </div>
        </Section>
        <FieldSeparator />
        <Section
          title="Connection capabilities"
          description="Detected per model by a probe when a model is tested or first used, and corrected by reviews (shown under What will run). Set these only when detection is wrong."
        >
          {/* Kept open while an override is set, so it is never hidden. */}
          <Collapsible open={advancedOpen || capabilityOverride} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="group -ml-2 w-fit" disabled={capabilityOverride}>
                <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
                Advanced
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="grid gap-4 @md/field-group:grid-cols-2">
                {choiceField("thinkingSupport")}
                {choiceField("toolSupport")}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </Section>
      </>
    ),
    findings: (
      <>
        <Section title="Severity" description="What is reported, and what fails the review and its commit status.">
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            <ChoiceField
              id="severity-floor"
              label="Report findings at or above"
              value={form.severityFloor}
              onChange={setField("severityFloor")}
              options={severities}
              {...choice("review.severityFloor", inherited?.review.severityFloor)}
              effective={config && effective("review.severityFloor", config.review.severityFloor)}
              disabled={locked("review.severityFloor")}
            />
            <ChoiceField
              id="block-on"
              label="Block at or above"
              value={form.blockOn}
              onChange={setField("blockOn")}
              options={severities}
              {...choice("review.blockOn", inherited?.review.blockOn)}
              effective={config && effective("review.blockOn", config.review.blockOn)}
              disabled={locked("review.blockOn")}
            />
          </div>
          <SeverityScale severities={schema.data?.severities ?? []} floor={severityFloorValue} blockOn={blockOnValue} />
        </Section>
        <FieldSeparator />
        <Section
          title="What gets reported"
          description="The kinds of issues the reviewer looks for, and how many it reports."
        >
          <CategoriesField
            options={schema.data?.categories ?? []}
            value={form.categories}
            inherited={inherited?.review.categories}
            onChange={(categories) => props.onChange({ ...form, categories })}
            resettable={isRepo}
            inheritedHint={inheritedHint("review.categories", inherited?.review.categories)}
            effective={config && effective("review.categories", config.review.categories)}
            error={errors.categories}
            disabled={locked("review.categories")}
          />
          <div className="grid gap-4 @md/field-group:grid-cols-2">{numberField("maxFindings")}</div>
        </Section>
        <FieldSeparator />
        <Section title="Accuracy" description="How findings are checked before they count.">
          <ToggleList>{toggles(["requireEvidence"])}</ToggleList>
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            {choiceField("verify")}
            {numberField("minConfidence", confidenceSlider)}
          </div>
          <ToggleList>{toggles(["suppressIgnored"])}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section
          title="Scope and context"
          description="Which lines may be commented on, and how much code each pass reads beyond its diff."
        >
          <ToggleList>{toggles(["fullFile"])}</ToggleList>
          {choiceField("context")}
          <ToggleList>
            {toggles(["fileContext"])}
            {/* Callers are only followed while surrounding code is gathered. */}
            <Nested>{numberField("impactDepth", undefined, fileContextOff)}</Nested>
          </ToggleList>
          <FieldSet data-disabled={agentLimitsOff || undefined}>
            <FieldLegend variant="label">Agent limits</FieldLegend>
            <FieldDescription>Only used when Review context is Agentic.</FieldDescription>
            <div className="grid gap-4 @md/field-group:grid-cols-3">
              {numberField("maxSteps", undefined, agentLimitsOff)}
              {numberField("maxToolTokens", undefined, agentLimitsOff)}
              {numberField("maxSearches", undefined, agentLimitsOff)}
            </div>
          </FieldSet>
        </Section>
        <FieldSeparator />
        <Section title="Static analysis" description="Findings that analyzers on the forge already reported.">
          <ToggleList>
            {toggles(["toolFindings"])}
            <Nested>{toggles(["toolFindingsBlock"], !toolFindingsOn)}</Nested>
          </ToggleList>
        </Section>
        <FieldSeparator />
        <Section title="Fixes" description="How fixes are offered on the change.">
          <ToggleList>{toggles(["committableSuggestions"])}</ToggleList>
        </Section>
      </>
    ),
    files: (
      <>
        <TextField
          id="ignore-paths"
          label="Ignore paths"
          value={form.ignorePaths}
          onChange={setField("ignorePaths")}
          description="Glob patterns for files that are never reviewed, one per line. A list here replaces the inherited one."
          emptyHint={emptyHint("ignorePaths", inherited?.ignorePaths)}
          placeholder={inherited?.ignorePaths.join("\n") || "**/generated/**"}
          multiline
          effective={config && effective("ignorePaths", config.ignorePaths)}
          error={errors.ignorePaths}
          disabled={locked("ignorePaths")}
        />
        {numberField("maxChunks")}
        <ToggleList>{toggles(["disableCache"])}</ToggleList>
      </>
    ),
    display: (
      <>
        <Section
          title="Presets"
          description="Set every switch on this tab at once, then adjust. Minimal posts inline comments only, Standard is the defaults (inline comments, one summary comment and a short PR summary, without the extra lines, labels, diagrams or commit status), Everything turns every option on, labels included. Nothing is saved until you save, and fields the repository file sets are left alone."
        >
          <SegmentedControl
            label="Display preset"
            options={DISPLAY_PRESETS}
            value={activePreset}
            onChange={applyPreset}
            disabled={disabled || !inherited || !schema.data}
          />
        </Section>
        <FieldSeparator />
        <Section
          title="Where to post"
          description="What the review leaves on the change. Options for each comment sit under it."
        >
          <ToggleList>
            {toggles(["postInline"])}
            {/* Only threads Sentryward opened are resolved. */}
            <Nested>
              {toggles(["agentPrompts", "resolveFixedThreads"], !postInlineOn, "Post inline comments")}
              {choiceField("inlineMinSeverity", !postInlineOn, <OffHint setting="Post inline comments" onTabChange={props.onTabChange} />)}
              {numberField("maxInlineComments", undefined, !postInlineOn)}
            </Nested>
            {toggles(["postSummary"], false, undefined, {
              postSummary: standaloneSummary && (
                <FieldDescription className="text-xs">
                  The PR summary is still posted, as a comment of its own, while it is turned on below.
                </FieldDescription>
              ),
            })}
            {/* The counts, lifecycle, details and the combined prompt are part of the summary comment. */}
            <Nested>
              {toggles(
                ["summaryOnlyWithFindings", "findingCounts", "findingLifecycle", "reviewStats", "agentPromptAll"],
                !postSummaryOn,
                "Post summary comment",
              )}
            </Nested>
            {toggles(["postCheck"])}
          </ToggleList>
          {nothingPosted && (
            <Alert role="status">
              <MessageSquareOff />
              <AlertDescription>
                Sentryward will post nothing to the PR/MR. Reviews only show up in the dashboard.
              </AlertDescription>
            </Alert>
          )}
        </Section>
        <FieldSeparator />
        <Section title="PR summary" description="A summary of what the change does, and labels from its estimates.">
          <ToggleList>
            {toggles(["walkthrough"])}
            {/* Grouped by topic: the text in the summary beside its native label. */}
            <Nested>
              <Topic title="Labels">{toggles(["walkthroughLabels"], !walkthroughOn, "PR summary")}</Topic>
              <Topic title="Effort">{toggles(["estimateEffort", "effortLabel"], !walkthroughOn, "PR summary")}</Topic>
              <Topic title="Blast radius">
                {toggles(["walkthroughBlastRadius", "blastRadiusLabel"], !walkthroughOn, "PR summary")}
              </Topic>
            </Nested>
          </ToggleList>
          {/* The estimates are made whenever the PR summary runs (WalkthroughOptions in render/markdown.ts). */}
          <FieldDescription className="text-xs">
            The native labels only need the PR summary, not the matching text: a label is still published with its
            text turned off.
          </FieldDescription>
        </Section>
        <FieldSeparator />
        <Section
          title="PR summary content"
          description="Optional parts of the PR summary. The tag on each says what it adds to the PR summary's model call."
        >
          <ToggleList>
            {toggles(["sequenceDiagrams", "assessLinkedIssues", "relatedIssues"], !walkthroughOn, "PR summary")}
          </ToggleList>
        </Section>
        <FieldSeparator />
        <Section title="High-level summary" description="Release notes for the change, or whatever the instructions ask for.">
          <ToggleList>{toggles(["highLevelSummary"], !walkthroughOn, "PR summary")}</ToggleList>
          {choiceField(
            "highLevelSummaryPlacement",
            !highLevelSummaryOn,
            <OffHint setting="High-level summary" onTabChange={props.onTabChange} />,
          )}
          <TextField
            id="summary-instructions"
            label="High level summary instructions"
            value={form.summaryInstructions}
            onChange={setSummaryInstructions}
            description="By default, Sentryward generates release notes in the description. Use this to customize the summary content and format."
            emptyHint={
              isRepo && inheritedSummaryInstructions
                ? emptyHint("output.highLevelSummaryInstructions", inheritedSummaryInstructions)
                : "Leave empty for release notes."
            }
            placeholder={inheritedSummaryInstructions || SUMMARY_INSTRUCTIONS_EXAMPLE}
            multiline
            effective={
              config &&
              effective("output.highLevelSummaryInstructions", config.output.highLevelSummaryInstructions || "release notes")
            }
            extra={
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">Examples:</span>
                  {SUMMARY_EXAMPLES.map((example) => (
                    <Button
                      key={example.label}
                      type="button"
                      variant="outline"
                      size="xs"
                      aria-label={`Use the ${example.label} example`}
                      onClick={() => pickExample(example)}
                      disabled={summaryFieldOff}
                    >
                      {example.label}
                    </Button>
                  ))}
                  {/* Same count as the validation, which trims. */}
                  <span
                    data-testid="summary-instructions-count"
                    className={cn(
                      "ml-auto text-xs text-muted-foreground tabular-nums",
                      summaryLength > MAX_SUMMARY_INSTRUCTIONS && "text-destructive",
                    )}
                  >
                    {summaryLength} / {MAX_SUMMARY_INSTRUCTIONS}
                  </span>
                </div>
                {pendingExample && !summaryFieldOff && (
                  <div
                    role="group"
                    aria-label="Replace instructions"
                    className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-xs"
                  >
                    <span>Replace your instructions with the {pendingExample.label} example?</span>
                    <div className="ml-auto flex gap-2">
                      <Button type="button" variant="ghost" size="xs" onClick={() => setPendingExample(undefined)}>
                        Keep mine
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        onClick={() => {
                          setSummaryInstructions(pendingExample.text)
                          setPendingExample(undefined)
                        }}
                      >
                        Replace
                      </Button>
                    </div>
                  </div>
                )}
              </>
            }
            error={errors.summaryInstructions}
            disabled={summaryFieldOff}
          />
        </Section>
      </>
    ),
    triggers: (
      <>
        <Section
          title="Automatic reviews"
          description="When Sentryward reviews a pull or merge request on its own."
        >
          {choiceField("review")}
          <ToggleList>
            {toggles(["reviewOnPush"], reviewManual)}
            {/* Only a push that is reviewed at all can be a full review. */}
            <Nested>{toggles(["fullReviewOnPush"], reviewManual || !reviewOnPushOn)}</Nested>
          </ToggleList>
          <ToggleList>{toggles(["abortOnClose"])}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section title="PR summary" description="When automatic reviews also write the PR summary.">
          {choiceField("summary", reviewManual || walkthroughKnownOff, summaryHint)}
        </Section>
        <FieldSeparator />
        <Section title="Commands and replies" description="What people can ask for in comments on the change.">
          <ToggleList>{toggles(["command", "replies"])}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section
          title="Skip rules"
          description={
            reviewManual
              ? "Only used for automatic reviews, which are off."
              : "Automatic reviews skip a PR/MR that matches any rule. Manual reviews and /sentryward review always run."
          }
        >
          <FieldSet>
            <FieldLegend variant="label">Change</FieldLegend>
            <div className="grid gap-x-4 gap-y-5 @md/field-group:grid-cols-2">
              {listField("ignoreTitles", reviewManual)}
              {listField("skipLabels", reviewManual)}
            </div>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">People</FieldLegend>
            <div className="grid gap-x-4 gap-y-5 @md/field-group:grid-cols-2">{listField("skipAuthors", reviewManual)}</div>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">Branches</FieldLegend>
            <div className="grid gap-x-4 gap-y-5 @md/field-group:grid-cols-2">
              {listField("skipSourceBranches", reviewManual)}
              {listField("skipTargetBranches", reviewManual)}
            </div>
          </FieldSet>
        </Section>
      </>
    ),
    guidance: (
      <>
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor="instructions">{props.guidanceLabel ?? "Guidance"}</FieldLabel>
          <Textarea
            id="instructions"
            value={form.instructions}
            onChange={(e) => setField("instructions")(e.target.value)}
            placeholder="Controllers stay thin; business logic lives in services."
            rows={4}
            disabled={disabled}
            aria-invalid={errors.instructions ? true : undefined}
          />
          <FieldDescription>Project conventions passed to the reviewer with every change.</FieldDescription>
          {errors.instructions && <FieldError>{errors.instructions}</FieldError>}
        </Field>
        <LanguageInstructionsField
          rows={form.languageInstructions}
          onChange={(languageInstructions) => props.onChange({ ...form, languageInstructions })}
          isRepo={isRepo}
          effective={config && effective("languageInstructions", config.languageInstructions)}
          error={errors.languageInstructions}
          disabled={locked("languageInstructions")}
        />
        <RulesField
          rows={form.rules}
          onChange={(rules) => props.onChange({ ...form, rules })}
          isRepo={isRepo}
          severities={schema.data?.severities ?? []}
          categories={schema.data?.categories ?? []}
          inherited={inherited?.rules}
          inheritedSources={props.inheritedSources}
          config={config}
          sources={sources}
          patternErrors={props.rulePatternErrors}
          error={errors.rules}
          disabled={disabled}
        />
      </>
    ),
  }

  // A sticky panel beside the settings of a tab, where it has one.
  // The Finding Types fields, for the summary's override and file counts.
  const findingsFlags: FlagName[] = [
    "requireEvidence",
    "suppressIgnored",
    "fullFile",
    "fileContext",
    "committableSuggestions",
    "toolFindings",
    "toolFindingsBlock",
  ]
  const findingsNumbers: NumberName[] = ["maxFindings", "minConfidence", "impactDepth", "maxSteps", "maxToolTokens", "maxSearches"]
  const findingsChoices: ChoiceName[] = ["verify", "context"]
  const findingsPaths = [
    "review.severityFloor",
    "review.blockOn",
    "review.categories",
    ...findingsFlags.map((name) => `${FLAGS.find((flag) => flag.name === name)!.section}.${name}`),
    ...findingsNumbers.map((name) => `${NUMBERS.find((number) => number.name === name)!.section}.${name}`),
    ...findingsChoices.map((name) => {
      const spec = CHOICES.find((choice) => choice.name === name)!
      return `${spec.section}.${choiceKey(spec)}`
    }),
  ]
  // A repository that follows the global config keeps its overrides but does
  // not use them, so they are not counted.
  const findingsOverrides =
    isRepo && !disabled
      ? [form.severityFloor !== INHERIT, form.blockOn !== INHERIT, form.categories !== undefined]
          .concat(findingsFlags.map((name) => form.flags[name] !== undefined))
          .concat(findingsNumbers.map((name) => form.numbers[name].trim() !== ""))
          .concat(findingsChoices.map((name) => form.choices[name] !== INHERIT))
          .filter(Boolean).length
      : undefined
  const findingsFromFile = isRepo ? findingsPaths.filter(fromRepoFile).length : 0
  const choiceLabel = (name: ChoiceName, value: string | undefined) =>
    value === undefined ? undefined : (CHOICE_INFO[name].options.find((option) => option.value === value)?.label ?? value)
  const resolvedCategories = fromRepoFile("review.categories")
    ? config?.review.categories
    : disabled
      ? inherited?.review.categories
      : (form.categories ?? inherited?.review.categories)

  const asides: Partial<Record<ConfigTab, { node: ReactNode; grid: string }>> = {
    triggers: {
      grid: "@6xl:grid-cols-[minmax(0,1fr)_22rem]",
      node: (
        <TriggersSummary
          request={previewRequest}
          review={reviewChoice}
          reviewOnPush={resolvedFlag("reviewOnPush")}
          fullReviewOnPush={resolvedFlag("fullReviewOnPush")}
          summary={resolvedChoice("summary")}
          walkthroughOff={walkthroughKnownOff}
          command={resolvedFlag("command")}
          replies={resolvedFlag("replies")}
          abortOnClose={resolvedFlag("abortOnClose")}
          lists={Object.fromEntries(LISTS.map((name) => [name, resolvedList(name)]))}
          repoFile={isRepo ? props.repoFile : null}
        />
      ),
    },
    findings: {
      grid: "@6xl:grid-cols-[minmax(0,1fr)_22rem]",
      node: (
        <FindingsSummary
          severities={schema.data?.severities ?? []}
          floor={severityFloorValue}
          blockOn={blockOnValue}
          categories={resolvedCategories}
          categoryCount={schema.data?.categories.length ?? 0}
          maxFindings={resolvedNumber("maxFindings")}
          minConfidence={resolvedNumber("minConfidence")}
          verifyLabel={choiceLabel("verify", verifyChoice ?? undefined)}
          context={contextChoice}
          contextLabel={choiceLabel("context", contextChoice)}
          agent={{
            maxSteps: resolvedNumber("maxSteps"),
            maxToolTokens: resolvedNumber("maxToolTokens"),
            maxSearches: resolvedNumber("maxSearches"),
          }}
          fileContext={resolvedFlag("fileContext")}
          impactDepth={resolvedNumber("impactDepth")}
          toolFindings={resolvedFlag("toolFindings")}
          toolFindingsBlock={resolvedFlag("toolFindingsBlock")}
          overrides={findingsOverrides}
          fromFile={findingsFromFile}
          repoFile={props.repoFile}
        />
      ),
    },
    // Wider than the other side panels, since it draws a diff and comments,
    // but the settings keep most of the width. Collapsible per browser.
    display: previewOpen
      ? {
          grid: "@5xl:grid-cols-[minmax(0,3fr)_minmax(24rem,2fr)]",
          node: (
            // Pinned in the two-column layout, scrolling inside when taller than
            // the viewport so its end is reachable without leaving the form.
            <Card
              role="region"
              aria-label="Review preview"
              className="@5xl:sticky @5xl:top-18 @5xl:max-h-[calc(100svh-5.5rem)]"
            >
              <CardHeader>
                <CardTitle>Preview</CardTitle>
                <CardDescription>
                  What Sentryward would post on a sample change with these settings, including unsaved edits.
                </CardDescription>
                <CardAction>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Hide preview"
                    onClick={() => {
                      setPreviewOpen(false)
                      savePreviewOpen(false)
                    }}
                  >
                    <PanelRightClose />
                  </Button>
                </CardAction>
              </CardHeader>
              {/* Focusable so the scroll area can be scrolled from the keyboard. */}
              <CardContent
                role="region"
                aria-label="Preview content"
                tabIndex={0}
                className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50 @5xl:min-h-0 @5xl:overflow-y-auto"
              >
                <ReviewPreview request={previewRequest} focus={previewFocus} />
              </CardContent>
            </Card>
          ),
        }
      : {
          grid: "@5xl:grid-cols-[minmax(0,1fr)_auto]",
          node: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit @5xl:sticky @5xl:top-18"
              onClick={() => {
                setPreviewOpen(true)
                savePreviewOpen(true)
              }}
            >
              <PanelRightOpen />
              Show preview
            </Button>
          ),
        },
    llm: {
      grid: "@6xl:grid-cols-[minmax(0,1fr)_22rem]",
      node: (
        <LlmRunSummary
          provider={modelsProvider}
          attention={runningAttention || undefined}
          model={effectiveModel}
          fallbacks={effectiveFallbacks}
          thinkingLabel={
            effectiveThinking && THINKING_OPTIONS.find((option) => option.value === effectiveThinking)?.label
          }
          autoBudget={autoBudget}
          typedBudget={budgetValue !== undefined && Number.isFinite(budgetValue) ? budgetValue : undefined}
          capability={detected}
          capabilityLoading={capabilities.isPending && Boolean(modelsProvider)}
        />
      ),
    },
  }

  // Above the tabs: a profile fills in values on every one of them.
  const profileField = (
    <ChoiceField
      id="profile"
      label="Profile"
      value={form.profile}
      onChange={setField("profile")}
      options={profiles}
      {...choice("profile", inherited?.profile)}
      description="A preset that fills in values on every tab; anything set here wins over it."
      effective={config && effective("profile", config.profile)}
      disabled={locked("profile")}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      {props.profileSlot === undefined ? (
        <div className="max-w-xs">{profileField}</div>
      ) : (
        props.profileSlot && createPortal(profileField, props.profileSlot)
      )}
      {/* Vertical: a side rail once the page container is wide enough, a row below that. */}
      <Tabs
        orientation="vertical"
        value={props.tab}
        onValueChange={(value) => props.onTabChange(value as ConfigTab)}
      >
        <TabsList className="data-[orientation=vertical]:@3xl:sticky data-[orientation=vertical]:@3xl:top-18">
          {CONFIG_TABS.map((item) => {
            const invalid = TAB_ERRORS[item.value].some((key) => errors[key])
            return (
              <TabsTrigger key={item.value} value={item.value}>
                <item.icon />
                <span>{item.label}</span>
                {invalid && (
                  <>
                    <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                    <span className="sr-only">, has errors</span>
                  </>
                )}
              </TabsTrigger>
            )
          })}
        </TabsList>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {props.notices}
          {CONFIG_TABS.map((item) => {
            // The active rail item already names the tab, so the card only says what it covers.
            // The Card clips its overflow by default, which would make it the
            // sticky save bar's scroll container and keep the bar from pinning
            // to the viewport.
            const card = (
              <Card className="overflow-visible">
                <CardHeader>
                  <CardDescription>{item.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  <FieldGroup className="gap-6">{panels[item.value]}</FieldGroup>
                  {props.footer}
                </CardContent>
              </Card>
            )
            const aside = asides[item.value]
            return (
              <TabsContent key={item.value} value={item.value}>
                {aside ? (
                  <div className={cn("grid items-start gap-4", aside.grid)}>
                    {card}
                    {aside.node}
                  </div>
                ) : (
                  card
                )}
              </TabsContent>
            )
          })}
        </div>
      </Tabs>
    </div>
  )
}
