import type { ConfigOverride, ConfigSchema, EffectiveConfig, Rule } from "./api"

export const INHERIT = "__inherit"

// Every boolean the form edits, keyed by where it lives in a config.
export const FLAGS = [
  { name: "requireEvidence", section: "review" },
  { name: "checkClaims", section: "review" },
  { name: "suppressIgnored", section: "review" },
  { name: "fullFile", section: "review" },
  { name: "committableSuggestions", section: "review" },
  { name: "disableCache", section: "review" },
  { name: "fileContext", section: "review" },
  { name: "toolFindings", section: "review" },
  { name: "toolFindingsBlock", section: "review" },
  { name: "walkthrough", section: "output" },
  { name: "postInline", section: "output" },
  { name: "postSummary", section: "output" },
  { name: "summaryOnlyWithFindings", section: "output" },
  { name: "postCheck", section: "output" },
  { name: "resolveFixedThreads", section: "output" },
  { name: "findingCounts", section: "output" },
  { name: "findingLifecycle", section: "output" },
  { name: "reviewStats", section: "output" },
  { name: "agentPrompts", section: "output" },
  { name: "agentPromptAll", section: "output" },
  { name: "blastRadiusLabel", section: "output" },
  { name: "effortLabel", section: "output" },
  { name: "sequenceDiagrams", section: "output" },
  { name: "estimateEffort", section: "output" },
  { name: "assessLinkedIssues", section: "output" },
  { name: "relatedIssues", section: "output" },
  { name: "highLevelSummary", section: "output" },
  { name: "walkthroughLabels", section: "output" },
  { name: "walkthroughBlastRadius", section: "output" },
  { name: "reviewOnPush", section: "triggers" },
  { name: "fullReviewOnPush", section: "triggers" },
  { name: "command", section: "triggers" },
  { name: "replies", section: "triggers" },
  { name: "abortOnClose", section: "triggers" },
] as const

export type FlagName = (typeof FLAGS)[number]["name"]
export type FlagSection = (typeof FLAGS)[number]["section"]

// Every select the form edits besides the profile, connection and severities.
// A section may be a dotted path into a nested object. `boolean` selects store
// true and false as booleans and any other option as its string.
export const CHOICES = [
  { name: "review", section: "triggers" },
  { name: "summary", section: "triggers" },
  { name: "highLevelSummaryPlacement", section: "output" },
  { name: "inlineMinSeverity", section: "output" },
  { name: "verify", section: "review" },
  { name: "context", section: "review" },
  { name: "thinking", section: "llm" },
  { name: "verifyThinking", section: "llm" },
  { name: "thinkingSupport", key: "thinking", section: "llm.capabilities" },
  { name: "toolSupport", key: "tools", section: "llm.capabilities", boolean: true },
] as const satisfies readonly { name: string; key?: string; section: string; boolean?: boolean }[]

export type ChoiceName = (typeof CHOICES)[number]["name"]

// The key a choice is saved under, which only differs where two sections
// share a name (llm.thinking and llm.capabilities.thinking).
export const choiceKey = (choice: (typeof CHOICES)[number]) => ("key" in choice ? choice.key : choice.name)

// The value at a dotted path, e.g. "review.agent".
export function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Section | undefined)?.[key], value)
}

// The skip lists, edited as tags.
export const LISTS = ["ignoreTitles", "skipAuthors", "skipLabels", "skipSourceBranches", "skipTargetBranches"] as const
export type ListName = (typeof LISTS)[number]
// Mirror server/src/review/config/schema.ts.
const MAX_LIST_ENTRIES = 50
const MAX_LIST_ENTRY = 200

export type NumberName =
  | "temperature"
  | "maxTokens"
  | "contextBudget"
  | "maxFindings"
  | "maxChunks"
  | "impactDepth"
  | "minConfidence"
  | "maxSteps"
  | "maxToolTokens"
  | "maxSearches"
  | "maxInlineComments"

export interface NumberSpec {
  name: NumberName
  section: "llm" | "review" | "review.agent" | "output"
  min: number
  max?: number
  step: number
  integer: boolean
  // The word typed for a saved null (AUTO for the context budget); absent
  // when null is not allowed.
  nullable?: string
}

// Typed into the context budget to derive it from the model's context window.
export const AUTO = "auto"

// Bounds mirror server/src/review/config/schema.ts so a bad value is caught
// before the server rejects the whole save.
export const NUMBERS: NumberSpec[] = [
  { name: "temperature", section: "llm", min: 0, max: 1, step: 0.1, integer: false },
  { name: "maxTokens", section: "llm", min: 1000, max: 64000, step: 1000, integer: true },
  { name: "contextBudget", section: "llm", min: 4000, step: 1000, integer: true, nullable: AUTO },
  { name: "maxFindings", section: "review", min: 1, max: 100, step: 1, integer: true },
  { name: "maxChunks", section: "review", min: 1, max: 50, step: 1, integer: true },
  { name: "impactDepth", section: "review", min: 1, max: 3, step: 1, integer: true },
  { name: "minConfidence", section: "review", min: 0, max: 1, step: 0.05, integer: false },
  { name: "maxSteps", section: "review.agent", min: 2, max: 20, step: 1, integer: true },
  { name: "maxToolTokens", section: "review.agent", min: 1000, max: 100000, step: 1000, integer: true },
  { name: "maxSearches", section: "review.agent", min: 0, max: 10, step: 1, integer: true },
  // null posts every inline comment.
  { name: "maxInlineComments", section: "output", min: 1, max: 100, step: 1, integer: true, nullable: "none" },
]

// Router ids such as "openai/cx/gpt-5.6-sol(medium)" keep slashes and
// parentheses in the model part.
export const MODEL_PATTERN = /^(anthropic|openai|google|ollama)\/[\w.:()/-]+$/
export const MAX_FALLBACK_MODELS = 3
const MAX_IGNORE_PATHS = 200
const MAX_INSTRUCTIONS = 4000
const MAX_LANGUAGE_INSTRUCTIONS = 2000
export const MAX_SUMMARY_INSTRUCTIONS = 2000

export interface LanguageRow {
  language: string
  text: string
}

// One team rule as the form edits it: every field a string, "" for unset.
export interface RuleRow {
  id: string
  description: string
  severity: string
  category: string
  // One glob per line.
  paths: string
  pattern: string
  good: string
  bad: string
}

export type RuleField = keyof RuleRow

export const EMPTY_RULE: RuleRow = {
  id: "",
  description: "",
  severity: "",
  category: "",
  paths: "",
  pattern: "",
  good: "",
  bad: "",
}

// Mirror ruleSchema in server/src/review/config/schema.ts.
export const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/
export const MAX_RULES = 50
const MAX_RULE_DESCRIPTION = 1000
const MAX_RULE_PATHS = 50
export const MAX_RULE_PATTERN = 300
const MAX_RULE_EXAMPLE = 2000
const MAX_RULES_CHARS = 16_000

export interface FormState {
  profile: string
  model: string
  // One model per row, in order; blank rows are not saved and no rows inherits.
  fallbackModels: string[]
  // "" inherits, which ends at llm.model.
  walkthroughModel: string
  verifyModel: string
  // INHERIT in a repository, otherwise a saved provider connection.
  connection: string
  severityFloor: string
  blockOn: string
  // undefined inherits.
  categories: string[] | undefined
  // "" inherits.
  numbers: Record<NumberName, string>
  // One glob per line; empty inherits. Not split on commas: globs use them in braces.
  ignorePaths: string
  instructions: string
  // output.highLevelSummaryInstructions; "" inherits.
  summaryInstructions: string
  // Rows missing a language or text are not saved.
  languageInstructions: LanguageRow[]
  // This layer's own rules, added to the inherited ones. Blank rows are not saved.
  rules: RuleRow[]
  // undefined inherits the value from the layers below.
  flags: Record<FlagName, boolean | undefined>
  // INHERIT inherits.
  choices: Record<ChoiceName, string>
  // Empty inherits.
  lists: Record<ListName, string[]>
}

export type FormErrors = Partial<
  Record<
    | NumberName
    | ListName
    | "model"
    | "fallbackModels"
    | "walkthroughModel"
    | "verifyModel"
    | "connection"
    | "categories"
    | "ignorePaths"
    | "instructions"
    | "summaryInstructions"
    | "languageInstructions"
    | "rules",
    string
  >
>

type Section = Record<string, unknown>

function lines(text: string, separators: RegExp) {
  return text
    .split(separators)
    .map((line) => line.trim())
    .filter(Boolean)
}

const modelList = (rows: string[]) => rows.map((model) => model.trim()).filter(Boolean)
const pathList = (text: string) => lines(text, /\n/)
const tagList = (tags: string[]) => tags.map((tag) => tag.trim()).filter(Boolean)

// Settings saved before `triggers.review` existed say the same thing through
// the legacy keys; server/src/review/config/resolve.ts maps them the same way.
function legacyReview(triggers: ConfigOverride["triggers"]): string | undefined {
  if (triggers?.review) return triggers.review
  if (triggers?.onPush === false) return "manual"
  if (triggers?.drafts === true) return "all"
  return undefined
}

function parseNumber(spec: NumberSpec, text: string): number | null | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (spec.nullable && trimmed.toLowerCase() === spec.nullable) return null
  return Number(trimmed)
}

const isBlankRule = (row: RuleRow) => Object.values(row).every((value) => !value.trim())

function toRuleRow(rule: Rule): RuleRow {
  return {
    id: rule.id,
    description: rule.description,
    severity: rule.severity,
    category: rule.category ?? "",
    paths: (rule.paths ?? []).join("\n"),
    pattern: rule.pattern ?? "",
    good: rule.good ?? "",
    bad: rule.bad ?? "",
  }
}

// Optional fields are left out when empty, as a hand-written file would.
// Examples keep their indentation: they are code. A rule with a pattern is
// never shown to the model, so its examples (hidden in the editor) are not kept.
function toRule(row: RuleRow): Rule {
  const paths = pathList(row.paths)
  const rule: Rule = { id: row.id.trim(), description: row.description.trim(), severity: row.severity }
  if (row.category) rule.category = row.category
  if (paths.length) rule.paths = paths
  if (row.pattern) rule.pattern = row.pattern
  if (!row.pattern && row.good.trim()) rule.good = row.good
  if (!row.pattern && row.bad.trim()) rule.bad = row.bad
  return rule
}

function languageMap(rows: LanguageRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const language = row.language.trim()
    const text = row.text.trim()
    if (language && text) out[language] = text
  }
  return out
}

export function toForm(settings: ConfigOverride): FormState {
  const flags = {} as FormState["flags"]
  for (const { name, section } of FLAGS) {
    const value = (settings[section] as Section | undefined)?.[name]
    flags[name] = typeof value === "boolean" ? value : undefined
  }
  const numbers = {} as FormState["numbers"]
  for (const { name, section, nullable } of NUMBERS) {
    const value = (at(settings, section) as Section | undefined)?.[name]
    numbers[name] = value === null ? (nullable ?? "") : typeof value === "number" ? String(value) : ""
  }
  const choices = {} as FormState["choices"]
  for (const choice of CHOICES) {
    const value =
      choice.name === "review" ? legacyReview(settings.triggers) : (at(settings, choice.section) as Section | undefined)?.[choiceKey(choice)]
    choices[choice.name] = typeof value === "string" || typeof value === "boolean" ? String(value) : INHERIT
  }
  const lists = {} as FormState["lists"]
  for (const name of LISTS) lists[name] = [...(settings.triggers?.[name] ?? [])]
  return {
    profile: settings.profile ?? INHERIT,
    model: settings.llm?.model ?? "",
    fallbackModels: [...(settings.llm?.fallbackModels ?? [])],
    walkthroughModel: settings.llm?.walkthroughModel ?? "",
    verifyModel: settings.llm?.verifyModel ?? "",
    // endpointKey is the provider reference used by the legacy two-field UI.
    // Reading it here converts that configuration on the next save.
    connection: settings.llm?.connection ?? settings.llm?.endpointKey ?? INHERIT,
    severityFloor: settings.review?.severityFloor ?? INHERIT,
    blockOn: settings.review?.blockOn ?? INHERIT,
    categories: settings.review?.categories,
    numbers,
    choices,
    lists,
    ignorePaths: (settings.ignorePaths ?? []).join("\n"),
    instructions: settings.instructions ?? "",
    summaryInstructions: settings.output?.highLevelSummaryInstructions ?? "",
    languageInstructions: Object.entries(settings.languageInstructions ?? {}).map(([language, text]) => ({
      language,
      text,
    })),
    rules: (settings.rules ?? []).map(toRuleRow),
    flags,
  }
}

function setOrDelete(section: Section, key: string, value: unknown) {
  if (value === undefined) delete section[key]
  else section[key] = value
}

// Starts from what is saved so keys this form does not show (set through the
// API or a later version) survive a save; "inherit" removes a key.
export function toSettings(base: ConfigOverride, form: FormState): ConfigOverride {
  const next: ConfigOverride = structuredClone(base)
  const pick = (value: string) => (value === INHERIT ? undefined : value)

  setOrDelete(next, "profile", pick(form.profile))
  setOrDelete(next, "instructions", form.instructions.trim() || undefined)
  const ignorePaths = pathList(form.ignorePaths)
  setOrDelete(next, "ignorePaths", ignorePaths.length ? ignorePaths : undefined)
  const languages = languageMap(form.languageInstructions)
  setOrDelete(next, "languageInstructions", Object.keys(languages).length ? languages : undefined)
  const rules = form.rules.filter((row) => !isBlankRule(row)).map(toRule)
  setOrDelete(next, "rules", rules.length ? rules : undefined)

  const fallbackModels = modelList(form.fallbackModels)
  const fields: Record<string, [string, unknown][]> = {
    llm: [
      ["model", form.model.trim() || undefined],
      ["fallbackModels", fallbackModels.length ? fallbackModels : undefined],
      ["walkthroughModel", form.walkthroughModel.trim() || undefined],
      ["verifyModel", form.verifyModel.trim() || undefined],
      ["connection", pick(form.connection)],
      // New dashboard writes replace the old copied endpoint values.
      ["baseUrl", undefined],
      ["endpointKey", undefined],
    ],
    review: [
      ["severityFloor", pick(form.severityFloor)],
      ["blockOn", pick(form.blockOn)],
      ["categories", form.categories],
    ],
    output: [["highLevelSummaryInstructions", form.summaryInstructions.trim() || undefined]],
    triggers: [
      // Replaced by `review`, which the form reads them into.
      ["onPush", undefined],
      ["drafts", undefined],
    ],
  }
  for (const { name, section } of FLAGS) fields[section].push([name, form.flags[name]])
  for (const choice of CHOICES) {
    const value = pick(form.choices[choice.name])
    const saved = "boolean" in choice && (value === "true" || value === "false") ? value === "true" : value
    ;(fields[choice.section] ??= []).push([choiceKey(choice), saved])
  }
  for (const name of LISTS) {
    const entries = tagList(form.lists[name])
    fields.triggers.push([name, entries.length ? entries : undefined])
  }
  for (const spec of NUMBERS) {
    ;(fields[spec.section] ??= []).push([spec.name, parseNumber(spec, form.numbers[spec.name])])
  }

  // Nested sections first, so their parent is written with them in place and
  // an emptied one disappears from it.
  const depth = (path: string) => path.split(".").length
  for (const [path, entries] of Object.entries(fields).sort(([a], [b]) => depth(b) - depth(a))) {
    const keys = path.split(".")
    const last = keys.pop()!
    const parent = keys.reduce<Section>((node, key) => (node[key] ??= {}) as Section, next as Section)
    const section: Section = { ...((parent[last] as Section | undefined) ?? {}) }
    for (const [key, value] of entries) setOrDelete(section, key, value)
    setOrDelete(parent, last, Object.keys(section).length ? section : undefined)
  }
  return next
}

// Each rule row's problems, by field. Pattern errors come from the server's
// RE2 check (`patternErrors`, keyed by pattern); a pattern it has not answered
// for yet is not held against the row, and the save still validates it.
export function ruleRowErrors(
  rows: RuleRow[],
  patternErrors: Record<string, string | null> = {},
): Partial<Record<RuleField, string>>[] {
  const ids = rows.map((row) => row.id.trim())
  return rows.map((row, index) => {
    const errors: Partial<Record<RuleField, string>> = {}
    if (isBlankRule(row)) return errors
    const id = ids[index]
    if (!id) errors.id = "Enter an id"
    else if (!RULE_ID_PATTERN.test(id))
      errors.id = "Use lowercase letters, digits, dots, dashes and underscores, e.g. no-db-in-controllers"
    else if (ids.indexOf(id) !== index) errors.id = `Duplicate rule id ${id}`
    const description = row.description.trim()
    if (!description) errors.description = "Describe what the rule requires"
    else if (description.length > MAX_RULE_DESCRIPTION) errors.description = `At most ${MAX_RULE_DESCRIPTION} characters`
    if (!row.severity) errors.severity = "Choose a severity"
    if (pathList(row.paths).length > MAX_RULE_PATHS) errors.paths = `At most ${MAX_RULE_PATHS} paths`
    if (row.pattern.length > MAX_RULE_PATTERN) errors.pattern = `At most ${MAX_RULE_PATTERN} characters`
    else if (row.pattern && patternErrors[row.pattern]) errors.pattern = patternErrors[row.pattern]!
    for (const field of ["good", "bad"] as const) {
      if (!row.pattern && row[field].length > MAX_RULE_EXAMPLE) errors[field] = `At most ${MAX_RULE_EXAMPLE} characters`
    }
    return errors
  })
}

// What the server counts towards MAX_RULES_CHARS: everything the prompt
// prints of the rules a model checks.
function modelRuleChars(rules: Rule[]): number {
  return rules
    .filter((rule) => rule.pattern === undefined)
    .reduce(
      (sum, rule) =>
        sum +
        rule.id.length +
        (rule.paths?.join(", ").length ?? 0) +
        rule.description.length +
        (rule.good?.length ?? 0) +
        (rule.bad?.length ?? 0),
      0,
    )
}

// Mirrors the server's bounds; a save is held back while anything is listed.
// inheritedRules are the global config's, under a repository's own: the server
// combines the two, so the limits and ids hold for both together.
export function validateForm(
  form: FormState,
  connectionRequired = false,
  savedConnections?: string[],
  patternErrors?: Record<string, string | null>,
  inheritedRules: Rule[] = [],
): FormErrors {
  const errors: FormErrors = {}
  for (const spec of NUMBERS) {
    const value = parseNumber(spec, form.numbers[spec.name])
    if (value === undefined || value === null) continue
    const range = spec.max === undefined ? `at least ${spec.min}` : `between ${spec.min} and ${spec.max}`
    if (!Number.isFinite(value) || (spec.integer && !Number.isInteger(value))) {
      errors[spec.name] = spec.nullable
        ? `Enter a whole number or "${spec.nullable}"`
        : spec.integer
          ? "Enter a whole number"
          : "Enter a number"
    } else if (value < spec.min || (spec.max !== undefined && value > spec.max)) {
      errors[spec.name] = `Must be ${range}`
    }
  }

  const modelHint = 'Use "provider/model", e.g. anthropic/claude-sonnet-5-5'
  for (const name of ["model", "walkthroughModel", "verifyModel"] as const) {
    const model = form[name].trim()
    if (model && !MODEL_PATTERN.test(model)) errors[name] = modelHint
  }
  const fallbackModels = modelList(form.fallbackModels)
  if (fallbackModels.length > MAX_FALLBACK_MODELS) errors.fallbackModels = `At most ${MAX_FALLBACK_MODELS} fallback models`
  else if (fallbackModels.some((model) => !MODEL_PATTERN.test(model))) errors.fallbackModels = modelHint

  if (connectionRequired && form.connection === INHERIT) errors.connection = "Select an LLM connection"
  else if (
    form.connection !== INHERIT &&
    savedConnections &&
    !savedConnections.includes(form.connection)
  ) {
    errors.connection = "Select a connection configured in Settings > API keys"
  }

  for (const name of LISTS) {
    const entries = tagList(form.lists[name])
    if (entries.length > MAX_LIST_ENTRIES) errors[name] = `At most ${MAX_LIST_ENTRIES} entries`
    else if (entries.some((entry) => entry.length > MAX_LIST_ENTRY)) errors[name] = `At most ${MAX_LIST_ENTRY} characters per entry`
  }

  if (form.categories?.length === 0) errors.categories = "Choose at least one category"
  if (pathList(form.ignorePaths).length > MAX_IGNORE_PATHS) errors.ignorePaths = `At most ${MAX_IGNORE_PATHS} paths`
  if (form.instructions.trim().length > MAX_INSTRUCTIONS) errors.instructions = `At most ${MAX_INSTRUCTIONS} characters`
  if (form.summaryInstructions.trim().length > MAX_SUMMARY_INSTRUCTIONS)
    errors.summaryInstructions = `At most ${MAX_SUMMARY_INSTRUCTIONS} characters`

  const languages = form.languageInstructions.map((row) => row.language.trim().toLowerCase()).filter(Boolean)
  if (new Set(languages).size !== languages.length) errors.languageInstructions = "Each language can only be listed once"
  else if (form.languageInstructions.some((row) => row.text.trim().length > MAX_LANGUAGE_INSTRUCTIONS))
    errors.languageInstructions = `At most ${MAX_LANGUAGE_INSTRUCTIONS} characters per language`

  const rules = form.rules.filter((row) => !isBlankRule(row)).map(toRule)
  const combined = [...inheritedRules, ...rules]
  const inheritedIds = new Set(inheritedRules.map((rule) => rule.id))
  const clash = rules.find((rule) => inheritedIds.has(rule.id))
  const withGlobal = inheritedRules.length ? `, together with the ${inheritedRules.length} global rules` : ""
  if (ruleRowErrors(form.rules, patternErrors).some((row) => Object.keys(row).length > 0))
    errors.rules = "Fix the rules marked below"
  else if (clash) errors.rules = `Rule ${clash.id} is already set in the global config, which wins`
  else if (combined.length > MAX_RULES) errors.rules = `At most ${MAX_RULES} rules${withGlobal}`
  else if (modelRuleChars(combined) > MAX_RULES_CHARS)
    errors.rules = `Rules without a pattern may hold at most ${MAX_RULES_CHARS} characters in total (ids, paths, descriptions and examples)${withGlobal}`
  return errors
}

// The layers below the global config: the defaults with a profile's preset on
// top, as server/src/review/config/resolve.ts merges them.
export function baseConfig(schema: ConfigSchema, profile: string = schema.defaults.profile): EffectiveConfig {
  const { defaults } = schema
  const preset = schema.profiles[profile] ?? {}
  return {
    ...defaults,
    profile,
    llm: { ...defaults.llm, ...preset.llm, capabilities: { ...defaults.llm.capabilities, ...preset.llm?.capabilities } },
    review: { ...defaults.review, ...preset.review, agent: { ...defaults.review.agent, ...preset.review?.agent } },
    output: { ...defaults.output, ...preset.output },
    triggers: { ...defaults.triggers, ...preset.triggers },
  }
}

// The global config shows real values instead of "inherit", so picking what
// the profile or defaults already give must not pin it: drop those values and
// the global config keeps following a later profile or default change.
export function withoutDefaults(settings: ConfigOverride, schema: ConfigSchema): ConfigOverride {
  const next: ConfigOverride = structuredClone(settings)
  const base = baseConfig(schema, settings.profile)
  // Arrays and maps are compared by value; key order is stable because the
  // form builds them in a fixed order.
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (next.profile === schema.defaults.profile) delete next.profile
  for (const name of ["ignorePaths", "languageInstructions"] as const) {
    if (name in next && same(next[name], base[name])) delete next[name]
  }
  for (const name of ["llm", "review", "output", "triggers"] as const) {
    const section = next[name] as Section | undefined
    if (!section) continue
    for (const [key, value] of Object.entries(section)) {
      const inherited = (base[name] as Section)[key]
      // A nested object (review.agent) keeps only the fields that differ.
      if (value && typeof value === "object" && !Array.isArray(value) && inherited && typeof inherited === "object") {
        const nested = value as Section
        for (const [field, fieldValue] of Object.entries(nested)) {
          if (same((inherited as Section)[field], fieldValue)) delete nested[field]
        }
        if (Object.keys(nested).length === 0) delete section[key]
      } else if (same(inherited, value)) delete section[key]
    }
    if (Object.keys(section).length === 0) delete next[name]
  }
  return next
}

// Compares what would be saved, so whitespace-only edits and toggling a flag
// back to its saved value do not count as changes. `finish` applies the same
// post-processing as the save (e.g. withoutDefaults) to both sides.
export function isDirty(
  base: ConfigOverride,
  form: FormState,
  finish: (settings: ConfigOverride) => ConfigOverride = (settings) => settings,
) {
  const saved = finish(toSettings(base, toForm(base)))
  return JSON.stringify(finish(toSettings(base, form))) !== JSON.stringify(saved)
}
