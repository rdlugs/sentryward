import { describe, expect, it } from "vitest"
import type { ConfigSchema } from "./api"
import { EMPTY_RULE, INHERIT, baseConfig, isDirty, ruleRowErrors, toForm, toSettings, validateForm, withoutDefaults } from "./settingsForm"

const schema: ConfigSchema = {
  defaults: {
    profile: "balanced",
    llm: {
      model: "anthropic/claude-sonnet-5-5",
      fallbackModels: [],
      walkthroughModel: null,
      verifyModel: null,
      temperature: 0.2,
      maxTokens: 8000,
      contextBudget: null,
      connection: null,
      baseUrl: null,
      endpointKey: null,
      thinking: "off",
      verifyThinking: null,
      capabilities: { thinking: "auto", tools: "auto" },
    },
    review: {
      categories: ["security", "bug"],
      severityFloor: "minor",
      blockOn: "critical",
      maxFindings: 25,
      maxChunks: 12,
      minConfidence: 0.5,
      requireEvidence: true,
      suppressIgnored: true,
      fullFile: false,
      committableSuggestions: true,
      disableCache: false,
      fileContext: true,
      impactDepth: 2,
      verify: "blocking",
      toolFindings: true,
      toolFindingsBlock: false,
      context: "static",
      agent: { maxSteps: 8, maxToolTokens: 30000, maxSearches: 5 },
    },
    output: {
      walkthrough: true,
      postInline: true,
      inlineMinSeverity: "info",
      maxInlineComments: null,
      postSummary: true,
      summaryOnlyWithFindings: false,
      postCheck: true,
      resolveFixedThreads: true,
      findingCounts: true,
      findingLifecycle: true,
      reviewStats: true,
      agentPrompts: true,
      agentPromptAll: true,
      blastRadiusLabel: false,
      effortLabel: false,
      sequenceDiagrams: true,
      estimateEffort: true,
      assessLinkedIssues: true,
      relatedIssues: true,
      highLevelSummary: true,
      highLevelSummaryPlacement: "description",
      highLevelSummaryInstructions: "",
      walkthroughLabels: true,
      walkthroughBlastRadius: true,
    },
    triggers: {
      review: "published",
      reviewOnPush: true,
      fullReviewOnPush: false,
      summary: "published",
      command: true,
      replies: true,
      abortOnClose: true,
      ignoreTitles: [],
      skipAuthors: [],
      skipLabels: [],
      skipSourceBranches: [],
      skipTargetBranches: [],
      onPush: true,
      drafts: false,
    },
    ignorePaths: ["**/*.lock"],
    instructions: "",
    languageInstructions: {},
    rules: [],
  },
  profiles: { balanced: {}, fast: { output: { walkthrough: false } }, strict: { review: { blockOn: "major" } } },
  severities: ["critical", "major", "minor"],
  categories: ["security", "bug", "style"],
  contextWindows: { anthropic: 200_000 },
  defaultContextWindow: 128_000,
  thinkingBudgets: { off: 0, low: 2_000, medium: 8_000, high: 24_000 },
}

describe("toSettings", () => {
  it("saves the walkthrough content switches, summary placement and instructions", () => {
    const form = toForm({})
    const next = {
      ...form,
      flags: { ...form.flags, sequenceDiagrams: false, relatedIssues: false, abortOnClose: false, disableCache: true },
      choices: { ...form.choices, highLevelSummaryPlacement: "walkthrough" },
      summaryInstructions: "  Bullets only  ",
    }
    const saved = toSettings({}, next)
    expect(saved).toEqual({
      review: { disableCache: true },
      output: {
        sequenceDiagrams: false,
        relatedIssues: false,
        highLevelSummaryPlacement: "walkthrough",
        highLevelSummaryInstructions: "Bullets only",
      },
      triggers: { abortOnClose: false },
    })
    expect(toForm(saved).summaryInstructions).toBe("Bullets only")
    expect(validateForm({ ...next, summaryInstructions: "x".repeat(2001) }).summaryInstructions).toBe("At most 2000 characters")
  })

  it("round-trips saved settings through the form", () => {
    const saved = {
      profile: "strict",
      llm: { model: "openai/gpt-5", walkthroughModel: "openai/gpt-5-mini", verifyModel: "openai/gpt-5.5" },
      review: { blockOn: "major", fullFile: true, verify: "all" as const },
      output: { walkthrough: false, postCheck: true },
      triggers: { review: "all" as const, reviewOnPush: false, command: false, skipLabels: ["no-review"] },
      instructions: "Keep it lean",
    }
    expect(toSettings(saved, toForm(saved))).toEqual(saved)
  })

  it("saves the trigger choices and skip lists", () => {
    const form = toForm({})
    const inherit = {
      review: INHERIT,
      summary: INHERIT,
      highLevelSummaryPlacement: INHERIT,
      inlineMinSeverity: INHERIT,
      verify: INHERIT,
      context: INHERIT,
      thinking: INHERIT,
      verifyThinking: INHERIT,
      thinkingSupport: INHERIT,
      toolSupport: INHERIT,
    }
    expect(form.choices).toEqual(inherit)
    const next = {
      ...form,
      choices: { ...inherit, review: "manual", summary: "manual" },
      lists: { ...form.lists, ignoreTitles: [" WIP", "Do not review ", " "], skipAuthors: ["dependabot[bot]"] },
    }
    expect(toSettings({}, next)).toEqual({
      triggers: {
        review: "manual",
        summary: "manual",
        ignoreTitles: ["WIP", "Do not review"],
        skipAuthors: ["dependabot[bot]"],
      },
    })
    expect(toForm(toSettings({}, next)).lists.ignoreTitles).toEqual(["WIP", "Do not review"])
  })

  it("reads the legacy trigger keys into the code review trigger and drops them on save", () => {
    expect(toForm({ triggers: { onPush: false } }).choices.review).toBe("manual")
    expect(toForm({ triggers: { drafts: true } }).choices.review).toBe("all")
    expect(toForm({ triggers: { onPush: false, review: "published" } }).choices.review).toBe("published")
    const legacy = { triggers: { onPush: false, drafts: true, command: false } }
    expect(toSettings(legacy, toForm(legacy))).toEqual({ triggers: { review: "manual", command: false } })
    expect(isDirty(legacy, toForm(legacy))).toBe(false)
  })

  it("round-trips every other field, including an explicit auto context budget", () => {
    const saved = {
      llm: { fallbackModels: ["openai/gpt-5", "google/gemini-3"], temperature: 0, maxTokens: 4000, contextBudget: null },
      review: { categories: ["style"], maxFindings: 10, maxChunks: 3, minConfidence: 0.75 },
      ignorePaths: ["gen/**", "**/*.{png,svg}"],
      languageInstructions: { Go: "Wrap errors", Python: "Type hints" },
    }
    const form = toForm(saved)
    expect(form.numbers.contextBudget).toBe("auto")
    expect(toSettings(saved, form)).toEqual(saved)
  })

  it("round-trips the inline limits and summary only with findings, saving no cap as null", () => {
    const saved = { output: { inlineMinSeverity: "major", maxInlineComments: 5, summaryOnlyWithFindings: true } }
    const form = toForm(saved)
    expect(form.choices.inlineMinSeverity).toBe("major")
    expect(form.numbers.maxInlineComments).toBe("5")
    expect(form.flags.summaryOnlyWithFindings).toBe(true)
    expect(toSettings(saved, form)).toEqual(saved)

    const uncapped = { output: { maxInlineComments: null } }
    expect(toForm(uncapped).numbers.maxInlineComments).toBe("none")
    expect(toSettings({}, { ...toForm({}), numbers: { ...toForm({}).numbers, maxInlineComments: "None" } })).toEqual(uncapped)
  })

  it("holds back an inline cap out of range or not a number", () => {
    const numbers = (maxInlineComments: string) => ({ ...toForm({}), numbers: { ...toForm({}).numbers, maxInlineComments } })
    expect(validateForm(numbers("0")).maxInlineComments).toBe("Must be between 1 and 100")
    expect(validateForm(numbers("101")).maxInlineComments).toBe("Must be between 1 and 100")
    expect(validateForm(numbers("lots")).maxInlineComments).toBe('Enter a whole number or "none"')
    expect(validateForm(numbers("none")).maxInlineComments).toBeUndefined()
  })

  it("trims lists, keeps commas in globs and drops incomplete language rows", () => {
    const form = {
      ...toForm({}),
      fallbackModels: [" openai/gpt-5 ", "", "google/gemini-3"],
      ignorePaths: "  **/*.{png,svg}\n\n gen/** ",
      numbers: { ...toForm({}).numbers, maxFindings: " 12 " },
      languageInstructions: [
        { language: " Go ", text: " Wrap errors " },
        { language: "Rust", text: "  " },
      ],
    }

    expect(toSettings({}, form)).toEqual({
      llm: { fallbackModels: ["openai/gpt-5", "google/gemini-3"] },
      review: { maxFindings: 12 },
      ignorePaths: ["**/*.{png,svg}", "gen/**"],
      languageInstructions: { Go: "Wrap errors" },
    })
  })

  it("round-trips rules, leaving out empty optional fields and blank rows", () => {
    const saved = {
      rules: [
        { id: "no-db", description: "No Prisma in controllers.", severity: "major", paths: ["src/controllers/**", "src/api/**"], pattern: "@prisma/client" },
        { id: "thin", description: "Keep controllers thin.", severity: "minor", category: "style", good: "  return svc.run()\n", bad: "db.query()" },
      ],
    }
    const form = toForm(saved)
    expect(form.rules[0]).toMatchObject({ paths: "src/controllers/**\nsrc/api/**", category: "", good: "" })
    expect(toSettings(saved, form)).toEqual(saved)
    expect(isDirty(saved, form)).toBe(false)

    const edited = { ...form, rules: [{ ...form.rules[1], id: " thin ", description: " Thin. ", good: " " }, { ...EMPTY_RULE }] }
    expect(toSettings({}, edited)).toEqual({ rules: [{ id: "thin", description: "Thin.", severity: "minor", category: "style", bad: "db.query()" }] })
    expect(toSettings(saved, { ...form, rules: [] })).toEqual({})
  })

  it("removes inherited values and empty sections but keeps keys the form does not show", () => {
    const saved = { review: { blockOn: "major", maxFindings: 10 }, output: { walkthrough: true }, ignorePaths: ["gen/**"] }
    const base = toForm(saved)
    const form = { ...base, blockOn: INHERIT, flags: { ...base.flags, walkthrough: undefined } }

    expect(toSettings(saved, form)).toEqual({ review: { maxFindings: 10 }, ignorePaths: ["gen/**"] })
  })

  it("saves flags turned off and trims text", () => {
    const base = toForm({})
    const form = {
      ...base,
      model: "  anthropic/claude-opus-5-5 ",
      instructions: "   ",
      flags: { ...base.flags, postInline: false, requireEvidence: false },
    }

    expect(toSettings({}, form)).toEqual({
      llm: { model: "anthropic/claude-opus-5-5" },
      review: { requireEvidence: false },
      output: { postInline: false },
    })
  })
})

describe("isDirty", () => {
  const saved = { output: { walkthrough: false }, instructions: "Keep it lean" }

  it("is clean for the saved settings and for edits that save the same thing", () => {
    expect(isDirty(saved, toForm(saved))).toBe(false)
    expect(isDirty(saved, { ...toForm(saved), instructions: "Keep it lean  " })).toBe(false)
  })

  it("is dirty once a value changes or a flag goes back to inheriting", () => {
    const form = toForm(saved)
    expect(isDirty(saved, { ...form, flags: { ...form.flags, reviewOnPush: false } })).toBe(true)
    expect(isDirty(saved, { ...form, choices: { ...form.choices, review: "all" } })).toBe(true)
    expect(isDirty(saved, { ...form, lists: { ...form.lists, skipLabels: [" "] } })).toBe(false)
    expect(isDirty(saved, { ...form, lists: { ...form.lists, skipLabels: ["no-review"] } })).toBe(true)
    expect(isDirty(saved, { ...form, flags: { ...form.flags, walkthrough: undefined } })).toBe(true)
  })
})

describe("baseConfig", () => {
  it("puts the profile's preset on top of the defaults", () => {
    const base = baseConfig(schema, "strict")
    expect(base.profile).toBe("strict")
    expect(base.review).toMatchObject({ blockOn: "major", severityFloor: "minor" })
    expect(baseConfig(schema).review.blockOn).toBe("critical")
  })
})

describe("withoutDefaults", () => {
  it("drops values the profile and defaults already give and keeps the rest", () => {
    const settings = {
      profile: "fast",
      llm: { model: "anthropic/claude-sonnet-5-5" },
      review: { blockOn: "critical", severityFloor: "major", maxFindings: 10 },
      output: { walkthrough: false, postInline: true },
      ignorePaths: ["gen/**"],
    }

    expect(withoutDefaults(settings, schema)).toEqual({
      profile: "fast",
      review: { severityFloor: "major", maxFindings: 10 },
      ignorePaths: ["gen/**"],
    })
  })

  it("compares lists by value", () => {
    const settings = {
      llm: { fallbackModels: [] },
      review: { categories: ["security", "bug"] },
      ignorePaths: ["**/*.lock"],
      languageInstructions: {},
    }
    expect(withoutDefaults(settings, schema)).toEqual({})
    expect(withoutDefaults({ review: { categories: ["bug"] } }, schema)).toEqual({ review: { categories: ["bug"] } })
  })

  it("drops the default profile and sections left empty", () => {
    expect(withoutDefaults({ profile: "balanced", triggers: { review: "published", skipLabels: [] } }, schema)).toEqual({})
  })

  it("lets isDirty ignore picking a value the defaults already give", () => {
    const form = { ...toForm({}), blockOn: "critical" }
    expect(isDirty({}, form, (settings) => withoutDefaults(settings, schema))).toBe(false)
    expect(isDirty({}, form)).toBe(true)
  })
})

describe("validateForm", () => {
  const form = toForm({})

  it("accepts an untouched form and auto", () => {
    expect(validateForm(form)).toEqual({})
    expect(validateForm({ ...form, numbers: { ...form.numbers, contextBudget: "auto" } })).toEqual({})
  })

  it("reports values the server would reject", () => {
    const errors = validateForm({
      ...form,
      model: "claude",
      walkthroughModel: "haiku",
      verifyModel: "anthropic/claude-opus-5-5",
      fallbackModels: ["openai/a", "openai/b", "openai/c", "openai/d"],
      categories: [],
      numbers: { ...form.numbers, temperature: "2", maxTokens: "1.5", contextBudget: "lots" },
      languageInstructions: [
        { language: "Go", text: "a" },
        { language: "go", text: "b" },
      ],
      lists: {
        ...form.lists,
        skipAuthors: Array.from({ length: 51 }, (_, i) => `bot${i}`),
        skipLabels: ["x".repeat(201)],
      },
    })

    expect(errors).toEqual({
      model: 'Use "provider/model", e.g. anthropic/claude-sonnet-5-5',
      walkthroughModel: 'Use "provider/model", e.g. anthropic/claude-sonnet-5-5',
      fallbackModels: "At most 3 fallback models",
      categories: "Choose at least one category",
      temperature: "Must be between 0 and 1",
      maxTokens: "Enter a whole number",
      contextBudget: 'Enter a whole number or "auto"',
      languageInstructions: "Each language can only be listed once",
      skipAuthors: "At most 50 entries",
      skipLabels: "At most 200 characters per entry",
    })
  })

  it("reports rule rows the server would reject, with RE2 answers for patterns", () => {
    const rule = { ...EMPTY_RULE, id: "no-b", description: "No b.", severity: "major" }
    const rows = [
      rule,
      { ...rule, pattern: "(?=b)" },
      { ...rule, id: "Bad Id", severity: "" },
      { ...rule, id: "", description: " " },
      { ...EMPTY_RULE },
    ]
    const patternErrors = { "(?=b)": "Not a valid regular expression" }

    expect(ruleRowErrors(rows, patternErrors)).toEqual([
      {},
      { id: "Duplicate rule id no-b", pattern: "Not a valid regular expression" },
      {
        id: "Use lowercase letters, digits, dots, dashes and underscores, e.g. no-db-in-controllers",
        severity: "Choose a severity",
      },
      { id: "Enter an id", description: "Describe what the rule requires" },
      {},
    ])
    expect(validateForm({ ...form, rules: rows }, false, undefined, patternErrors).rules).toBe("Fix the rules marked below")
    // A pattern the server has not answered for yet does not hold the row back.
    expect(validateForm({ ...form, rules: [{ ...rule, pattern: "(?=b)" }] })).toEqual({})
    expect(
      validateForm({ ...form, rules: Array.from({ length: 51 }, (_, i) => ({ ...rule, id: `r${i}`, pattern: "b" })) }).rules,
    ).toBe("At most 50 rules")
    expect(
      validateForm({ ...form, rules: Array.from({ length: 17 }, (_, i) => ({ ...rule, id: `r${i}`, description: "x".repeat(1000) })) }).rules,
    ).toMatch(/at most 16000 characters in total/)
  })

  it("drops and does not check the examples of a rule with a pattern", () => {
    const rule = { ...EMPTY_RULE, id: "no-b", description: "No b.", severity: "major", pattern: "b", bad: "x".repeat(2001), good: "ok" }
    expect(ruleRowErrors([rule])).toEqual([{}])
    expect(validateForm({ ...form, rules: [rule] })).toEqual({})
    expect(toSettings({}, { ...form, rules: [rule] })).toEqual({
      rules: [{ id: "no-b", description: "No b.", severity: "major", pattern: "b" }],
    })
  })

  it("holds a repository's rules to the limits and ids together with the global ones", () => {
    const rule = { ...EMPTY_RULE, id: "no-b", description: "No b.", severity: "major" }
    const inherited = Array.from({ length: 45 }, (_, i) => ({ id: `g${i}`, description: "G.", severity: "minor" as const }))
    const own = Array.from({ length: 10 }, (_, i) => ({ ...rule, id: `r${i}` }))
    expect(validateForm({ ...form, rules: own }, false, undefined, undefined, inherited).rules).toBe(
      "At most 50 rules, together with the 45 global rules",
    )
    expect(validateForm({ ...form, rules: [{ ...rule, id: "g0" }] }, false, undefined, undefined, inherited).rules).toBe(
      "Rule g0 is already set in the global config, which wins",
    )
    expect(validateForm({ ...form, rules: own.slice(0, 5) }, false, undefined, undefined, inherited)).toEqual({})
  })

  it("accepts router model ids", () => {
    expect(
      validateForm({
        ...form,
        model: "openai/cx/gpt-5.6-sol(medium)",
      }),
    ).toEqual({})
  })

  it("accepts Ollama model ids", () => {
    expect(validateForm({ ...form, model: "ollama/qwen3" })).toEqual({})
  })
})

describe("thinking, capabilities and agentic context", () => {
  it("round-trips nested settings and keeps tool support a boolean", () => {
    const saved = {
      llm: { thinking: "medium" as const, verifyThinking: "low" as const, capabilities: { tools: false } },
      review: { context: "agentic" as const, agent: { maxSteps: 4 } },
    }
    const form = toForm(saved)
    expect(form.choices).toMatchObject({ thinking: "medium", verifyThinking: "low", toolSupport: "false", thinkingSupport: INHERIT })
    expect(form.numbers).toMatchObject({ maxSteps: "4", maxToolTokens: "" })
    expect(toSettings(saved, form)).toEqual(saved)

    const changed = toSettings(saved, {
      ...form,
      choices: { ...form.choices, toolSupport: "true", thinkingSupport: "model" },
      numbers: { ...form.numbers, maxSteps: "", maxSearches: "2" },
    })
    expect(changed.llm?.capabilities).toEqual({ thinking: "model", tools: true })
    expect(changed.review?.agent).toEqual({ maxSearches: 2 })
  })

  it("drops a nested object once nothing in it is set", () => {
    const saved = { review: { agent: { maxSteps: 4 } }, llm: { capabilities: { tools: true } } }
    const form = toForm(saved)
    const cleared = toSettings(saved, {
      ...form,
      choices: { ...form.choices, toolSupport: INHERIT },
      numbers: { ...form.numbers, maxSteps: "" },
    })
    expect(cleared).toEqual({})
  })

  it("rejects agent caps outside the server's bounds", () => {
    const form = toForm({})
    expect(validateForm({ ...form, numbers: { ...form.numbers, maxSteps: "1", maxSearches: "11" } })).toMatchObject({
      maxSteps: expect.any(String),
      maxSearches: expect.any(String),
    })
  })

  it("does not pin agent caps the profile already gives", () => {
    expect(withoutDefaults({ review: { agent: { maxSteps: 8, maxSearches: 2 } } }, schema)).toEqual({
      review: { agent: { maxSearches: 2 } },
    })
  })
})

describe("LLM connection", () => {
  it("round-trips a live connection reference", () => {
    const form = { ...toForm({}), connection: "openai" }
    const settings = toSettings({}, form)
    expect(settings).toEqual({ llm: { connection: "openai" } })
    expect(toForm(settings).connection).toBe("openai")
    expect(toSettings(settings, { ...form, connection: INHERIT })).toEqual({})
  })

  it("converts a legacy endpoint key and removes copied endpoint values", () => {
    const legacy = { llm: { baseUrl: "http://localhost:20128/v1", endpointKey: "openai" as const } }
    const form = toForm(legacy)
    expect(form.connection).toBe("openai")
    expect(toSettings(legacy, form)).toEqual({ llm: { connection: "openai" } })
  })

  it("requires a connection for the global form", () => {
    expect(validateForm(toForm({}), true)).toMatchObject({ connection: "Select an LLM connection" })
  })
})
