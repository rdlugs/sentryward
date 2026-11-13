import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"

const effective = {
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
    checkClaims: true,
    toolFindings: true,
    toolFindingsBlock: false,
    context: "static",
    agent: { maxSteps: 8, maxToolTokens: 30000, maxSearches: 5 },
  },
  // The server's quiet defaults (DEFAULT_CONFIG in server/src/review/config/schema.ts).
  output: {
    walkthrough: true,
    postInline: true,
    inlineMinSeverity: "info",
    maxInlineComments: null,
    postSummary: true,
    summaryOnlyWithFindings: false,
    postCheck: false,
    resolveFixedThreads: true,
    findingCounts: false,
    findingLifecycle: false,
    reviewStats: false,
    agentPrompts: true,
    agentPromptAll: true,
    blastRadiusLabel: false,
    effortLabel: false,
    sequenceDiagrams: false,
    estimateEffort: false,
    assessLinkedIssues: false,
    relatedIssues: true,
    highLevelSummary: false,
    highLevelSummaryPlacement: "description",
    highLevelSummaryInstructions: "",
    walkthroughLabels: false,
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
}

const globalConfig = (settings: Record<string, unknown> = {}, sources: Record<string, string> = {}) => ({
  settings,
  warnings: [],
  config: effective,
  sources: { profile: "default", "llm.model": "default", "review.blockOn": "default", ...sources },
})

const schema = {
  defaults: effective,
  profiles: { balanced: {}, strict: { review: { blockOn: "major" } } },
  severities: ["critical", "major", "minor"],
  categories: ["security", "bug", "style"],
  contextWindows: { anthropic: 200_000, openai: 200_000, google: 1_000_000, ollama: 128_000 },
  defaultContextWindow: 128_000,
  thinkingBudgets: { off: 0, low: 2_000, medium: 8_000, high: 24_000 },
}

const repo = (id: string, fullPath: string, extra: Record<string, unknown> = {}) => ({
  id,
  connectionId: "c1",
  account: { login: "dev", provider: "gitlab", host: "gitlab.com" },
  externalId: id,
  fullPath,
  defaultBranch: "main",
  webUrl: `https://gitlab.com/${fullPath}`,
  enabled: true,
  settings: {},
  followGlobal: true,
  ...extra,
})

async function chooseScope(name: string | RegExp) {
  await userEvent.click(await screen.findByRole("combobox", { name: "Scope" }))
  await userEvent.click(await screen.findByRole("option", { name }))
}

async function openTab(name: string) {
  await userEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${name}`) }))
}

async function choosePreviewView(preview: HTMLElement, name: "Summary" | "In-line") {
  await userEvent.click(within(within(preview).getByRole("group", { name: "View" })).getByRole("button", { name }))
}

async function selectConnectionOnLlmTab() {
  await openTab("LLM Config")
  await selectOpenAiConnection()
}

async function selectOpenAiConnection() {
  await userEvent.click(screen.getByRole("combobox", { name: "LLM connection" }))
  await userEvent.click(screen.getByRole("option", { name: /OpenAI/ }))
}

const GLOBAL_SCOPE = /The global config applies to every repository/
// A server preview of the sample change, trimmed to what the tests look at.
const PREVIEW = {
  provider: "github",
  pr: {
    title: "Add user lookup endpoint",
    number: 42,
    author: "ada",
    sourceBranch: "feature/user-lookup",
    targetBranch: "main",
    labels: ["Medium blast radius"],
  },
  status: { state: "failure", description: "1 finding at or above critical" },
  summaryComment:
    "## Summary\n\nAdds a lookup endpoint.\n\n⛔ **Blocked**: 1 finding at or above critical.\n\n<details>\n<summary>Actionable comments (1)</summary>\n\n- SQL\n\n</details>\n\n<!-- sentryward:summary -->\n",
  walkthroughComment: null,
  inline: [
    {
      path: "src/api/users.ts",
      startLine: 9,
      endLine: 9,
      body: "**critical** · security\n\n**User id is interpolated**\n\n```suggestion\nconst rows = safe()\n```",
      diff: [{ type: "add", oldLine: null, newLine: 9, text: "const rows = old()" }],
    },
  ],
}
const NOTHING = { summaryComment: null, walkthroughComment: null, status: null, inline: [] }

interface PreviewBody {
  provider: string
  base: Record<string, unknown>
  settings: Record<string, unknown>
}

// Records each preview request and answers like the server would for the
// switches the tests use.
function previewStub(bodies: PreviewBody[]) {
  return (init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as PreviewBody
    bodies.push(body)
    const output = (body.settings.output ?? {}) as Record<string, boolean>
    return jsonResponse(200, {
      ...PREVIEW,
      provider: body.provider,
      inline: output.postInline === false ? [] : PREVIEW.inline,
    })
  }
}

const REVIEWED = { reason: null, fullReview: true, walkthrough: true }

const globalRoutes = (extra: Record<string, unknown> = {}) => ({
  "POST /api/config/preview": PREVIEW,
  "POST /api/config/triggers/check": REVIEWED,
  "GET /api/config/global": globalConfig(),
  "GET /api/config/schema": schema,
  "GET /api/repos": { repos: [] },
  "GET /api/settings/api-keys": {
    keys: [
      { provider: "anthropic", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: true },
      { provider: "openai", stored: true, last4: "9rtr", undecryptable: false, baseUrl: null, updatedAt: "2026-10-04T00:00:00Z", serverDefault: false },
      { provider: "google", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false },
      { provider: "ollama", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false },
    ],
  },
  "GET /api/settings/api-keys/openai/status": { status: "active" },
  "GET /api/settings/api-keys/openai/capabilities": { capabilities: [] },
  "GET /api/settings/model-prices/lookup": { model: "", price: null, builtIn: null },
  ...extra,
})

// Several tests walk the whole form across tabs with userEvent; they take ~2s
// locally but exceed the 5s default on slower CI runners.
describe("Configuration page", { timeout: 20_000 }, () => {
  it("is linked from the sidebar", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/home" })

    await userEvent.click(await screen.findByRole("link", { name: "Review settings" }))

    expect(await screen.findByRole("heading", { name: "Review settings" })).toBeInTheDocument()
    expect(await screen.findByText(GLOBAL_SCOPE)).toBeInTheDocument()
    expect(await screen.findByRole("tab", { name: /^LLM Config/, selected: true })).toBeInTheDocument()
  })

  it("splits the settings into tabs and keeps the open tab in the URL", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=files" })

    expect(await screen.findByRole("tab", { name: "Files", selected: true })).toBeInTheDocument()
    expect(screen.getByLabelText("Ignore paths")).toBeInTheDocument()
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument()
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "LLM Config, has errors",
      "Finding Types",
      "Files",
      "Display",
      "Triggers",
      "Guidance",
    ])

    await openTab("LLM Config")
    for (const name of ["Connection and models", "Per-purpose models", "Model calls"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument()
    }
    await openTab("Finding Types")
    for (const name of ["Severity", "What gets reported", "Accuracy", "Scope and context", "Static analysis", "Fixes"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument()
    }

    await openTab("Triggers")
    expect(screen.getByRole("switch", { name: "Allow review command" })).toBeInTheDocument()
    expect(screen.queryByLabelText("Ignore paths")).not.toBeInTheDocument()
  })

  it("saves the global config and shows where effective values come from", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig({ llm: { model: "openai/gpt-5" } }, { "llm.model": "global" }))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    expect(await screen.findByText("Effective: anthropic/claude-sonnet-5-5")).toBeInTheDocument()
    await selectOpenAiConnection()
    await userEvent.type(screen.getByLabelText("Model"), "openai/gpt-5")
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({ settings: { llm: { model: "openai/gpt-5", connection: "openai" } } }),
    )
    expect(await screen.findByText("Global config saved")).toBeInTheDocument()
  })

  it("shows real values instead of inherit in the global config and only saves changes", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    const save = await screen.findByRole("button", { name: "Save global config" })
    // Picking the value the defaults already give is not a change.
    const profile = screen.getByRole("combobox", { name: "Profile" })
    await waitFor(() => expect(profile).toHaveTextContent("balanced"))
    await userEvent.click(profile)
    await userEvent.click(screen.getByRole("option", { name: "balanced" }))
    expect(save).toBeDisabled()
    await selectOpenAiConnection()

    // A profile's preset shows through on the other tabs without being pinned.
    await userEvent.click(profile)
    await userEvent.click(screen.getByRole("option", { name: "strict" }))
    await openTab("Finding Types")
    const blockOn = screen.getByRole("combobox", { name: "Block at or above" })
    expect(blockOn).toHaveTextContent("major")
    await userEvent.click(blockOn)
    expect(screen.queryByRole("option", { name: /Inherit/ })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    await openTab("Display")
    const walkthrough = screen.getByRole("switch", { name: "PR summary" })
    expect(walkthrough).toBeChecked()
    await userEvent.click(walkthrough)
    expect(walkthrough).not.toBeChecked()
    expect(screen.queryByText("Overridden")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /to inherited/ })).not.toBeInTheDocument()
    // Edits from every tab go out in one save.
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({
        settings: { profile: "strict", llm: { connection: "openai" }, output: { walkthrough: false } },
      }),
    )
  })

  it("edits every kind of setting in the global config", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await userEvent.type(await screen.findByLabelText("Context budget"), "auto")
    await userEvent.click(screen.getByRole("button", { name: "Add fallback model" }))
    await userEvent.type(screen.getByLabelText("Fallback model 1"), "openai/gpt-5")
    await userEvent.click(screen.getByRole("combobox", { name: "LLM connection" }))
    // Only connections saved by this user are offered, not server defaults.
    expect(screen.queryByRole("option", { name: /Anthropic/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Google/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("option", { name: /OpenAI/ }))

    await openTab("Finding Types")
    expect(screen.getByRole("checkbox", { name: "security" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "style" })).not.toBeChecked()
    await userEvent.type(screen.getByLabelText("Max findings"), "10")
    await userEvent.click(screen.getByRole("checkbox", { name: "bug" }))
    await userEvent.click(screen.getByRole("checkbox", { name: "style" }))

    await openTab("Files")
    await userEvent.type(screen.getByLabelText("Ignore paths"), "gen/**{enter}docs/**")

    await openTab("Guidance")
    await userEvent.click(screen.getByRole("button", { name: "Add language" }))
    await userEvent.type(screen.getByLabelText("Language 1"), "Go")
    await userEvent.type(screen.getByLabelText("Guidance for language 1"), "Wrap errors")
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({
        settings: {
          // "auto" is already the default context budget, so it is not pinned.
          llm: {
            fallbackModels: ["openai/gpt-5"],
            connection: "openai",
          },
          review: { categories: ["security", "style"], maxFindings: 10 },
          ignorePaths: ["gen/**", "docs/**"],
          languageInstructions: { Go: "Wrap errors" },
        },
      }),
    )
  })

  it("edits thinking, capabilities and agentic context in the global config", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await userEvent.click(await screen.findByRole("combobox", { name: "LLM connection" }))
    await userEvent.click(screen.getByRole("option", { name: /OpenAI/ }))
    await userEvent.click(screen.getByRole("combobox", { name: "Thinking" }))
    await userEvent.click(screen.getByRole("option", { name: "Medium (8k tokens)" }))
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }))
    await userEvent.click(screen.getByRole("combobox", { name: "Tool support" }))
    await userEvent.click(screen.getByRole("option", { name: "No tools" }))

    await openTab("Finding Types")
    await userEvent.click(screen.getByRole("combobox", { name: "Review context" }))
    await userEvent.click(screen.getByRole("option", { name: "Agentic" }))
    await userEvent.type(screen.getByLabelText("Agent steps"), "4")
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toMatchObject({
        settings: {
          llm: { thinking: "medium", capabilities: { tools: false } },
          review: { context: "agentic", agent: { maxSteps: 4 } },
        },
      }),
    )
  })

  it("edits the trigger settings in the global config", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=triggers" })

    // The global config shows real values: the defaults until something is picked.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Code review trigger" })).toHaveTextContent("Published PRs"),
    )
    for (const name of ["Automatic reviews", "PR summary", "Commands and replies", "Skip rules"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument()
    }
    for (const name of ["Review automatically on push", "Allow review command"]) {
      expect(screen.getByRole("switch", { name })).toBeInTheDocument()
    }
    // What gets posted, and where, lives on the Display tab.
    expect(screen.queryByRole("combobox", { name: "Comment location" })).not.toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: "Publish blast radius label" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("combobox", { name: "Code review trigger" }))
    await userEvent.click(screen.getByRole("option", { name: "Draft and published PRs" }))
    await userEvent.click(screen.getByRole("combobox", { name: "PR summary trigger" }))
    await userEvent.click(screen.getByRole("option", { name: "Manual only" }))
    await userEvent.click(screen.getByRole("switch", { name: "Review automatically on push" }))
    await userEvent.type(screen.getByLabelText("Ignore by title"), "WIP{enter}Draft,")
    // "[[" types a literal bracket.
    await userEvent.type(screen.getByLabelText("Skip by author"), "dependabot[[bot]{enter}")
    await userEvent.type(screen.getByLabelText("Skip by label"), "no-review{enter}")
    await userEvent.type(screen.getByLabelText("Skip by source branch"), "release/{enter}")
    // Left in the box: it is added when the box loses focus.
    await userEvent.type(screen.getByLabelText("Skip by target branch"), "legacy")
    expect(screen.getByRole("button", { name: "Remove Draft" })).toBeInTheDocument()

    await openTab("Display")
    await userEvent.click(screen.getByRole("switch", { name: "Show finding counts" }))
    await userEvent.click(screen.getByRole("switch", { name: "Show changes since the last review" }))
    await userEvent.click(screen.getByRole("switch", { name: "Show review details" }))
    await userEvent.click(screen.getByRole("switch", { name: "Prompt for AI agents per comment" }))
    await userEvent.click(screen.getByRole("switch", { name: "Show labels in the summary" }))
    await userEvent.click(screen.getByRole("switch", { name: "Show blast radius in the summary" }))
    await userEvent.click(screen.getByRole("switch", { name: "Publish blast radius label" }))
    await userEvent.click(screen.getByRole("switch", { name: "Publish review time estimate label" }))
    await selectConnectionOnLlmTab()
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({
        settings: {
          llm: { connection: "openai" },
          output: {
            findingCounts: true,
            findingLifecycle: true,
            reviewStats: true,
            agentPrompts: false,
            blastRadiusLabel: true,
            effortLabel: true,
            walkthroughLabels: true,
            walkthroughBlastRadius: false,
          },
          triggers: {
            review: "all",
            reviewOnPush: false,
            summary: "manual",
            ignoreTitles: ["WIP", "Draft"],
            skipAuthors: ["dependabot[bot]"],
            skipLabels: ["no-review"],
            skipSourceBranches: ["release/"],
            skipTargetBranches: ["legacy"],
          },
        },
      }),
    )
  })

  it("edits the walkthrough content, summary and run settings in the global config", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    // The quiet defaults keep only the related issues.
    await waitFor(() => expect(screen.getByRole("switch", { name: "Related issues" })).toBeChecked())
    for (const name of ["Sequence diagrams", "Show review effort in the summary", "Assess linked issues", "High-level summary"]) {
      expect(screen.getByRole("switch", { name })).not.toBeChecked()
    }
    await userEvent.click(screen.getByRole("switch", { name: "Sequence diagrams" }))
    await userEvent.click(screen.getByRole("switch", { name: "Related issues" }))
    await userEvent.click(screen.getByRole("switch", { name: "High-level summary" }))
    await userEvent.click(screen.getByRole("combobox", { name: "Summary placement" }))
    await userEvent.click(screen.getByRole("option", { name: "PR summary" }))
    await userEvent.type(screen.getByLabelText("High level summary instructions"), "Bullets only")

    // Without a summary there is nothing to place or instruct.
    await userEvent.click(screen.getByRole("switch", { name: "High-level summary" }))
    expect(screen.getByLabelText("High level summary instructions")).toBeDisabled()
    await userEvent.click(screen.getByRole("switch", { name: "High-level summary" }))

    await openTab("Triggers")
    await userEvent.click(screen.getByRole("switch", { name: "Abort on close" }))
    await openTab("Files")
    await userEvent.click(screen.getByRole("switch", { name: "Disable cache" }))
    await selectConnectionOnLlmTab()
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({
        settings: {
          llm: { connection: "openai" },
          review: { disableCache: true },
          output: {
            sequenceDiagrams: true,
            relatedIssues: false,
            highLevelSummary: true,
            highLevelSummaryPlacement: "walkthrough",
            highLevelSummaryInstructions: "Bullets only",
          },
          triggers: { abortOnClose: false },
        },
      }),
    )
  })

  it("requires a saved LLM connection and links to the LLM Connections page", async () => {
    mockApi(
      globalRoutes({
        "GET /api/settings/api-keys": {
          keys: [
            { provider: "anthropic", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: true },
            { provider: "openai", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false },
            { provider: "google", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false },
            { provider: "ollama", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false },
          ],
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    expect(await screen.findByText("Select an LLM connection")).toBeInTheDocument()
    // Scoped to the page (the innermost main): the sidebar has its own LLM Connections link.
    const page = screen.getAllByRole("main").at(-1)!
    await waitFor(() => expect(within(page).getAllByRole("link", { name: "LLM Connections" })).toHaveLength(2))
    const links = within(page).getAllByRole("link", { name: "LLM Connections" })
    expect(links[1]!.closest("p")).toHaveTextContent("No saved connections")
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/llm-connections")
    }
    expect(screen.getByRole("button", { name: "Save global config" })).toBeDisabled()
  })

  it("holds back a save while a value is out of range and marks the tab", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=files" })

    await openTab("LLM Config")
    await selectOpenAiConnection()
    await openTab("Files")
    await userEvent.type(await screen.findByLabelText("Max chunks"), "500")

    expect(screen.getByText("Must be between 1 and 50")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Files, has errors" })).toBeInTheDocument()
    // Still held back from a tab without the error.
    await openTab("Display")
    expect(screen.getByRole("button", { name: "Save global config" })).toBeDisabled()

    await openTab("Files")
    await userEvent.clear(screen.getByLabelText("Max chunks"))
    await userEvent.type(screen.getByLabelText("Max chunks"), "20")
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save global config" })).toBeEnabled()
  })

  it("renders what the server previews as the PR page, following unsaved edits", async () => {
    const bodies: PreviewBody[] = []
    mockApi(globalRoutes({ "POST /api/config/preview": previewStub(bodies) }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    const preview = await screen.findByRole("region", { name: "Review preview" })
    for (const name of ["Where to post", "PR summary"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument()
    }
    // The settings and the preview are separate cards.
    expect(screen.getByRole("switch", { name: "PR summary" }).closest("[data-slot=card]")).not.toBe(
      preview.closest("[data-slot=card]"),
    )

    expect(await within(preview).findByRole("heading", { name: /Add user lookup endpoint/ })).toHaveTextContent("#42")
    // Sentryward never writes to the description, so the preview leaves it out.
    expect(within(preview).queryByRole("region", { name: "Pull request description" })).not.toBeInTheDocument()
    expect(within(preview).getByRole("list", { name: "Labels" })).toHaveTextContent("Medium blast radius")
    // The summary view is shown first, without the inline threads.
    const view = within(preview).getByRole("group", { name: "View" })
    expect(within(view).getByRole("button", { name: "Summary" })).toHaveAttribute("aria-pressed", "true")
    expect(within(view).getByRole("button", { name: "In-line" })).toHaveAttribute("aria-pressed", "false")
    const summary = within(preview).getByRole("region", { name: "Summary comment" })
    expect(within(preview).queryByRole("region", { name: "Inline comments" })).not.toBeInTheDocument()
    expect(within(summary).getByRole("heading", { name: "Summary" })).toBeInTheDocument()
    expect(summary).toHaveTextContent("Adds a lookup endpoint.")
    // Sentryward no longer offers to write into the PR/MR description.
    expect(screen.queryByRole("combobox", { name: "Comment location" })).not.toBeInTheDocument()
    // Hidden markers stay hidden, as on the forge.
    expect(preview).not.toHaveTextContent("sentryward:summary")
    expect(within(preview).getByRole("region", { name: "Commit status" })).toHaveTextContent(
      "Failing: 1 finding at or above critical",
    )
    expect(bodies.at(-1)).toMatchObject({ provider: "github", base: { review: { blockOn: "critical" } } })

    const sent = bodies.length
    await choosePreviewView(preview, "In-line")
    expect(within(preview).getByRole("region", { name: "Inline comments" })).toBeInTheDocument()
    expect(within(preview).queryByRole("region", { name: "Summary comment" })).not.toBeInTheDocument()
    expect(within(preview).queryByRole("region", { name: "Commit status" })).not.toBeInTheDocument()
    // Switching views reuses the loaded preview.
    expect(bodies).toHaveLength(sent)
    const suggestion = within(preview).getByRole("group", { name: "Suggested change" })
    expect(suggestion).toHaveTextContent("- const rows = old()")
    expect(suggestion).toHaveTextContent("Commit suggestion")

    await userEvent.click(screen.getByRole("switch", { name: "Post inline comments" }))
    await waitFor(() => expect(within(preview).queryByRole("region", { name: "Inline comments" })).not.toBeInTheDocument())
    expect(bodies.at(-1)?.settings).toEqual({ output: { postInline: false } })
  })

  it("switches the page between GitHub and GitLab", async () => {
    const bodies: PreviewBody[] = []
    mockApi(globalRoutes({ "POST /api/config/preview": previewStub(bodies) }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    const preview = await screen.findByRole("region", { name: "Review preview" })
    await within(preview).findByText("#42")
    // Both forges are on show; one click switches.
    const forge = within(preview).getByRole("group", { name: "Forge" })
    expect(within(forge).getByRole("button", { name: "GitHub" })).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(within(forge).getByRole("button", { name: "GitLab" }))
    expect(within(forge).getByRole("button", { name: "GitLab" })).toHaveAttribute("aria-pressed", "true")

    expect(await within(preview).findByText("!42")).toBeInTheDocument()
    await choosePreviewView(preview, "In-line")
    expect(within(preview).getByRole("group", { name: "Suggested change" })).toHaveTextContent("Apply suggestion")
    expect(bodies.at(-1)?.provider).toBe("gitlab")
  })

  it("offers the agent prompts only while the comment that holds them is posted", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    // Everything is disabled until the config has loaded.
    const perComment = await screen.findByRole("switch", { name: "Prompt for AI agents per comment" })
    await waitFor(() => expect(perComment).toBeEnabled())
    const all = screen.getByRole("switch", { name: "Prompt for all review comments" })
    expect(all).toBeEnabled()

    await userEvent.click(screen.getByRole("switch", { name: "Post inline comments" }))
    expect(perComment).toBeDisabled()
    expect(all).toBeEnabled()
    await userEvent.click(screen.getByRole("switch", { name: "Post summary comment" }))
    expect(all).toBeDisabled()
  })

  it("shows one example inline thread", async () => {
    const second = { ...PREVIEW.inline[0]!, path: "src/api/orders.ts", startLine: 3, endLine: 3 }
    mockApi(globalRoutes({ "POST /api/config/preview": { ...PREVIEW, inline: [...PREVIEW.inline, second] } }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    const preview = await screen.findByRole("region", { name: "Review preview" })
    await within(preview).findByText("#42")
    await choosePreviewView(preview, "In-line")

    expect(within(preview).getAllByRole("group", { name: "Suggested change" })).toHaveLength(1)
    expect(within(preview).getByText("src/api/users.ts")).toBeInTheDocument()
    expect(within(preview).queryByText("src/api/orders.ts")).not.toBeInTheDocument()
    expect(within(preview).getByText(/One example/)).toBeInTheDocument()
  })

  it("says when nothing is posted", async () => {
    mockApi(globalRoutes({ "POST /api/config/preview": { ...PREVIEW, pr: { ...PREVIEW.pr, labels: [] }, ...NOTHING } }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    const preview = await screen.findByRole("region", { name: "Review preview" })
    expect(await within(preview).findByText(/Sentryward posts no summary to the change/)).toBeInTheDocument()
    expect(within(preview).queryByText("No description provided.")).not.toBeInTheDocument()
    await choosePreviewView(preview, "In-line")
    expect(within(preview).getByText("Sentryward posts no inline comments on the diff.")).toBeInTheDocument()
  })

  it("sends the finding settings, and holds the preview while a value is invalid", async () => {
    const bodies: PreviewBody[] = []
    mockApi(globalRoutes({ "POST /api/config/preview": previewStub(bodies) }))
    renderWithProviders(<App />, { route: "/configuration?tab=findings" })

    await userEvent.click(await screen.findByRole("combobox", { name: "Block at or above" }))
    await userEvent.click(screen.getByRole("option", { name: "major" }))
    await userEvent.click(screen.getByRole("switch", { name: "Committable suggestions" }))
    await openTab("Display")
    const preview = screen.getByRole("region", { name: "Review preview" })
    await within(preview).findByText("#42")
    expect(bodies.at(-1)?.settings).toEqual({ review: { blockOn: "major", committableSuggestions: false } })

    await openTab("Finding Types")
    await userEvent.type(screen.getByLabelText("Max findings"), "0")
    await openTab("Display")
    const sent = bodies.length
    expect(
      within(screen.getByRole("region", { name: "Review preview" })).getByText(/Fix the highlighted fields/),
    ).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(bodies).toHaveLength(sent)
  })

  it("resets the global config with an empty object", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "GET /api/config/global": globalConfig(
          { profile: "strict", llm: { connection: "openai" } },
          { profile: "global", "llm.connection": "global" },
        ),
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig())
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await userEvent.click(await screen.findByRole("button", { name: "Reset to defaults" }))

    await waitFor(() => expect(body).toEqual({ settings: { llm: { connection: "openai" } } }))
  })

  it("switches between the global config and a repository on the same tab", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: [repo("r2", "team/api"), repo("r1", "team/web")] },
        "GET /api/repos/r1/config": { ref: "main", repoFile: null, warnings: [], config: effective, sources: {} },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    expect(await screen.findByText(GLOBAL_SCOPE)).toBeInTheDocument()
    await openTab("Files")
    await chooseScope(/team\/web/)

    expect(await screen.findByRole("switch", { name: "Follow global config for team/web" })).toBeInTheDocument()
    expect(screen.queryByText(GLOBAL_SCOPE)).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Files", selected: true })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save settings" })).toBeInTheDocument()

    await chooseScope("All repositories")
    expect(await screen.findByText(GLOBAL_SCOPE)).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Files", selected: true })).toBeInTheDocument()
  })

  it("discards unsaved edits from the save bar", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=files" })

    await userEvent.type(await screen.findByLabelText("Max chunks"), "20")
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Discard" }))

    expect(screen.getByLabelText("Max chunks")).toHaveDisplayValue("")
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument()
  })

  it("asks before leaving the page with unsaved edits", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=files" })

    await userEvent.type(await screen.findByLabelText("Max chunks"), "20")
    await userEvent.click(screen.getByRole("link", { name: "Home" }))

    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Max chunks")).toHaveDisplayValue("20")

    await userEvent.click(screen.getByRole("link", { name: "Home" }))
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard" }))
    expect(screen.queryByLabelText("Max chunks")).not.toBeInTheDocument()
  })

  it("asks before switching scope with unsaved edits, but not between tabs", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: [repo("r1", "team/web")] },
        "GET /api/repos/r1/config": { ref: "main", repoFile: null, warnings: [], config: effective, sources: {} },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=files" })

    await userEvent.type(await screen.findByLabelText("Max chunks"), "20")
    await openTab("Display")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await openTab("Files")

    await chooseScope(/team\/web/)
    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }))
    expect(screen.getByText(GLOBAL_SCOPE)).toBeInTheDocument()
    expect(screen.getByLabelText("Max chunks")).toHaveDisplayValue("20")

    await chooseScope(/team\/web/)
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard" }))
    expect(await screen.findByRole("switch", { name: "Follow global config for team/web" })).toBeInTheDocument()
  })

  it("asks before a link on the same page drops the repository scope", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: [repo("r1", "team/web", { followGlobal: false })] },
        "GET /api/repos/r1/config": { ref: "main", repoFile: null, warnings: [], config: effective, sources: {} },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=files" })

    await userEvent.type(await screen.findByLabelText("Max chunks"), "20")
    await userEvent.click(screen.getByRole("link", { name: "Review settings" }))

    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }))
    expect(screen.getByRole("switch", { name: "Follow global config for team/web" })).toBeInTheDocument()
    expect(screen.getByLabelText("Max chunks")).toHaveDisplayValue("20")
  })

  it("searches the scope list once there are many repositories", async () => {
    const names = ["api", "cli", "docs", "infra", "mobile", "web", "worker"]
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: names.map((name) => repo(name, `team/${name}`)) },
        "GET /api/repos/web/config": { ref: "main", repoFile: null, warnings: [], config: effective, sources: {} },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await userEvent.click(await screen.findByRole("combobox", { name: "Scope" }))
    await userEvent.type(screen.getByPlaceholderText("Search repositories..."), "web")

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["team/webdev"])
    await userEvent.keyboard("{Enter}")

    expect(await screen.findByRole("switch", { name: "Follow global config for team/web" })).toBeInTheDocument()
  })

  it("opens a repository from a ?repo= link and toggles whether it follows the global config", async () => {
    let following = true
    let patched: unknown
    mockApi(
      globalRoutes({
        "GET /api/repos": () => jsonResponse(200, { repos: [repo("r1", "team/web", { followGlobal: following })] }),
        "GET /api/repos/r1/config": { ref: "main", repoFile: null, warnings: [], config: effective, sources: {} },
        "PATCH /api/repos/r1": (init?: RequestInit) => {
          patched = JSON.parse(String(init?.body))
          following = false
          return jsonResponse(200, { repo: repo("r1", "team/web", { followGlobal: false }) })
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=display" })

    const toggle = await screen.findByRole("switch", { name: "Follow global config for team/web" })
    expect(toggle).toBeChecked()
    expect(screen.getByRole("switch", { name: "Post inline comments" })).toBeDisabled()
    await userEvent.click(toggle)

    await waitFor(() => expect(patched).toEqual({ followGlobal: false }))
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(screen.getByRole("switch", { name: "Post inline comments" })).toBeEnabled()
  })

  it("locks a following repository's overrides and saves them once it stops following", async () => {
    let following = true
    let patched: unknown
    mockApi(
      globalRoutes({
        "GET /api/repos": () => jsonResponse(200, { repos: [repo("r1", "team/web", { followGlobal: following })] }),
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: null,
          warnings: [],
          config: effective,
          sources: { "review.blockOn": "global" },
        },
        "PATCH /api/repos/r1": (init?: RequestInit) => {
          const body = JSON.parse(String(init?.body))
          if ("followGlobal" in body) following = body.followGlobal
          else patched = body
          return jsonResponse(200, { repo: repo("r1", "team/web", { followGlobal: following }) })
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await chooseScope(/team\/web/)
    await openTab("Finding Types")
    expect((await screen.findByText("Effective: critical")).parentElement).toHaveTextContent("global")
    await openTab("LLM Config")
    expect(screen.getByLabelText("Model")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled()

    await userEvent.click(screen.getByRole("switch", { name: "Follow global config for team/web" }))
    await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled())
    await userEvent.type(screen.getByLabelText("Model"), "openai/gpt-5")
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }))

    await waitFor(() => expect(patched).toEqual({ settings: { llm: { model: "openai/gpt-5" } } }))
  })

  it("explains inherit in a repository and resets a saved override to the global value", async () => {
    mockApi(
      globalRoutes({
        "GET /api/config/global": globalConfig({}, { "review.blockOn": "global" }),
        "GET /api/repos": {
          repos: [repo("r1", "team/web", { followGlobal: false, settings: { output: { walkthrough: false } } })],
        },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: null,
          warnings: [],
          config: { ...effective, output: { ...effective.output, walkthrough: false } },
          sources: { "output.walkthrough": "repoSettings" },
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=findings" })

    expect(await screen.findByText(/keeps following it when the global config changes/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("combobox", { name: "Block at or above" }))
    expect(screen.getByRole("option", { name: /^Inherit\s*critical \(from global config\)$/ })).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    await openTab("Display")
    const walkthrough = screen.getByRole("switch", { name: "PR summary" })
    expect(walkthrough).not.toBeChecked()
    expect(screen.getByText("Overridden")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset PR summary to inherited" }))

    // Back to what the global config gives, not the saved override.
    expect(walkthrough).toBeChecked()
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled()
  })

  it("tags each effective value with where it comes from, naming the profile", async () => {
    mockApi(
      globalRoutes({
        "GET /api/config/global": globalConfig({}, { "review.blockOn": "profile", "review.severityFloor": "global" }),
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=findings" })

    expect((await screen.findByText("Effective: critical")).parentElement).toHaveTextContent("profile: balanced")
    // What the global config sets itself is already in its input.
    expect(screen.queryByText("Effective: minor")).not.toBeInTheDocument()
  })

  it("locks a field the repository file sets, saying the file wins", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: [repo("r1", "team/web", { followGlobal: false })] },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: ".sentryward.yml",
          warnings: [],
          config: effective,
          sources: { "review.blockOn": "repoFile", "review.severityFloor": "global" },
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=findings" })

    const blockOn = await screen.findByRole("combobox", { name: "Block at or above" })
    await waitFor(() => expect(blockOn).toBeDisabled())
    expect(screen.getByRole("combobox", { name: "Report findings at or above" })).toBeEnabled()
    const tag = screen.getByLabelText("Set in .sentryward.yml, which wins over these settings")
    expect(tag).toHaveTextContent(".sentryward.yml")
  })

  it("greys out the verification and walkthrough models when the repository file turns their feature off", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: [repo("r1", "team/web", { followGlobal: false })] },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: ".sentryward.yml",
          warnings: [],
          config: {
            ...effective,
            review: { ...effective.review, verify: "off" },
            output: { ...effective.output, walkthrough: false },
          },
          sources: { "review.verify": "repoFile", "output.walkthrough": "repoFile" },
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=llm" })

    await waitFor(() => expect(screen.getByLabelText("Verification model")).toBeDisabled())
    expect(screen.getByRole("combobox", { name: "Verification thinking" })).toBeDisabled()
    expect(screen.getByLabelText("PR summary model")).toBeDisabled()
  })

  it("keeps a model field enabled when the repository file turns its feature on over the dashboard", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": {
          repos: [repo("r1", "team/web", { followGlobal: false, settings: { output: { walkthrough: false } } })],
        },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: ".sentryward.yml",
          warnings: [],
          config: { ...effective, output: { ...effective.output, walkthrough: true } },
          sources: { "output.walkthrough": "repoFile" },
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=llm" })

    const walkthroughModel = await screen.findByLabelText("PR summary model")
    await waitFor(() => expect(screen.getByLabelText("Verification model")).toBeEnabled())
    expect(walkthroughModel).toBeEnabled()
    expect(screen.queryByText(/Only used when PR summary is on/)).not.toBeInTheDocument()
  })

  it("shows connection capabilities a repository inherits an override for", async () => {
    mockApi(
      globalRoutes({
        "GET /api/config/global": {
          ...globalConfig({ llm: { connection: "openai", capabilities: { tools: false } } }),
          config: { ...effective, llm: { ...effective.llm, capabilities: { thinking: "auto", tools: false } } },
        },
        "GET /api/repos": { repos: [repo("r1", "team/web", { followGlobal: false })] },
        "GET /api/repos/r1/config": { ref: "main", repoFile: null, warnings: [], config: effective, sources: {} },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=llm" })

    expect(await screen.findByRole("combobox", { name: "Tool support" })).toBeInTheDocument()
  })
})

describe("Team rules", { timeout: 20_000 }, () => {
  const RE2_ERROR = "Not a valid regular expression (backreferences and lookarounds are not supported)"
  // Answers like the server: lookarounds do not compile.
  const checkStub = (checked: string[][]) => (init?: RequestInit) => {
    const { patterns } = JSON.parse(String(init?.body)) as { patterns: string[] }
    checked.push(patterns)
    return jsonResponse(200, { errors: patterns.map((pattern) => (pattern.includes("(?") ? RE2_ERROR : null)) })
  }

  it("adds a rule to the global config, checking its pattern on the server", async () => {
    let body: unknown
    const checked: string[][] = []
    mockApi(
      globalRoutes({
        "GET /api/config/global": globalConfig({ llm: { connection: "openai" } }),
        "POST /api/config/rules/check": checkStub(checked),
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=guidance" })

    await userEvent.click(await screen.findByRole("button", { name: "Add rule" }))
    await userEvent.type(screen.getByLabelText("Rule 1 id"), "no-console")
    await userEvent.type(screen.getByLabelText("Description"), "No console logging in server code.")
    await userEvent.click(screen.getByRole("combobox", { name: "Severity" }))
    await userEvent.click(screen.getByRole("option", { name: "minor" }))
    await userEvent.type(screen.getByLabelText("Paths"), "server/**")
    await userEvent.type(screen.getByLabelText("Pattern"), "console(?=\\.)")

    expect(await screen.findByText(RE2_ERROR)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save global config" })).toBeDisabled()
    expect(screen.getByRole("tab", { name: /Guidance, has errors/ })).toBeInTheDocument()

    await userEvent.clear(screen.getByLabelText("Pattern"))
    await userEvent.type(screen.getByLabelText("Pattern"), "console\\.log")
    await waitFor(() => expect(checked.at(-1)).toEqual(["console\\.log"]))
    expect(screen.queryByText(RE2_ERROR)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({
        settings: {
          llm: { connection: "openai" },
          rules: [
            { id: "no-console", description: "No console logging in server code.", severity: "minor", paths: ["server/**"], pattern: "console\\.log" },
          ],
        },
      }),
    )
  })

  it("shows a repository's inherited and effective rules with their layers, and flags an id it cannot override", async () => {
    const workspaceRule = { id: "no-secrets", description: "Never log secrets.", severity: "critical" }
    const fileRule = { id: "file-rule", description: "From the file.", severity: "major", pattern: "TODO" }
    mockApi(
      globalRoutes({
        "GET /api/config/global": {
          ...globalConfig({ rules: [workspaceRule] }, { "rules.no-secrets": "global" }),
          config: { ...effective, rules: [workspaceRule] },
        },
        "POST /api/config/rules/check": checkStub([]),
        "GET /api/repos": { repos: [repo("r1", "team/web", { followGlobal: false })] },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: ".sentryward.yaml",
          warnings: ["Rule no-secrets in the repository file was ignored: a rule with that id is already set in the global config"],
          config: { ...effective, rules: [workspaceRule, fileRule] },
          sources: { "rules.no-secrets": "global", "rules.file-rule": "repoFile" },
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=guidance" })

    expect(await screen.findByText(/Rule no-secrets in the repository file was ignored/)).toBeInTheDocument()
    expect(screen.getByText(/Added to the global config's rules/)).toBeInTheDocument()
    const inherited = screen.getByText("Inherited").parentElement!
    expect(within(inherited).getByText("no-secrets")).toBeInTheDocument()
    expect(within(inherited).getByText(/critical \(from global config\)/)).toBeInTheDocument()
    const effectiveRules = screen.getByText("Effective").parentElement!
    expect(within(effectiveRules).getByText(/major · pattern \(from repository file\)/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Add rule" }))
    await userEvent.type(screen.getByLabelText("Rule 1 id"), "no-secrets")
    expect(screen.getByText(/The global config already uses this id/)).toBeInTheDocument()
  })
})

describe("Model pickers", () => {
  const openAiModels = { "GET /api/settings/api-keys/openai/models": { models: ["openai/gpt-5", "openai/gpt-5-mini"] } }

  it("offers the selected connection's models for the model and fallback models", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        ...openAiModels,
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig())
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await screen.findByText("Effective: anthropic/claude-sonnet-5-5")
    // No connection yet, so there is nothing to list.
    expect(screen.queryByRole("button", { name: "Choose model from the connection" })).not.toBeInTheDocument()
    await selectOpenAiConnection()

    await userEvent.click(screen.getByRole("button", { name: "Choose model from the connection" }))
    await userEvent.click(await screen.findByRole("option", { name: "openai/gpt-5" }))
    expect(screen.getByLabelText("Model")).toHaveValue("openai/gpt-5")

    await userEvent.click(screen.getByRole("button", { name: "Add fallback model" }))
    await userEvent.click(screen.getByRole("button", { name: "Choose Fallback model 1 from the connection" }))
    await userEvent.click(await screen.findByRole("option", { name: "openai/gpt-5-mini" }))
    expect(screen.getByLabelText("Fallback model 1")).toHaveValue("openai/gpt-5-mini")

    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))
    await waitFor(() =>
      expect(body).toEqual({
        settings: { llm: { model: "openai/gpt-5", fallbackModels: ["openai/gpt-5-mini"], connection: "openai" } },
      }),
    )
  })

  it("still accepts a typed model when the connection's models cannot be loaded", async () => {
    mockApi(
      globalRoutes({
        "GET /api/settings/api-keys/openai/models": () => jsonResponse(400, { message: "Connection failed" }),
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await screen.findByText("Effective: anthropic/claude-sonnet-5-5")
    await selectOpenAiConnection()
    await userEvent.click(screen.getByRole("button", { name: "Choose model from the connection" }))
    expect(await screen.findByText(/Could not load models from this connection/)).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    await userEvent.type(screen.getByLabelText("Model"), "openai/gpt-custom")
    expect(screen.getByLabelText("Model")).toHaveValue("openai/gpt-custom")
  })

  it("warns when an official connection cannot run a model", async () => {
    mockApi(globalRoutes(openAiModels))
    renderWithProviders(<App />, { route: "/configuration" })

    await screen.findByText("Effective: anthropic/claude-sonnet-5-5")
    await selectOpenAiConnection()
    await userEvent.type(screen.getByLabelText("Model"), "anthropic/claude-sonnet-5-5")

    expect(screen.getByText("The OpenAI connection can only run openai/... models.")).toBeInTheDocument()
  })
})

describe("LLM tab", { timeout: 20_000 }, () => {
  // Records each save's body and answers like the server.
  const saving = (bodies: { settings: Record<string, unknown> }[]) => ({
    "PUT /api/config/global": (init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { settings: Record<string, unknown> }
      bodies.push(body)
      return jsonResponse(200, globalConfig(body.settings))
    },
  })

  it("reorders fallback models and saves the new order", async () => {
    const bodies: { settings: Record<string, unknown> }[] = []
    mockApi(globalRoutes(saving(bodies)))
    renderWithProviders(<App />, { route: "/configuration" })

    await selectConnectionOnLlmTab()
    for (const model of ["openai/gpt-5", "openai/gpt-5-mini"]) {
      await userEvent.click(screen.getByRole("button", { name: "Add fallback model" }))
      const rows = screen.getAllByLabelText(/^Fallback model \d$/)
      await userEvent.type(rows.at(-1)!, model)
    }
    expect(screen.queryByRole("button", { name: /^Move fallback model/ })).not.toBeInTheDocument()

    // jsdom lays nothing out, so stack each row by its place in the list; the
    // keyboard sensor moves toward the nearest box.
    const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const item = this.closest("li")
      const index = item ? Array.from(item.parentElement!.children).indexOf(item) : -1
      const top = index < 0 ? 0 : index * 50
      return { x: 0, y: top, left: 0, top, right: 400, bottom: top + 40, width: 400, height: 40, toJSON() {} } as DOMRect
    })
    screen.getByRole("button", { name: "Reorder fallback model 2" }).focus()
    await userEvent.keyboard(" ")
    await userEvent.keyboard("{ArrowUp}")
    await userEvent.keyboard(" ")
    layout.mockRestore()

    expect(screen.getByLabelText("Fallback model 1")).toHaveValue("openai/gpt-5-mini")
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))
    await waitFor(() =>
      expect(bodies.at(-1)?.settings).toMatchObject({ llm: { fallbackModels: ["openai/gpt-5-mini", "openai/gpt-5"] } }),
    )
  })

  it("greys out the verification and walkthrough models while their feature is off, keeping saved values", async () => {
    const bodies: { settings: Record<string, unknown> }[] = []
    const settings = {
      llm: { connection: "openai", verifyModel: "openai/gpt-5-mini", walkthroughModel: "openai/gpt-5" },
      review: { verify: "off" },
    }
    mockApi(globalRoutes({ ...saving(bodies), "GET /api/config/global": globalConfig(settings) }))
    renderWithProviders(<App />, { route: "/configuration" })

    const verifyModel = await screen.findByLabelText("Verification model")
    expect(verifyModel).toBeDisabled()
    expect(verifyModel).toHaveValue("openai/gpt-5-mini")
    expect(screen.getByRole("combobox", { name: "Verification thinking" })).toBeDisabled()
    expect(screen.getAllByText(/Only used when Verify findings is on/)).toHaveLength(2)
    expect(screen.getByLabelText("PR summary model")).toBeEnabled()

    // The hint opens the tab with the setting that turns it on.
    await userEvent.click(screen.getAllByRole("button", { name: "Finding Types tab" })[0]!)
    expect(screen.getByRole("tab", { name: "Finding Types", selected: true })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("combobox", { name: "Verify findings" }))
    await userEvent.click(screen.getByRole("option", { name: "All findings" }))
    await openTab("Display")
    await userEvent.click(screen.getByRole("switch", { name: "PR summary" }))

    await openTab("LLM Config")
    expect(screen.getByLabelText("Verification model")).toBeEnabled()
    expect(screen.getByLabelText("PR summary model")).toBeDisabled()
    expect(screen.getByText(/Only used when PR summary is on/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))
    await waitFor(() =>
      expect(bodies.at(-1)?.settings).toMatchObject({
        llm: { verifyModel: "openai/gpt-5-mini", walkthroughModel: "openai/gpt-5" },
        review: { verify: "all" },
        output: { walkthrough: false },
      }),
    )
  })

  it("shows what was detected for the model and tests it on the connection that runs the review", async () => {
    const tested: unknown[] = []
    mockApi(
      globalRoutes({
        "GET /api/settings/api-keys/openai/capabilities": {
          capabilities: [
            { model: "openai/gpt-5", endpoint: null, thinking: "options", tools: true, source: "probe", detail: null, checkedAt: "2026-10-04T00:00:00Z" },
          ],
        },
        "POST /api/settings/api-keys/openai/test": (init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { model: string }
          tested.push(body)
          return jsonResponse(
            200,
            body.model === "openai/gpt-5"
              ? { result: { ok: true, latencyMs: 840, inputTokens: 10, outputTokens: 2 } }
              : { result: { ok: false, reason: "model", message: "model_not_found" } },
          )
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    // Nothing runs the review yet, so there is nothing to test.
    expect(await screen.findByRole("button", { name: "Test model" })).toBeDisabled()
    await selectOpenAiConnection()
    await userEvent.type(screen.getByLabelText("Model"), "openai/gpt-5")

    expect(await screen.findByTestId("detected-capabilities")).toHaveTextContent(
      "Detected for openai/gpt-5: thinking options, tools work.",
    )
    await userEvent.click(screen.getByRole("button", { name: "Test model" }))
    expect(await screen.findByText("Works: answered in 840 ms.")).toBeInTheDocument()
    expect(tested).toEqual([{ model: "openai/gpt-5" }])

    await userEvent.type(screen.getByLabelText("Model"), "-nope")
    expect(screen.queryByText("Works: answered in 840 ms.")).not.toBeInTheDocument()
    expect(screen.getByTestId("detected-capabilities")).toHaveTextContent("Not detected yet")
    await userEvent.click(screen.getByRole("button", { name: "Test model" }))
    expect(
      await screen.findByText("Failed, the connection cannot run this model: model_not_found"),
    ).toBeInTheDocument()
    // Testing never saves.
    expect(screen.getByRole("button", { name: "Save global config" })).toBeEnabled()
  })

  it("marks a connection that needs attention in the picker", async () => {
    mockApi(globalRoutes({ "GET /api/settings/api-keys/openai/status": { status: "revoked" } }))
    renderWithProviders(<App />, { route: "/configuration" })

    await userEvent.click(await screen.findByRole("combobox", { name: "LLM connection" }))
    expect(await screen.findByRole("option", { name: /OpenAI.*Key rejected/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("option", { name: /OpenAI/ }))
    expect(screen.getByText(/OpenAI: Key rejected\. Reviews on this connection may fail/)).toBeInTheDocument()
  })

  it("shows the model's price and what an auto context budget resolves to, following unsaved edits", async () => {
    mockApi(
      globalRoutes({
        "GET /api/settings/model-prices/lookup?model=anthropic%2Fclaude-sonnet-5-5": {
          model: "anthropic/claude-sonnet-5-5",
          price: { input: 3, output: 15 },
          builtIn: { input: 3, output: 15 },
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    expect(await screen.findByText("$3.00 input / $15.00 output per million tokens.")).toBeInTheDocument()
    // 200,000 less 8,000 max output tokens.
    expect(screen.getByText(/auto = 192,000 tokens/)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText("Max output tokens"), "10000")
    await userEvent.click(screen.getByRole("combobox", { name: "Thinking" }))
    await userEvent.click(screen.getByRole("option", { name: "High (24k tokens)" }))
    expect(screen.getByText(/auto = 166,000 tokens/)).toBeInTheDocument()

    await userEvent.clear(screen.getByLabelText("Context budget"))
    await userEvent.type(screen.getByLabelText("Context budget"), "180000")
    expect(screen.getByText(/so a full chunk can overflow it/)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText("Model"), "openai/custom")
    expect(await screen.findByText(/No price set for this model/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Set model prices" })).toHaveAttribute("href", "/llm-connections")
  })

  it("shows the profile on every tab and keeps connection capabilities under Advanced unless overridden", async () => {
    mockApi(globalRoutes())
    const { unmount } = renderWithProviders(<App />, { route: "/configuration?tab=files" })

    expect(await screen.findByRole("combobox", { name: "Profile" })).toBeInTheDocument()
    // Both apply to every tab, so they share the card above the tabs.
    const scopeCard = screen.getByRole("region", { name: "Scope and profile" })
    expect(within(scopeCard).getByRole("combobox", { name: "Scope" })).toBeInTheDocument()
    expect(within(scopeCard).getByRole("combobox", { name: "Profile" })).toBeInTheDocument()
    await openTab("LLM Config")
    expect(screen.queryByRole("combobox", { name: "Tool support" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }))
    expect(screen.getByRole("combobox", { name: "Tool support" })).toBeInTheDocument()
    unmount()

    mockApi(
      globalRoutes({
        "GET /api/config/global": globalConfig({ llm: { connection: "openai", capabilities: { tools: false } } }),
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })
    const toolSupport = await screen.findByRole("combobox", { name: "Tool support" })

    // Clearing the override leaves the section open rather than collapsing it.
    await userEvent.click(toolSupport)
    await userEvent.click(screen.getByRole("option", { name: "Auto (detected)" }))
    expect(screen.getByRole("combobox", { name: "Tool support" })).toHaveTextContent("Auto (detected)")
  })

  it("lays the tabs out as a side rail and summarizes what will run, following unsaved edits", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration" })

    expect(await screen.findByRole("tablist")).toHaveAttribute("aria-orientation", "vertical")
    const summary = await screen.findByRole("region", { name: "What will run" })
    expect(summary).toHaveTextContent("None selected")
    expect(summary).toHaveTextContent("anthropic/claude-sonnet-5-5")
    // 200,000 less 8,000 max output tokens.
    await waitFor(() => expect(summary).toHaveTextContent("192,000 tokens (auto)"))
    expect(within(summary).queryByRole("list", { name: "Fallback order" })).not.toBeInTheDocument()

    await selectOpenAiConnection()
    await userEvent.type(screen.getByLabelText("Model"), "openai/gpt-5")
    await userEvent.click(screen.getByRole("button", { name: "Add fallback model" }))
    await userEvent.type(screen.getByLabelText("Fallback model 1"), "openai/gpt-5-mini")

    expect(summary).toHaveTextContent("OpenAI")
    expect(summary).toHaveTextContent("openai/gpt-5")
    expect(within(summary).getByRole("list", { name: "Fallback order" })).toHaveTextContent("openai/gpt-5-mini")
    expect(within(summary).getByRole("button", { name: "Test model" })).toBeEnabled()
  })

  it("greys out the temperature while thinking is on", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration" })

    const temperature = await screen.findByLabelText("Temperature")
    expect(temperature).toBeEnabled()

    await userEvent.click(screen.getByRole("combobox", { name: "Thinking" }))
    await userEvent.click(screen.getByRole("option", { name: "High (24k tokens)" }))
    expect(screen.getByLabelText("Temperature")).toBeDisabled()
    expect(screen.getByText("Thinking is on, so the temperature is not sent.")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("combobox", { name: "Thinking" }))
    await userEvent.click(screen.getByRole("option", { name: "Off" }))
    expect(screen.getByLabelText("Temperature")).toBeEnabled()
  })
})

describe("Finding Types tab", { timeout: 20_000 }, () => {
  it("summarises the tab with unsaved edits and draws the severity scale", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=findings" })

    const summary = await screen.findByRole("region", { name: "Findings summary" })
    const scale = await within(summary).findByRole("list", { name: "Severity scale" })
    // Floor minor, block critical: critical blocks, the rest is reported.
    expect(within(scale).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "critical: Blocks",
      "major: Reported",
      "minor: Reported",
    ])
    expect(within(summary).getByText("2 of 3")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("combobox", { name: "Block at or above" }))
    await userEvent.click(screen.getByRole("option", { name: "major" }))
    expect(within(scale).getAllByRole("listitem")[1]).toHaveTextContent("major: Blocks")
  })

  it("warns when the block level is under the report level", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=findings" })

    await userEvent.click(await screen.findByRole("combobox", { name: "Report findings at or above" }))
    await userEvent.click(screen.getByRole("option", { name: "critical" }))
    await userEvent.click(screen.getByRole("combobox", { name: "Block at or above" }))
    await userEvent.click(screen.getByRole("option", { name: "minor" }))

    // Under the floor a finding is dropped, so it shows as hidden, not blocking.
    const summary = screen.getByRole("region", { name: "Findings summary" })
    expect(within(summary).getAllByRole("listitem").at(-1)).toHaveTextContent("minor: Hidden")
    expect(screen.getAllByText(/Blocking starts at critical/)).toHaveLength(2)
  })

  it("greys out the agent limits unless context is agentic, and caller depth without surrounding code", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=findings" })

    const steps = await screen.findByLabelText("Agent steps")
    await waitFor(() => expect(steps).toBeDisabled())
    await userEvent.click(screen.getByRole("combobox", { name: "Review context" }))
    await userEvent.click(screen.getByRole("option", { name: "Agentic" }))
    expect(steps).toBeEnabled()
    expect(screen.getByLabelText("Agent searches")).toBeEnabled()

    expect(screen.getByLabelText("Caller depth")).toBeEnabled()
    await userEvent.click(screen.getByRole("switch", { name: "Surrounding code" }))
    expect(screen.getByLabelText("Caller depth")).toBeDisabled()
  })

  it("selects all or no categories, counting what is on", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=findings" })

    expect(await screen.findByText("2 of 3 on")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "All" }))
    expect(screen.getByText("3 of 3 on")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "style" })).toBeChecked()
    expect(screen.getByRole("button", { name: "All" })).toBeDisabled()

    await userEvent.click(screen.getByRole("button", { name: "None" }))
    expect(screen.getByText("0 of 3 on")).toBeInTheDocument()
    expect(screen.getByText("Choose at least one category")).toBeInTheDocument()
  })

  it("keeps the confidence slider in step with the input", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=findings" })

    const slider = await screen.findByRole("slider", { name: "Min confidence slider" })
    await waitFor(() => expect(slider).toHaveValue("0.5"))
    await userEvent.type(screen.getByLabelText("Min confidence"), "0.8")
    expect(slider).toHaveValue("0.8")
  })
})

describe("Triggers tab", { timeout: 20_000 }, () => {
  it("summarises when Sentryward runs, following unsaved edits", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=triggers" })

    const summary = await screen.findByRole("region", { name: "Triggers summary" })
    await waitFor(() => expect(within(summary).getByText("Published, drafts wait")).toBeInTheDocument())
    expect(within(summary).getByText("0 rules")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("switch", { name: "Full review on push" }))
    await userEvent.type(screen.getByLabelText("Ignore by title"), "WIP{enter}")
    expect(within(summary).getByText("Every file")).toBeInTheDocument()
    expect(within(summary).getByText("1 rule")).toBeInTheDocument()
    expect(within(summary).getByText("WIP", { exact: false })).toBeInTheDocument()
  })

  it("greys out what automatic reviews use while they are off", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=triggers" })

    const push = await screen.findByRole("switch", { name: "Review automatically on push" })
    await waitFor(() => expect(push).toBeEnabled())
    expect(screen.getByLabelText("Skip by label")).toBeEnabled()

    await userEvent.click(screen.getByRole("combobox", { name: "Code review trigger" }))
    await userEvent.click(screen.getByRole("option", { name: "Manual only" }))
    expect(push).toBeDisabled()
    expect(screen.getByRole("switch", { name: "Full review on push" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "PR summary trigger" })).toBeDisabled()
    for (const name of ["Ignore by title", "Skip by author", "Skip by label", "Skip by source branch", "Skip by target branch"]) {
      expect(screen.getByLabelText(name)).toBeDisabled()
    }
    expect(screen.getByText("Only used for automatic reviews, which are off.")).toBeInTheDocument()
    // Commands are not automatic reviews.
    expect(screen.getByRole("switch", { name: "Allow review command" })).toBeEnabled()
  })

  it("greys out the PR summary trigger while the walkthrough is off, linking to Display", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    await userEvent.click(await screen.findByRole("switch", { name: "PR summary" }))
    await openTab("Triggers")
    expect(screen.getByRole("combobox", { name: "PR summary trigger" })).toBeDisabled()
    expect(screen.getByText(/Only used when PR summary is on/)).toBeInTheDocument()
    expect(within(screen.getByRole("region", { name: "Triggers summary" })).getByText("Off, PR summary is off")).toBeInTheDocument()
  })

  it("checks a sample change against the unsaved settings", async () => {
    const bodies: Record<string, unknown>[] = []
    mockApi(
      globalRoutes({
        "POST /api/config/triggers/check": (init?: RequestInit) => {
          const body = JSON.parse(String(init?.body))
          bodies.push(body)
          const skipped = body.change.labels.includes("no-review")
          return jsonResponse(200, skipped ? { reason: 'The change has the label "no-review"', fullReview: false, walkthrough: false } : REVIEWED)
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=triggers" })

    const check = await screen.findByRole("region", { name: "Triggers summary" })
    await userEvent.click(within(check).getByRole("button", { name: "Will this be reviewed?" }))
    expect(await within(check).findByText("Reviewed")).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText("Skip by label"), "no-review{enter}")
    await userEvent.type(within(check).getByLabelText("Labels"), "no-review{enter}")
    expect(await within(check).findByText(/The change has the label "no-review"/)).toBeInTheDocument()
    expect(bodies.at(-1)).toMatchObject({
      event: "opened",
      settings: { triggers: { skipLabels: ["no-review"] } },
      change: { labels: ["no-review"], headRef: "feature/login", baseRef: "main", isDraft: false },
    })
  })

  it("hides the sample check until asked, keeping the sample between toggles", async () => {
    let checks = 0
    mockApi(
      globalRoutes({
        "POST /api/config/triggers/check": () => {
          checks++
          return jsonResponse(200, REVIEWED)
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=triggers" })

    const summary = await screen.findByRole("region", { name: "Triggers summary" })
    const toggle = within(summary).getByRole("button", { name: "Will this be reviewed?" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(within(summary).queryByLabelText("Labels")).not.toBeInTheDocument()
    expect(within(summary).getByText("Check a sample change against these settings.")).toBeInTheDocument()
    // Give a debounced check time to fire, had one been asked for.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(checks).toBe(0)

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(await within(summary).findByText("Reviewed")).toBeInTheDocument()
    expect(checks).toBeGreaterThan(0)

    const title = within(summary).getByLabelText("Title")
    await userEvent.clear(title)
    await userEvent.type(title, "WIP: login")
    await userEvent.click(toggle)
    expect(within(summary).queryByLabelText("Title")).not.toBeInTheDocument()
    await userEvent.click(toggle)
    expect(within(summary).getByLabelText("Title")).toHaveValue("WIP: login")
  })

  it("tags how each skip list matches", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=triggers" })

    await screen.findByLabelText("Skip by label")
    expect(screen.getByText("exact, case-sensitive")).toBeInTheDocument()
    expect(screen.getByText("contains, any case")).toBeInTheDocument()
    expect(screen.getByText("exact, any case")).toBeInTheDocument()
    expect(screen.getAllByText("contains")).toHaveLength(2)
  })

  it("says a repository's list replaces the inherited one", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: [repo("r1", "team/web", { followGlobal: false })] },
        // What a repository inherits is the global config's effective config.
        "GET /api/config/global": {
          ...globalConfig({ triggers: { skipLabels: ["no-review"] } }),
          config: { ...effective, triggers: { ...effective.triggers, skipLabels: ["no-review"] } },
        },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: null,
          warnings: [],
          config: { ...effective, triggers: { ...effective.triggers, skipLabels: ["no-review"] } },
          sources: {},
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=triggers" })

    const labels = await screen.findByLabelText("Skip by label")
    await waitFor(() => expect(labels).toBeEnabled())
    expect(screen.queryByText(/Replaces the inherited list/)).not.toBeInTheDocument()
    await userEvent.type(labels, "wip{enter}")
    expect(screen.getByText("Replaces the inherited list: no-review.")).toBeInTheDocument()
  })
})

describe("Display tab", { timeout: 20_000 }, () => {
  async function openDisplay() {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=display" })
    // Everything is disabled until the config has loaded.
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show finding counts" })).toBeEnabled())
  }

  it("nests each dependent setting under its parent and says which one turns it on", async () => {
    await openDisplay()

    const parents = [
      ["Post inline comments", ["Prompt for AI agents per comment", "Resolve fixed threads"]],
      [
        "Post summary comment",
        ["Only when there are findings", "Show finding counts", "Show changes since the last review", "Show review details", "Prompt for all review comments"],
      ],
      ["PR summary", ["Show labels in the summary", "Show review effort in the summary", "Publish blast radius label"]],
    ] as const
    for (const [parent, children] of parents) {
      for (const name of children) {
        const child = screen.getByRole("switch", { name })
        expect(child).toBeEnabled()
        expect(child).not.toHaveAccessibleDescription()
        // Indented in the same list as its parent.
        const list = screen.getByRole("switch", { name: parent }).closest(".divide-y")
        expect(child.closest(".border-l-2")?.closest(".divide-y")).toBe(list)
      }
      await userEvent.click(screen.getByRole("switch", { name: parent }))
      for (const name of children) {
        const child = screen.getByRole("switch", { name })
        expect(child).toBeDisabled()
        expect(child).toHaveAccessibleDescription(`Needs ${parent}`)
      }
    }
    // The parent is on this tab, so there is no tab to link to.
    expect(screen.queryByRole("button", { name: "Display tab" })).not.toBeInTheDocument()
  })

  it("limits inline comments by severity and count, and saves them with summary only with findings", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=display" })
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show finding counts" })).toBeEnabled())
    const view = within(screen.getByRole("region", { name: "Review preview" })).getByRole("group", { name: "View" })
    const pressed = () => within(view).getByRole("button", { pressed: true })

    // Both limits sit under inline comments and need them.
    const severity = screen.getByRole("combobox", { name: "Inline comments from" })
    const cap = screen.getByLabelText("Max inline comments")
    expect(severity).toBeEnabled()
    await userEvent.click(screen.getByRole("switch", { name: "Post inline comments" }))
    expect(screen.getByRole("combobox", { name: "Inline comments from" })).toBeDisabled()
    expect(screen.getByLabelText("Max inline comments")).toBeDisabled()
    await userEvent.click(screen.getByRole("switch", { name: "Post inline comments" }))

    // Each shows up in the inline thread.
    await userEvent.click(screen.getByRole("switch", { name: "Show finding counts" }))
    expect(pressed()).toHaveTextContent("Summary")
    await userEvent.click(screen.getByRole("combobox", { name: "Inline comments from" }))
    await userEvent.click(screen.getByRole("option", { name: "Major and above" }))
    expect(pressed()).toHaveTextContent("In-line")
    await userEvent.click(screen.getByRole("switch", { name: "Show finding counts" }))
    await userEvent.type(cap, "5")
    expect(pressed()).toHaveTextContent("In-line")
    await userEvent.click(screen.getByRole("switch", { name: "Only when there are findings" }))

    await selectConnectionOnLlmTab()
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))
    await waitFor(() =>
      expect(body).toEqual({
        settings: {
          llm: { connection: "openai" },
          output: { inlineMinSeverity: "major", maxInlineComments: 5, summaryOnlyWithFindings: true },
        },
      }),
    )
  })

  it("groups the effort and blast radius text beside their labels", async () => {
    await openDisplay()

    const effort = screen.getByRole("group", { name: "Effort" })
    expect(within(effort).getAllByRole("switch").map((item) => item.getAttribute("id"))).toEqual([
      "flag-estimateEffort",
      "flag-effortLabel",
    ])
    const blast = screen.getByRole("group", { name: "Blast radius" })
    expect(within(blast).getAllByRole("switch").map((item) => item.getAttribute("id"))).toEqual([
      "flag-walkthroughBlastRadius",
      "flag-blastRadiusLabel",
    ])
    expect(screen.getByText(/native labels only need the PR summary/)).toBeInTheDocument()
    // Each optional part says what it adds to the model call.
    const content = screen.getByRole("group", { name: "PR summary content" })
    expect(within(content).getAllByText("Longer prompt")).toHaveLength(2)
    expect(within(content).getByText("More output")).toBeInTheDocument()
    expect(within(effort).getByText("No extra cost")).toBeInTheDocument()
  })

  it("says when the PR summary is posted on its own, and when nothing is posted at all", async () => {
    await openDisplay()
    const standalone = /PR summary is still posted, as a comment of its own/
    const nothing = /Sentryward will post nothing to the PR\/MR/
    expect(screen.queryByText(standalone)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("switch", { name: "Post summary comment" }))
    expect(screen.getByText(standalone)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("switch", { name: "Post inline comments" }))
    // The commit status is off by default. The PR summary still reaches the change.
    expect(screen.getByRole("switch", { name: "Post commit status" })).not.toBeChecked()
    expect(screen.queryByText(nothing)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("switch", { name: "PR summary" }))
    expect(screen.queryByText(standalone)).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(nothing)
    await userEvent.click(screen.getByRole("switch", { name: "Post commit status" }))
    expect(screen.queryByText(nothing)).not.toBeInTheDocument()
  })

  it("warns that nothing is posted when the values are inherited", async () => {
    const off = { postInline: false, postSummary: false, postCheck: false, walkthrough: false }
    mockApi(
      globalRoutes({
        "GET /api/config/global": { ...globalConfig(off), config: { ...effective, output: { ...effective.output, ...off } } },
        "GET /api/repos": { repos: [repo("r1", "team/web", { followGlobal: false })] },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: null,
          warnings: [],
          config: { ...effective, output: { ...effective.output, ...off } },
          sources: {},
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=display" })

    expect(await screen.findByText(/Sentryward will post nothing to the PR\/MR/)).toBeInTheDocument()
  })

  it("leaves out the hint when the repository file locks the field anyway", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: [repo("r1", "team/web", { followGlobal: false, settings: { output: { postSummary: false } } })] },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: ".sentryward.yml",
          warnings: [],
          config: { ...effective, output: { ...effective.output, postSummary: false } },
          sources: { "output.postSummary": "repoSettings", "output.findingCounts": "repoFile" },
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=display" })

    const details = await screen.findByRole("switch", { name: "Show review details" })
    await waitFor(() => expect(details).toHaveAccessibleDescription("Needs Post summary comment"))
    const counts = screen.getByRole("switch", { name: "Show finding counts" })
    expect(counts).toBeDisabled()
    expect(counts).not.toHaveAccessibleDescription()
  })

  it("switches the preview to the view the changed setting shows up in", async () => {
    await openDisplay()
    const view = within(screen.getByRole("region", { name: "Review preview" })).getByRole("group", { name: "View" })
    const pressed = () => within(view).getByRole("button", { pressed: true })
    expect(pressed()).toHaveTextContent("Summary")

    await userEvent.click(screen.getByRole("switch", { name: "Prompt for AI agents per comment" }))
    expect(pressed()).toHaveTextContent("In-line")
    await userEvent.click(screen.getByRole("switch", { name: "Show finding counts" }))
    expect(pressed()).toHaveTextContent("Summary")

    // A view picked by hand stays until the next change.
    await userEvent.click(within(view).getByRole("button", { name: "In-line" }))
    expect(pressed()).toHaveTextContent("In-line")
    await userEvent.click(screen.getByRole("switch", { name: "Resolve fixed threads" }))
    expect(pressed()).toHaveTextContent("In-line")
    await userEvent.click(screen.getByRole("switch", { name: "Show review details" }))
    expect(pressed()).toHaveTextContent("Summary")
  })

  // Answers like the server for the switches below: the counts line, the
  // combined prompt and the blast radius label come and go with them.
  function changingStub(bodies: PreviewBody[] = []) {
    return (init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as PreviewBody
      bodies.push(body)
      const output = { ...(body.base.output as object), ...(body.settings.output as object) } as Record<string, boolean>
      const summaryComment = [
        "## Summary",
        "Adds a lookup endpoint.",
        ...(output.findingCounts ? ["**1 finding**: 1 critical"] : []),
        "<details>\n<summary>Actionable comments (1)</summary>",
        ["- SQL", ...(output.agentPromptAll ? ["- Prompt for all review comments"] : [])].join("\n"),
        "</details>",
      ].join("\n\n")
      return jsonResponse(200, {
        ...PREVIEW,
        provider: body.provider,
        pr: { ...PREVIEW.pr, labels: ["Medium blast radius", ...(output.blastRadiusLabel ? ["Large blast radius"] : [])] },
        summaryComment,
      })
    }
  }
  const changed = (root: HTMLElement) => Array.from(root.querySelectorAll("[data-preview-change]"))

  it("marks only what a setting adds, and what it takes out before it goes", async () => {
    mockApi(globalRoutes({ "POST /api/config/preview": changingStub() }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })
    const preview = await screen.findByRole("region", { name: "Review preview" })
    const summary = await within(preview).findByRole("region", { name: "Summary comment" })
    await within(summary).findByText("Adds a lookup endpoint.")
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show finding counts" })).toBeEnabled())
    // Off by default.
    expect(within(summary).queryByText("1 finding")).not.toBeInTheDocument()
    expect(changed(preview)).toEqual([])

    // A line put in is the only thing marked, at once, not its comment.
    await userEvent.click(screen.getByRole("switch", { name: "Show finding counts" }))
    const counts = (await within(summary).findByText("1 finding")).closest("p")!
    await waitFor(() => expect(changed(preview)).toEqual([counts]))
    expect(counts).toHaveAttribute("data-preview-change", "added")
    // The highlight goes after a moment.
    await waitFor(() => expect(changed(preview)).toEqual([]), { timeout: 3000 })

    // Taken out again, the line stays marked as leaving, and nothing else is.
    await userEvent.click(screen.getByRole("switch", { name: "Show finding counts" }))
    await waitFor(() => expect(changed(preview)).toEqual([counts]))
    expect(counts).toHaveAttribute("data-preview-change", "removed")
    expect(summary).toContainElement(counts)
    // Then it goes, without anything marked as added.
    await waitFor(() => expect(within(summary).queryByText("1 finding")).not.toBeInTheDocument(), { timeout: 3000 })
    expect(changed(preview)).toEqual([])
  })

  it("marks the one item leaving a collapsed block, and a label coming and going", async () => {
    mockApi(globalRoutes({ "POST /api/config/preview": changingStub() }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })
    const preview = await screen.findByRole("region", { name: "Review preview" })
    const item = (await within(preview).findByText("Prompt for all review comments")).closest("li")!
    await waitFor(() => expect(screen.getByRole("switch", { name: "Prompt for all review comments" })).toBeEnabled())

    await userEvent.click(screen.getByRole("switch", { name: "Prompt for all review comments" }))
    await waitFor(() => expect(changed(preview)).toEqual([item]))
    expect(item).toHaveAttribute("data-preview-change", "removed")
    await waitFor(() => expect(within(preview).queryByText("Prompt for all review comments")).not.toBeInTheDocument(), {
      timeout: 3000,
    })

    await userEvent.click(screen.getByRole("switch", { name: "Publish blast radius label" }))
    const label = await within(preview).findByText("Large blast radius")
    await waitFor(() => expect(changed(preview)).toEqual([label]))
    expect(label).toHaveAttribute("data-preview-change", "added")
    expect(within(preview).getByText("Medium blast radius")).not.toHaveAttribute("data-preview-change")

    await userEvent.click(screen.getByRole("switch", { name: "Publish blast radius label" }))
    await waitFor(() => expect(within(preview).getByText("Large blast radius")).toHaveAttribute("data-preview-change", "removed"))
    await waitFor(() => expect(within(preview).queryByText("Large blast radius")).not.toBeInTheDocument(), { timeout: 3000 })
  })

  it("highlights nothing when the forge is switched", async () => {
    const bodies: PreviewBody[] = []
    mockApi(globalRoutes({ "POST /api/config/preview": changingStub(bodies) }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })
    const preview = await screen.findByRole("region", { name: "Review preview" })
    await within(preview).findByText("#42")

    await userEvent.click(within(within(preview).getByRole("group", { name: "Forge" })).getByRole("button", { name: "GitLab" }))
    expect(await within(preview).findByText("!42")).toBeInTheDocument()
    expect(bodies.at(-1)?.provider).toBe("gitlab")
    expect(changed(preview)).toEqual([])
  })

  it("hides the preview and remembers it in this browser", async () => {
    await openDisplay()
    try {
      await userEvent.click(screen.getByRole("button", { name: "Hide preview" }))
      expect(screen.queryByRole("region", { name: "Review preview" })).not.toBeInTheDocument()
      expect(localStorage.getItem("sentryward-config-preview")).toBe("hidden")

      await userEvent.click(screen.getByRole("button", { name: "Show preview" }))
      expect(screen.getByRole("region", { name: "Review preview" })).toBeInTheDocument()
      // The scroll area inside the pinned card is reachable from the keyboard.
      expect(screen.getByRole("region", { name: "Preview content" })).toHaveAttribute("tabindex", "0")
      expect(localStorage.getItem("sentryward-config-preview")).toBeNull()
    } finally {
      localStorage.removeItem("sentryward-config-preview")
    }
  })

  it("counts the summary instructions and fills in an example only when asked", async () => {
    await openDisplay()
    // Off by default, which greys the instructions out.
    await userEvent.click(screen.getByRole("switch", { name: "High-level summary" }))
    const field = screen.getByLabelText("High level summary instructions")
    const count = screen.getByTestId("summary-instructions-count")
    expect(count).toHaveTextContent("0 / 2000")

    await userEvent.click(screen.getByRole("button", { name: "Use the Release notes example" }))
    expect((field as HTMLTextAreaElement).value).toMatch(/^Write release notes/)
    expect(count).not.toHaveTextContent("0 / 2000")

    // Typed text is only replaced after a confirm.
    await userEvent.clear(field)
    await userEvent.type(field, "Mine")
    expect(count).toHaveTextContent("4 / 2000")
    await userEvent.click(screen.getByRole("button", { name: "Use the Changelog entry example" }))
    expect(field).toHaveValue("Mine")
    const confirm = screen.getByRole("group", { name: "Replace instructions" })
    await userEvent.click(within(confirm).getByRole("button", { name: "Keep mine" }))
    expect(field).toHaveValue("Mine")
    await userEvent.click(screen.getByRole("button", { name: "Use the Changelog entry example" }))
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    expect((field as HTMLTextAreaElement).value).toMatch(/^Write one changelog entry/)

    await userEvent.clear(field)
    await userEvent.click(field)
    await userEvent.paste("x".repeat(2001))
    expect(count).toHaveTextContent("2001 / 2000")
    expect(count).toHaveClass("text-destructive")
    expect(screen.getByText("At most 2000 characters")).toBeInTheDocument()
  })

  it("applies a display preset to the form without saving it", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=display" })
    const presets = await screen.findByRole("group", { name: "Display preset" })
    // The defaults are the Standard preset.
    await waitFor(() => expect(within(presets).getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "true"))

    await userEvent.click(within(presets).getByRole("button", { name: "Minimal" }))
    expect(within(presets).getByRole("button", { name: "Minimal" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("switch", { name: "Post inline comments" })).toBeChecked()
    expect(screen.getByRole("switch", { name: "Resolve fixed threads" })).toBeChecked()
    for (const name of ["Post summary comment", "Post commit status", "PR summary", "Prompt for AI agents per comment"]) {
      expect(screen.getByRole("switch", { name })).not.toBeChecked()
    }
    // Quiet even if the summary comment is turned back on.
    expect(screen.getByRole("switch", { name: "Only when there are findings" })).toBeChecked()
    // A manual change leaves the preset.
    await userEvent.click(screen.getByRole("switch", { name: "Post commit status" }))
    expect(within(presets).queryByRole("button", { pressed: true })).not.toBeInTheDocument()

    await userEvent.click(within(presets).getByRole("button", { name: "Everything" }))
    expect(screen.getByRole("switch", { name: "Publish blast radius label" })).toBeChecked()
    // Everything posts the most, so the switch that posts less stays off.
    expect(screen.getByRole("switch", { name: "Only when there are findings" })).not.toBeChecked()
    expect(screen.getByRole("switch", { name: "Publish review time estimate label" })).toBeChecked()
    await selectConnectionOnLlmTab()
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    // Only what differs from the defaults is saved.
    await waitFor(() =>
      expect(body).toEqual({
        settings: {
          llm: { connection: "openai" },
          output: {
            postCheck: true,
            findingCounts: true,
            findingLifecycle: true,
            reviewStats: true,
            blastRadiusLabel: true,
            effortLabel: true,
            sequenceDiagrams: true,
            estimateEffort: true,
            assessLinkedIssues: true,
            highLevelSummary: true,
            walkthroughLabels: true,
          },
        },
      }),
    )
  })

  it("lifts the inline limits with Everything, and only then shows it as picked", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=display" })
    const presets = await screen.findByRole("group", { name: "Display preset" })
    await waitFor(() => expect(within(presets).getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "true"))

    await userEvent.click(within(presets).getByRole("button", { name: "Everything" }))
    expect(within(presets).getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true")
    // A cap is a limit Everything does not have.
    await userEvent.type(screen.getByLabelText("Max inline comments"), "{selectall}1")
    expect(within(presets).queryByRole("button", { pressed: true })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("combobox", { name: "Inline comments from" }))
    await userEvent.click(screen.getByRole("option", { name: "Critical only" }))

    await userEvent.click(within(presets).getByRole("button", { name: "Everything" }))
    expect(within(presets).getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByLabelText("Max inline comments")).toHaveValue("none")
    expect(screen.getByRole("combobox", { name: "Inline comments from" })).toHaveTextContent("Every severity")
  })

  it("says in the preview that a clean review posts no summary comment", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=display" })
    await waitFor(() => expect(screen.getByRole("switch", { name: "Only when there are findings" })).toBeEnabled())
    const note = /A completed review with no findings starts no summary comment/
    expect(screen.queryByText(note)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("switch", { name: "Only when there are findings" }))
    expect(screen.getByText(note)).toBeInTheDocument()
  })

  it("leaves fields the repository file sets alone when applying a preset", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: [repo("r1", "team/web", { followGlobal: false })] },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: ".sentryward.yml",
          warnings: [],
          config: { ...effective, output: { ...effective.output, postCheck: true } },
          sources: { "output.postCheck": "repoFile" },
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=display" })
    const presets = await screen.findByRole("group", { name: "Display preset" })
    await waitFor(() => expect(within(presets).getByRole("button", { name: "Minimal" })).toBeEnabled())

    await userEvent.click(within(presets).getByRole("button", { name: "Minimal" }))
    expect(screen.getByRole("switch", { name: "Post summary comment" })).not.toBeChecked()
    expect(screen.getByRole("button", { name: "Reset Post summary comment to inherited" })).toBeInTheDocument()
    // The file's field stays locked and gets no override.
    expect(screen.getByRole("switch", { name: "Post commit status" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Reset Post commit status to inherited" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled()
  })
})
