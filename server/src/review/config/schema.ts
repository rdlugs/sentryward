import RE2 from "re2";
import { z } from "zod";
import { categorySchema, severitySchema } from "../core/severity.ts";

export const PROFILE_NAMES = ["balanced", "fast", "strict", "security"] as const;
export const profileNameSchema = z.enum(PROFILE_NAMES);
export type ProfileName = z.infer<typeof profileNameSchema>;

// Field shapes are declared once, without defaults: the full schema validates a
// merged config, and the override schema validates one layer of it. Defaults
// live in DEFAULT_CONFIG so a layer never fills in fields it did not set.
// There is deliberately no API key or token here. Endpoints exist only in the
// dashboard layers (see dashboardOverrideSchema): a repository file must never
// be able to point Sentryward's credentials somewhere else.
// The model id may itself contain slashes and parentheses, as router ids such
// as "openai/cx/gpt-5.6-sol(medium)" do; the provider is what precedes the first slash.
const modelString = z
  .string()
  .regex(/^(anthropic|openai|google|ollama)\/[\w.:()/-]+$/, 'Use "provider/model", e.g. anthropic/claude-sonnet-5-5');

// Extended thinking per call. Each level maps onto the provider's own option
// (llm/thinking.ts); whether it is sent depends on what the endpoint supports.
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
const thinkingLevel = z.enum(THINKING_LEVELS);

const llmShape = {
  model: modelString,
  fallbackModels: z.array(modelString).max(3),
  // Per-purpose models; null uses `model`. The fallbacks are shared, so a
  // cheaper walkthrough or stronger verifier still has somewhere to go.
  walkthroughModel: modelString.nullable(),
  verifyModel: modelString.nullable(),
  temperature: z.number().min(0).max(1),
  maxTokens: z.number().int().min(1000).max(64000),
  // Prompt token ceiling; null derives it from the model's context window.
  contextBudget: z.number().int().min(4000).nullable(),
  // For review passes; the walkthrough always runs without it.
  thinking: thinkingLevel,
  // For verification; null uses `thinking`.
  verifyThinking: thinkingLevel.nullable(),
};

// What the selected connection's models support, when the user knows better
// than detection does. "auto" uses what probes and earlier calls recorded
// (llm/capabilities.ts). Dashboard only: a repository file must not change how
// credentials and endpoints are used.
export const THINKING_SUPPORT_SETTINGS = ["auto", "options", "model", "none"] as const;
const capabilitiesShape = {
  // options: send the provider's thinking options; model: the model id itself
  // thinks (only the output budget changes); none: never think.
  thinking: z.enum(THINKING_SUPPORT_SETTINGS),
  tools: z.union([z.literal("auto"), z.boolean()]),
};

// Settable only from the dashboard, never from a repository file or a trigger.
const dashboardLlmShape = {
  ...llmShape,
  // A live reference to one of the owner's saved provider connections. The
  // worker resolves its current key and host when the review runs.
  connection: z.enum(["anthropic", "openai", "google", "ollama"]).nullable(),
  // Legacy endpoint fields remain readable so settings saved by an older
  // release keep working until the dashboard writes the new connection field.
  // One endpoint, such as a 9router proxy, for every model call; null means
  // each provider's official API. The model's provider prefix still picks the
  // wire format.
  baseUrl: z.url({ protocol: /^https?$/, error: "Enter an http or https URL" }).max(500).nullable(),
  // Which stored provider key is sent to baseUrl; null sends each model's own
  // provider key. Names a key slot, never holds the key.
  endpointKey: z.enum(["anthropic", "openai", "google", "ollama"]).nullable(),
  capabilities: z.strictObject(capabilitiesShape),
};

export const VERIFY_MODES = ["off", "blocking", "all"] as const;
export const CONTEXT_MODES = ["static", "agentic"] as const;

// Caps on one agentic pass (review.context: agentic).
const agentShape = {
  // Model calls per pass, the forced final report included.
  maxSteps: z.number().int().min(2).max(20),
  // Tokens the tools may return in one pass before they ask for the report.
  maxToolTokens: z.number().int().min(1000).max(100_000),
  // Code searches across the whole review: GitHub rate-limits search hard.
  maxSearches: z.number().int().min(0).max(10),
};

const reviewShape = {
  categories: z.array(categorySchema).min(1),
  // What is reported at all.
  severityFloor: severitySchema,
  // What fails the verdict and the commit status. Not the same as the floor.
  blockOn: severitySchema,
  maxFindings: z.number().int().min(1).max(100),
  maxChunks: z.number().int().min(1).max(50),
  minConfidence: z.number().min(0).max(1),
  // A critical or major model finding without evidence is demoted, not blocking.
  requireEvidence: z.boolean(),
  // Feed back findings this team dismissed as false positives or intentional:
  // an ignored finding is never reposted on the same change, and recent repo
  // ignores are listed in the prompt so the model does not raise them again.
  suppressIgnored: z.boolean(),
  // Allow findings on lines the change did not touch.
  fullFile: z.boolean(),
  committableSuggestions: z.boolean(),
  // Fetch the change and repository file fresh instead of reusing what an
  // earlier run in the same worker already fetched.
  disableCache: z.boolean(),
  // Show each pass the enclosing scope, imports, definitions and callers of
  // the changed code, read from the head revision, next to the diff.
  fileContext: z.boolean(),
  // How many hops of callers that context follows from a changed name: 1 is
  // its direct callers, 2 also the callers of those. Each hop costs code
  // searches, which share one cap per review.
  impactDepth: z.number().int().min(1).max(3),
  // Re-check findings with a second model call before they count: refuted
  // ones are dropped, uncertain ones demoted like an unproven blocker.
  // "blocking" checks only those at or above blockOn, "all" every finding.
  verify: z.enum(VERIFY_MODES),
  // Report what static analyzers already found on the change (GitHub check
  // run annotations, GitLab Code Quality and SAST reports) as tool findings.
  toolFindings: z.boolean(),
  // Let those tool findings reach blockOn and fail the verdict.
  toolFindingsBlock: z.boolean(),
  // static: each pass sees the diff and the context gathered for it.
  // agentic: a pass may also read files and search code through tools
  // until it reports, within review.agent's caps.
  context: z.enum(CONTEXT_MODES),
  agent: z.strictObject(agentShape),
};

export const SUMMARY_LOCATIONS = ["dynamic", "description", "comment"] as const;
export const REVIEW_TRIGGERS = ["manual", "published", "all"] as const;
export const SUMMARY_TRIGGERS = ["manual", "published"] as const;
export const HIGH_LEVEL_SUMMARY_PLACEMENTS = ["description", "walkthrough"] as const;

const outputShape = {
  walkthrough: z.boolean(),
  postInline: z.boolean(),
  // Inline threads only for actionable findings at or above this severity;
  // the rest are written out in the summary instead.
  inlineMinSeverity: severitySchema,
  // At most this many inline threads per review, the most severe first; null
  // posts every one. The rest are written out in the summary.
  maxInlineComments: z.number().int().min(1).max(100).nullable(),
  postSummary: z.boolean(),
  // Never start a summary comment for a completed review with no findings
  // (the commit status still reports the verdict). One an earlier run posted
  // is still updated, so it does not keep showing findings that are gone.
  summaryOnlyWithFindings: z.boolean(),
  postCheck: z.boolean(),
  // Resolve an inline thread once a later run no longer reports its finding,
  // and reopen it if the finding comes back.
  resolveFixedThreads: z.boolean(),
  // The line under the verdict counting the findings by severity and bucket.
  findingCounts: z.boolean(),
  // The line under the summary naming the commit, models, passes and files
  // reviewed.
  reviewStats: z.boolean(),
  // The block comparing the findings with the change's earlier reviews: new,
  // still open, reopened, fixed and invalidated.
  findingLifecycle: z.boolean(),
  // Ready-to-paste instructions for a coding agent: one per actionable inline
  // comment, and one in the summary covering every finding.
  agentPrompts: z.boolean(),
  agentPromptAll: z.boolean(),
  // Legacy and ignored: the walkthrough always opens the review comment now.
  // Still accepted so older files and saved settings keep validating.
  summaryLocation: z.enum(SUMMARY_LOCATIONS),
  // Native labels from the walkthrough's estimates, e.g. "Large blast radius".
  blastRadiusLabel: z.boolean(),
  effortLabel: z.boolean(),
  // Optional walkthrough parts. Each one asks the model for more, so each can
  // be turned off on its own.
  sequenceDiagrams: z.boolean(),
  estimateEffort: z.boolean(),
  assessLinkedIssues: z.boolean(),
  relatedIssues: z.boolean(),
  // Release notes by default; the instructions replace that guidance.
  highLevelSummary: z.boolean(),
  highLevelSummaryPlacement: z.enum(HIGH_LEVEL_SUMMARY_PLACEMENTS),
  highLevelSummaryInstructions: z.string().max(2000),
  // The labels and blast radius segments of the walkthrough's meta line. Only
  // the comment text: the model still estimates both, for the native labels.
  walkthroughLabels: z.boolean(),
  walkthroughBlastRadius: z.boolean(),
};

// Phrases, logins, labels and branch names; matching rules are in filters.ts.
const skipList = z.array(z.string().trim().min(1).max(200)).max(50);

const triggersShape = {
  // Which changes are reviewed automatically when opened or marked ready:
  // none, published only, or drafts too.
  review: z.enum(REVIEW_TRIGGERS),
  // Review again when an open PR/MR receives new commits.
  reviewOnPush: z.boolean(),
  // Review the whole change on push, instead of only the files the new commits
  // touched since the last completed review (worker/incremental.ts).
  fullReviewOnPush: z.boolean(),
  // Legacy, from before `review` existed: onPush turned all automatic reviews
  // on or off and drafts included drafts. Still accepted so older files and
  // saved settings keep validating; resolve.ts maps them onto `review`.
  onPush: z.boolean(),
  drafts: z.boolean(),
  // Whether automatic reviews include the walkthrough. A requested review always may.
  summary: z.enum(SUMMARY_TRIGGERS),
  // Allow "/sentryward review" in a comment to request a review.
  command: z.boolean(),
  // Act on replies to Sentryward's inline comments: "/sentryward ignore"
  // commands, and an answer to anything else.
  replies: z.boolean(),
  // Stop a review in progress once its PR/MR is closed or merged.
  abortOnClose: z.boolean(),
  ignoreTitles: skipList,
  skipAuthors: skipList,
  skipLabels: skipList,
  skipSourceBranches: skipList,
  skipTargetBranches: skipList,
};

// A pattern runs against every added line of the files a rule covers, inside
// the worker, and those lines are written by the change author. JavaScript
// regexes can backtrack exponentially and Node has no regex timeout, so
// patterns are compiled with RE2, which matches in linear time; that, not this
// cap, is what bounds the cost. The cap only keeps the file readable.
export const MAX_RULE_PATTERN_CHARS = 300;
// Model-checked rules are listed in every pass's system prompt, so their text
// as a whole is capped, not just each field: everything the prompt prints of
// them (llm/prompt.ts), ids and paths included.
export const MAX_RULES_CHARS = 16_000;

// RE2 rejects what it cannot match in linear time (backreferences,
// lookarounds), so such a pattern fails here rather than mid-review. One
// review parses the same rules several times (each config layer, then the
// merged config), so answers are remembered; the cache is cleared, not grown,
// past a bound, since patterns come from repository files.
const compileResults = new Map<string, boolean>();
const MAX_COMPILE_RESULTS = 500;

export const RULE_PATTERN_ERROR = "Not a valid regular expression (backreferences and lookarounds are not supported)";

export function rulePatternCompiles(pattern: string): boolean {
  const known = compileResults.get(pattern);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    new RE2(pattern);
    ok = true;
  } catch {
    ok = false;
  }
  if (compileResults.size >= MAX_COMPILE_RESULTS) compileResults.clear();
  compileResults.set(pattern, ok);
  return ok;
}

export const ruleSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "Use lowercase letters, digits, dots, dashes and underscores, e.g. no-db-in-controllers"),
  description: z.string().trim().min(1).max(1000),
  severity: severitySchema,
  // Rule findings are reported whatever review.categories says: the team asked
  // for them by writing the rule. The category only files them.
  category: categorySchema.optional(),
  // Globs over the file path; absent means every reviewed file.
  paths: z.array(z.string().min(1)).max(50).optional(),
  // Checked without a model, on added lines only, so the same diff always
  // gives the same findings. A rule with a pattern is never shown to the model.
  pattern: z
    .string()
    .min(1)
    .max(MAX_RULE_PATTERN_CHARS)
    .refine(rulePatternCompiles, RULE_PATTERN_ERROR)
    .optional(),
  good: z.string().max(2000).optional(),
  bad: z.string().max(2000).optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const MAX_RULES = 50;

// What counts towards MAX_RULES_CHARS: everything the prompt prints of the
// rules without a pattern.
export function modelRuleChars(rules: Rule[]): number {
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
    );
}

// The limits on a list as a whole. Layers combine (config/resolve.ts), so a
// list of rules that are each valid can still break them; this checks only
// that, without parsing every rule again.
export function combinedRulesError(rules: Rule[]): string | undefined {
  if (rules.length > MAX_RULES) return `At most ${MAX_RULES} rules`;
  if (modelRuleChars(rules) > MAX_RULES_CHARS) {
    return `Rules without a pattern may hold at most ${MAX_RULES_CHARS} characters in total (ids, paths, descriptions and examples)`;
  }
  return undefined;
}

export const rulesSchema = z
  .array(ruleSchema)
  .max(MAX_RULES)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      if (seen.has(rule.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `Duplicate rule id ${rule.id}` });
      seen.add(rule.id);
    }
    if (modelRuleChars(rules) > MAX_RULES_CHARS) {
      ctx.addIssue({ code: "custom", message: combinedRulesError(rules)! });
    }
  });

// Set by resolution only, never by a layer: the override schemas are strict
// and do not list it. A repository file or trigger may tighten the floor and
// confidence for dashboard rules but not loosen them, and may not hide files
// from their patterns, so it cannot silence what the workspace requires.
const ruleGuardSchema = z.strictObject({
  ids: z.array(z.string()),
  severityFloor: severitySchema,
  minConfidence: z.number().min(0).max(1),
  ignorePaths: z.array(z.string()),
});
export type RuleGuard = z.infer<typeof ruleGuardSchema>;

const topLevelShape = {
  version: z.literal(1),
  profile: profileNameSchema,
  ignorePaths: z.array(z.string().min(1)).max(200),
  instructions: z.string().max(4000),
  languageInstructions: z.record(z.string().min(1), z.string().max(2000)),
  // Team rules (rules.ts). Unlike every other list they combine across
  // layers instead of replacing, and a lower layer's rule always wins
  // (resolve.ts), so a repository file cannot loosen workspace rules. Their
  // thresholds are held too (ruleGuard).
  rules: rulesSchema,
};

export const configSchema = z.strictObject({
  ...topLevelShape,
  ruleGuard: ruleGuardSchema.optional(),
  llm: z.strictObject(dashboardLlmShape),
  review: z.strictObject(reviewShape),
  output: z.strictObject(outputShape),
  triggers: z.strictObject(triggersShape),
});
export type Config = z.infer<typeof configSchema>;

export const configOverrideSchema = z
  .strictObject({
    ...topLevelShape,
    llm: z.strictObject(llmShape).partial(),
    // Nested objects are partial too, so a layer may set one cap alone.
    review: z.strictObject({ ...reviewShape, agent: z.strictObject(agentShape).partial() }).partial(),
    output: z.strictObject(outputShape).partial(),
    triggers: z.strictObject(triggersShape).partial(),
  })
  .partial();
export type ConfigOverride = z.infer<typeof configOverrideSchema>;

// The global config and repository settings, saved by the repository owner in
// the dashboard. Only these layers may set endpoints; the repository file and
// triggers use configOverrideSchema, which rejects them as unknown settings.
export const dashboardOverrideSchema = configOverrideSchema.extend({
  llm: z
    .strictObject({ ...dashboardLlmShape, capabilities: z.strictObject(capabilitiesShape).partial() })
    .partial()
    .optional(),
});
export type DashboardOverride = z.infer<typeof dashboardOverrideSchema>;

export const DEFAULT_CONFIG: Config = {
  version: 1,
  profile: "balanced",
  llm: {
    model: "anthropic/claude-sonnet-5-5",
    fallbackModels: [],
    walkthroughModel: null,
    verifyModel: null,
    temperature: 0.2,
    maxTokens: 8000,
    contextBudget: null,
    thinking: "off",
    verifyThinking: null,
    connection: null,
    baseUrl: null,
    endpointKey: null,
    capabilities: { thinking: "auto", tools: "auto" },
  },
  review: {
    categories: ["security", "bug", "performance", "logic", "reliability"],
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
    agent: { maxSteps: 8, maxToolTokens: 30_000, maxSearches: 5 },
  },
  // The quiet setup the Display tab offers as its Standard preset: findings
  // inline and in one summary comment with a short PR summary, without the
  // extra lines, labels, diagrams or commit status. Each one is a switch away.
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
    summaryLocation: "dynamic",
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
    onPush: true,
    drafts: false,
    summary: "published",
    command: true,
    replies: true,
    abortOnClose: true,
    ignoreTitles: [],
    skipAuthors: [],
    skipLabels: [],
    skipSourceBranches: [],
    skipTargetBranches: [],
  },
  ignorePaths: [
    "**/*.lock",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.map",
    "**/vendor/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
  ],
  instructions: "",
  languageInstructions: {},
  rules: [],
};
