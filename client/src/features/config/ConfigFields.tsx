import type { ReactNode } from "react"
import { Link } from "react-router"
import { Plus, RotateCcw, Trash2 } from "lucide-react"
import { SearchableSelect } from "@/components/SearchableSelect"
import { TagInput } from "@/components/TagInput"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
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
import { useApiKeys, useLlmModels } from "@/features/llm-connections/api"
import { LLM_PROVIDERS } from "@/features/llm-connections/providers"
import { useConfigSchema, type ConfigOverride, type EffectiveConfig, type LlmProviderName, type Rule } from "./api"
import { ModelCombobox, type ModelSuggestions } from "./ModelCombobox"
import { ReviewPreview } from "./ReviewPreview"
import { CONFIG_TABS, TAB_ERRORS, type ConfigTab } from "./tabs"
import {
  AUTO,
  at,
  CHOICES,
  choiceKey,
  EMPTY_RULE,
  FLAGS,
  INHERIT,
  MAX_FALLBACK_MODELS,
  MAX_RULE_PATTERN,
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

const FLAG_INFO: Record<FlagName, { label: string; description: ReactNode }> = {
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
  walkthrough: {
    label: "Walkthrough",
    description:
      "Summarise what the change does at the top of the review comment. When automatic reviews include it is set on the Triggers tab.",
  },
  postInline: { label: "Post inline comments", description: "Comment on the lines each finding refers to." },
  postSummary: { label: "Post summary comment", description: "Post the review summary as a comment on the change." },
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
    description: "Show the walkthrough's labels in the summary comment. This is text in the comment, not native PR/MR labels.",
  },
  walkthroughBlastRadius: {
    label: "Show blast radius in the summary",
    description:
      "Show the estimated blast radius in the summary comment. The native label is set separately by Publish blast radius label.",
  },
  blastRadiusLabel: {
    label: "Publish blast radius label",
    description:
      'Add a native PR/MR label with the estimated blast radius (e.g. "Large blast radius"). Needs the walkthrough. Supported on GitHub and GitLab.',
  },
  effortLabel: {
    label: "Publish review time estimate label",
    description:
      'Add a native PR/MR label with the estimated review effort (e.g. "10-20 Minutes"). Needs the walkthrough. Supported on GitHub and GitLab.',
  },
  sequenceDiagrams: {
    label: "Sequence diagrams",
    description: "Include sequence diagrams in the walkthrough, drawn with Mermaid.",
  },
  estimateEffort: {
    label: "Estimate code review effort",
    description: "Include an estimated code review effort in the walkthrough.",
  },
  assessLinkedIssues: {
    label: "Assess linked issues",
    description: "Include an assessment of how well the changes address linked issues in the walkthrough.",
  },
  relatedIssues: {
    label: "Related issues",
    description: "Include potentially related issues in the walkthrough.",
  },
  highLevelSummary: {
    label: "High-level summary",
    description: "Generate a high-level summary of the changes in the PR/MR description or walkthrough.",
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
  { label: string; description: string; options: { value: string; label: string }[]; nullLabel?: string }
> = {
  review: {
    label: "Code review trigger",
    description: "Which pull and merge requests are reviewed automatically when opened or marked ready.",
    options: [
      { value: "manual", label: "Manual only" },
      { value: "published", label: "Published PRs" },
      { value: "all", label: "Draft and published PRs" },
    ],
  },
  summary: {
    label: "PR summary trigger",
    description: "When automatic reviews include the PR summary. Requested reviews always do while the walkthrough is on.",
    options: [
      { value: "manual", label: "Manual only" },
      { value: "published", label: "Published PRs" },
    ],
  },
  highLevelSummaryPlacement: {
    label: "Summary placement",
    description: "Where the high-level summary is written.",
    options: [
      { value: "description", label: "PR/MR description" },
      { value: "walkthrough", label: "Walkthrough" },
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
    description:
      "Static shows each pass the diff and the code gathered for it. Agentic also lets the model read files and search code until it reports, within the agent limits below; models that cannot call tools fall back to static.",
    options: [
      { value: "static", label: "Static" },
      { value: "agentic", label: "Agentic" },
    ],
  },
  thinking: {
    label: "Thinking",
    description:
      "Lets review passes reason before answering, at the cost of output tokens. The walkthrough never thinks. Models or endpoints without thinking run without it, with a warning.",
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

const LIST_INFO: Record<ListName, { label: string; description: string; placeholder: string }> = {
  ignoreTitles: {
    label: "Ignore by title",
    description: "Titles containing any of these phrases, ignoring case.",
    placeholder: "WIP",
  },
  skipAuthors: {
    label: "Skip by author",
    description: "Logins of whoever opened or pushed the PR/MR.",
    placeholder: "dependabot[bot]",
  },
  skipLabels: {
    label: "Skip by label",
    description: "Labels on the PR/MR, matched exactly and case-sensitively.",
    placeholder: "no-review",
  },
  skipSourceBranches: {
    label: "Skip by source branch",
    description: "Opened from a branch whose name contains any of these.",
    placeholder: "release/",
  },
  skipTargetBranches: {
    label: "Skip by target branch",
    description: "Targeting a branch whose name contains any of these.",
    placeholder: "legacy",
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

const NUMBER_INFO: Record<NumberName, { label: string; description: string }> = {
  temperature: { label: "Temperature", description: "Lower is more deterministic." },
  maxTokens: { label: "Max output tokens", description: "Per model call." },
  contextBudget: {
    label: "Context budget",
    description: `Prompt token ceiling per chunk; "${AUTO}" derives it from the model's context window.`,
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
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
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
        {props.description} {props.emptyHint}
      </FieldDescription>
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      {props.error && <FieldError>{props.error}</FieldError>}
    </Field>
  )
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
      <div className="flex items-center gap-2">
        <FieldLegend variant="label">Categories</FieldLegend>
        {overridden && <Badge variant="secondary">Overridden</Badge>}
        {overridden && (
          <ResetButton
            label="Categories"
            hint={props.inheritedHint}
            onClick={() => props.onChange(undefined)}
            disabled={props.disabled}
          />
        )}
      </div>
      <FieldDescription>What kinds of issues the reviewer looks for.</FieldDescription>
      <div className="grid grid-cols-2 gap-2 @md/field-group:grid-cols-3">
        {props.options.map((category) => {
          const id = `category-${category}`
          // A label wrapping a field renders as a selectable card (see FieldLabel).
          return (
            <FieldLabel key={category} htmlFor={id}>
              <Field orientation="horizontal" data-disabled={disabled}>
                <Checkbox
                  id={id}
                  checked={checked?.includes(category) ?? false}
                  onCheckedChange={(on) => toggle(category, on === true)}
                  disabled={disabled}
                />
                <FieldContent>
                  <FieldTitle className="capitalize">{category}</FieldTitle>
                </FieldContent>
              </Field>
            </FieldLabel>
          )
        })}
      </div>
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
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
  return (
    <FieldSet data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLegend variant="label">Fallback models</FieldLegend>
      {rows.map((model, index) => (
        <div key={index} className="flex items-center gap-2">
          <ModelCombobox
            aria-label={`Fallback model ${index + 1}`}
            value={model}
            onChange={(value) => props.onChange(rows.map((row, i) => (i === index ? value : row)))}
            placeholder="openai/gpt-5"
            disabled={props.disabled}
            aria-invalid={props.error ? true : undefined}
            suggestions={props.suggestions}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove fallback model ${index + 1}`}
            onClick={() => props.onChange(rows.filter((_, i) => i !== index))}
            disabled={props.disabled}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => props.onChange([...rows, ""])}
          disabled={props.disabled || rows.length >= MAX_FALLBACK_MODELS}
        >
          <Plus />
          Add fallback model
        </Button>
      </div>
      <FieldDescription>
        Tried in order when the model fails, up to {MAX_FALLBACK_MODELS}. {props.emptyHint}
      </FieldDescription>
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      {props.warning}
      {props.error && <FieldError>{props.error}</FieldError>}
    </FieldSet>
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
  error?: string
  disabled?: boolean
}) {
  const { inherit } = props
  const value = !inherit && props.value === INHERIT ? (props.fallback ?? INHERIT) : props.value
  return (
    <Field data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
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
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
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
}) {
  const { label, description } = FLAG_INFO[props.name]
  const id = `flag-${props.name}`
  const overridden = props.resettable && props.value !== undefined
  // Without an override or a resolved value there is nothing truthful to show yet.
  const disabled = props.disabled || (!overridden && props.inherited === undefined)

  return (
    <Field orientation="horizontal" data-disabled={disabled}>
      <FieldContent>
        <div className="flex items-center gap-2">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          {overridden && <Badge variant="secondary">Overridden</Badge>}
        </div>
        <FieldDescription>{description}</FieldDescription>
        {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
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
        />
      </div>
    </Field>
  )
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
  const setFlag = (name: FlagName) => (value: boolean | undefined) =>
    props.onChange({ ...form, flags: { ...form.flags, [name]: value } })
  const setNumber = (name: NumberName) => (value: string) =>
    props.onChange({ ...form, numbers: { ...form.numbers, [name]: value } })

  function effective(path: string, value: unknown) {
    if (!config) return undefined
    const source = sources?.[path]
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span>Effective: {describe(value, undefined)}</span>
        {source && <SourceBadge source={source} profile={config.profile} repoFile={props.repoFile} />}
      </span>
    )
  }

  // A field the repository file sets cannot be changed from here: the file
  // wins, so an override saved here would do nothing.
  function locked(path: string) {
    return disabled || (isRepo && sources?.[path] === "repoFile")
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

  // `off` greys out settings that do nothing right now, e.g. labels without a summary.
  function toggles(names: FlagName[], off = false) {
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
  function purposeModelField(name: "walkthroughModel" | "verifyModel", label: string) {
    const path = `llm.${name}`
    const shown = (llm: EffectiveConfig["llm"]) => llm[name] ?? `same as model (${llm.model})`
    return (
      <Field data-disabled={locked(path)}>
        <FieldLabel htmlFor={name}>{label}</FieldLabel>
        <ModelCombobox
          id={name}
          aria-label={label}
          value={form[name]}
          onChange={setField(name)}
          placeholder={inherited ? shown(inherited.llm) : config ? shown(config.llm) : "Same as model"}
          disabled={locked(path)}
          aria-invalid={errors[name] ? true : undefined}
          suggestions={modelSuggestions}
        />
        <FieldDescription>{emptyHint(path, inherited && shown(inherited.llm))}</FieldDescription>
        {config && <FieldDescription className="text-xs">{effective(path, shown(config.llm))}</FieldDescription>}
        {!disabled && !runsOn(form[name]) && mismatchHint}
        {errors[name] && <FieldError>{errors[name]}</FieldError>}
      </Field>
    )
  }

  function choiceField(name: ChoiceName, off = false) {
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
        onChange={(value) => props.onChange({ ...form, choices: { ...form.choices, [name]: value } })}
        options={info.options}
        // The global config selects the fallback itself, so it stays the raw value.
        {...(isRepo
          ? { inherit: { description: inheritedHint(path, fallback === undefined ? undefined : label(fallback)) } }
          : { fallback: fallback ?? undefined })}
        description={info.description}
        effective={config && effective(path, label(at(config, path)))}
        disabled={locked(path) || off}
      />
    )
  }

  function listField(name: ListName) {
    const path = `triggers.${name}`
    const fallback = inherited?.triggers[name]
    const info = LIST_INFO[name]
    const id = `list-${name}`
    const error = errors[name]
    // Only worth a hint when leaving it empty actually inherits something.
    const hint = isRepo && fallback?.length ? ` ${emptyHint(path, fallback)}` : ""
    return (
      <Field data-disabled={locked(path)} data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={id}>{info.label}</FieldLabel>
        <TagInput
          id={id}
          value={form.lists[name]}
          onChange={(value) => props.onChange({ ...form, lists: { ...form.lists, [name]: value } })}
          placeholder={fallback?.length ? fallback.join(", ") : `e.g. ${info.placeholder}, then Enter`}
          disabled={locked(path)}
          aria-invalid={error ? true : undefined}
        />
        <FieldDescription>
          {info.description}
          {hint}
        </FieldDescription>
        {config && <FieldDescription className="text-xs">{effective(path, config.triggers[name])}</FieldDescription>}
        {error && <FieldError>{error}</FieldError>}
      </Field>
    )
  }

  function numberField(name: NumberName) {
    const spec = NUMBERS.find((number) => number.name === name)!
    const path = `${spec.section}.${name}`
    const fallback = inherited ? (at(inherited, path) as number | null) : undefined
    const { label, description } = NUMBER_INFO[name]
    return (
      <TextField
        id={`number-${name}`}
        label={label}
        value={form.numbers[name]}
        onChange={setNumber(name)}
        description={description}
        emptyHint={emptyHint(path, fallback)}
        placeholder={fallback === undefined ? undefined : fallback === null ? AUTO : String(fallback)}
        // The context budget also takes "auto", which a number input would reject.
        type={spec.nullable ? "text" : "number"}
        inputMode={spec.integer ? "numeric" : "decimal"}
        min={spec.nullable ? undefined : spec.min}
        max={spec.nullable ? undefined : spec.max}
        step={spec.nullable ? undefined : spec.step}
        effective={config && effective(path, at(config, path))}
        error={errors[name]}
        disabled={locked(path)}
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

  // The preview follows the form, unsaved edits included: the server layers
  // what the form sets over what it inherits. Values the server would reject
  // hold the preview back (the connection is not part of it).
  const blocking = Object.entries(errors).some(([key, message]) => key !== "connection" && message)
  const previewRequest =
    inherited && !blocking
      ? { base: inherited as ConfigOverride, settings: disabled ? {} : toSettings({}, form) }
      : null

  const storedConnections = (apiKeys.data?.keys ?? []).filter((key) => key.stored)
  const selectedProvider = form.connection === INHERIT ? null : (form.connection as LlmProviderName)
  const selectedIsMissing = selectedProvider && !storedConnections.some((key) => key.provider === selectedProvider)
  const connectionOptions = [
    ...storedConnections.map((key) => ({
      value: key.provider,
      label: LLM_PROVIDERS[key.provider].label,
      description: key.baseUrl ?? (key.last4 ? `key ending in ${key.last4}` : "saved connection"),
      icon: LLM_PROVIDERS[key.provider].icon,
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

  const panels: Record<ConfigTab, ReactNode> = {
    llm: (
      <>
        <Section title="Connection" description="Which preset applies and which saved connection runs the review.">
          <div className="grid gap-4 @md/field-group:grid-cols-2">
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
            </div>
          </div>
        </Section>
        <FieldSeparator />
        <Section
          title="Models"
          description="The model that reviews the change, the ones tried when it fails, and optional models for the walkthrough and verification."
        >
          <div className="grid gap-4 @md/field-group:grid-cols-2">
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
                provider/model;{" "}
                {isRepo
                  ? `leave empty to inherit${inherited ? ` ${inheritedHint("llm.model", inherited.llm.model)}` : ""}.`
                  : `leave empty to use the default${inherited ? ` (${inherited.llm.model})` : ""}.`}
              </FieldDescription>
              {config && <FieldDescription className="text-xs">{effective("llm.model", config.llm.model)}</FieldDescription>}
              {!disabled && !runsOn(form.model) && mismatchHint}
              {errors.model && <FieldError>{errors.model}</FieldError>}
            </Field>
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
            {purposeModelField("walkthroughModel", "Walkthrough model")}
            {purposeModelField("verifyModel", "Verification model")}
          </div>
        </Section>
        <FieldSeparator />
        <Section title="Model calls" description="How each request to the model is made.">
          <div className="grid gap-4 @md/field-group:grid-cols-3">
            {numberField("temperature")}
            {numberField("maxTokens")}
            {numberField("contextBudget")}
          </div>
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            {choiceField("thinking")}
            {choiceField("verifyThinking")}
          </div>
        </Section>
        <FieldSeparator />
        <Section
          title="Connection capabilities"
          description="Detected per model by a probe when a model is tested or first used, and corrected by reviews. Set these only when detection is wrong."
        >
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            {choiceField("thinkingSupport")}
            {choiceField("toolSupport")}
          </div>
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
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            {numberField("maxFindings")}
            {numberField("minConfidence")}
          </div>
        </Section>
        <FieldSeparator />
        <Section title="Review rules" description="How findings are checked and how fixes are offered.">
          <ToggleList>
            {toggles(["requireEvidence", "suppressIgnored", "fullFile", "fileContext", "committableSuggestions"])}
          </ToggleList>
          {choiceField("verify")}
          <ToggleList>{toggles(["toolFindings"])}</ToggleList>
          <ToggleList>{toggles(["toolFindingsBlock"], !toolFindingsOn)}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section title="Review context" description="How much code each pass may read beyond its diff.">
          {choiceField("context")}
          {numberField("impactDepth")}
          <div className="grid gap-4 @md/field-group:grid-cols-3">
            {numberField("maxSteps")}
            {numberField("maxToolTokens")}
            {numberField("maxSearches")}
          </div>
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
        <Section title="Review comments" description="What the review leaves on the change.">
          <ToggleList>{toggles(["postInline", "postSummary", "postCheck"])}</ToggleList>
          {/* The counts, lifecycle and details are part of the summary comment. */}
          <ToggleList>{toggles(["findingCounts", "findingLifecycle", "reviewStats"], !postSummaryOn)}</ToggleList>
          {/* Each prompt lives in the comment it belongs to. */}
          <ToggleList>{toggles(["agentPrompts"], !postInlineOn)}</ToggleList>
          <ToggleList>{toggles(["agentPromptAll"], !postSummaryOn)}</ToggleList>
          {/* Only threads Sentryward opened are resolved. */}
          <ToggleList>{toggles(["resolveFixedThreads"], !postInlineOn)}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section title="PR summary" description="A summary of what the change does, and labels from its estimates.">
          <ToggleList>{toggles(["walkthrough"])}</ToggleList>
          {/* Text in the walkthrough itself, unlike the native labels below. */}
          <ToggleList>{toggles(["walkthroughLabels", "walkthroughBlastRadius"], !walkthroughOn)}</ToggleList>
          {/* Labels come from the summary's estimates, so they need one. */}
          <ToggleList>{toggles(["blastRadiusLabel", "effortLabel"], !walkthroughOn)}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section
          title="Walkthrough content"
          description="Optional parts of the PR summary. Each one asks the model for more."
        >
          <ToggleList>
            {toggles(["estimateEffort", "sequenceDiagrams", "assessLinkedIssues", "relatedIssues"], !walkthroughOn)}
          </ToggleList>
        </Section>
        <FieldSeparator />
        <Section title="High-level summary" description="Release notes for the change, or whatever the instructions ask for.">
          <ToggleList>{toggles(["highLevelSummary"], !walkthroughOn)}</ToggleList>
          {choiceField("highLevelSummaryPlacement", !highLevelSummaryOn)}
          <TextField
            id="summary-instructions"
            label="High level summary instructions"
            value={form.summaryInstructions}
            onChange={(summaryInstructions) => props.onChange({ ...form, summaryInstructions })}
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
            error={errors.summaryInstructions}
            disabled={locked("output.highLevelSummaryInstructions") || !highLevelSummaryOn}
          />
        </Section>
      </>
    ),
    triggers: (
      <>
        <Section
          title="Code reviews"
          description="When Sentryward reviews a pull or merge request, and writes its summary, on its own."
        >
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            {choiceField("review")}
            {choiceField("summary")}
          </div>
          <ToggleList>{toggles(["reviewOnPush"])}</ToggleList>
          <ToggleList>{toggles(["fullReviewOnPush"], !reviewOnPushOn)}</ToggleList>
          <ToggleList>{toggles(["command", "replies", "abortOnClose"])}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section
          title="Skip rules"
          description="Automatic reviews skip a PR/MR that matches any rule. Manual reviews and /sentryward review always run."
        >
          <div className="grid gap-x-4 gap-y-5 @md/field-group:grid-cols-2">
            {listField("ignoreTitles")}
            {listField("skipAuthors")}
            {listField("skipSourceBranches")}
            {listField("skipTargetBranches")}
            {listField("skipLabels")}
          </div>
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

  return (
    <Tabs value={props.tab} onValueChange={(value) => props.onTabChange(value as ConfigTab)}>
      <TabsList>
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
      {props.notices}
      {CONFIG_TABS.map((item) => {
        const card = (
          <Card>
            <CardHeader>
              <CardTitle>{item.label}</CardTitle>
              <CardDescription>{item.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <FieldGroup className="gap-6">{panels[item.value]}</FieldGroup>
              {props.footer}
            </CardContent>
          </Card>
        )
        return (
          <TabsContent key={item.value} value={item.value}>
            {item.value === "display" ? (
              <div className="grid items-start gap-4 @3xl:grid-cols-2">
                {card}
                <Card role="region" aria-label="Review preview" className="@3xl:sticky @3xl:top-4">
                  <CardHeader>
                    <CardTitle>Preview</CardTitle>
                    <CardDescription>
                      What Sentryward would post on a sample change with these settings, including unsaved edits.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ReviewPreview request={previewRequest} />
                  </CardContent>
                </Card>
              </div>
            ) : (
              card
            )}
          </TabsContent>
        )
      })}
    </Tabs>
  )
}
