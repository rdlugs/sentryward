import { describe, expect, it } from "vitest";
import { loadReviewConfig } from "../src/review/config/load.ts";
import { parseRepoFile } from "../src/review/config/repoFile.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import { DEFAULT_CONFIG, configOverrideSchema, configSchema, dashboardOverrideSchema } from "../src/review/config/schema.ts";
import type { ForgeAdapter } from "../src/review/forge/types.ts";

describe("DEFAULT_CONFIG", () => {
  it("is itself a valid config", () => {
    expect(configSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });
});

describe("resolveConfig", () => {
  it("returns the defaults with no layers", () => {
    const { config, sources } = resolveConfig({});
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(sources["review.blockOn"]).toBe("default");
    expect(sources.profile).toBe("default");
  });

  it("applies layers in precedence order: trigger > repo file > repo settings", () => {
    const { config, sources } = resolveConfig({
      repoSettings: { review: { maxFindings: 10, minConfidence: 0.7 }, output: { walkthrough: false } },
      repoFile: { review: { maxFindings: 20 } },
      trigger: { review: { maxFindings: 30 } },
    });

    expect(config.review.maxFindings).toBe(30);
    expect(config.review.minConfidence).toBe(0.7);
    expect(config.output.walkthrough).toBe(false);
    expect(config.review.blockOn).toBe("critical");
    expect(sources).toMatchObject({
      "review.maxFindings": "trigger",
      "review.minConfidence": "repoSettings",
      "output.walkthrough": "repoSettings",
      "review.blockOn": "default",
    });
  });

  it("puts the global config above the profile and below repository settings", () => {
    const { config, sources } = resolveConfig({
      global: { profile: "strict", review: { maxFindings: 10, minConfidence: 0.8 } },
      repoSettings: { review: { maxFindings: 15 } },
    });

    expect(config.profile).toBe("strict");
    expect(config.review.blockOn).toBe("major");
    expect(config.review.minConfidence).toBe(0.8);
    expect(config.review.maxFindings).toBe(15);
    expect(sources).toMatchObject({
      profile: "global",
      "review.blockOn": "profile",
      "review.minConfidence": "global",
      "review.maxFindings": "repoSettings",
    });
  });

  it("applies the selected profile's preset", () => {
    const { config, sources } = resolveConfig({ repoSettings: { profile: "security" } });

    expect(config.profile).toBe("security");
    expect(config.review.categories).toEqual(["security", "reliability"]);
    expect(config.review.blockOn).toBe("major");
    expect(sources["review.blockOn"]).toBe("profile");
    expect(sources.profile).toBe("repoSettings");
  });

  it("verifies blocking findings by default, and not in the fast profile", () => {
    expect(resolveConfig({}).config.review.verify).toBe("blocking");
    expect(resolveConfig({ repoSettings: { profile: "fast" } }).config.review.verify).toBe("off");
  });

  it("lets an explicit field beat the profile, wherever it is set", () => {
    const { config } = resolveConfig({
      repoSettings: { review: { blockOn: "critical" } },
      repoFile: { profile: "strict" },
    });

    // strict would make majors block, but the saved setting is more specific.
    expect(config.profile).toBe("strict");
    expect(config.review.blockOn).toBe("critical");
    expect(config.review.maxFindings).toBe(40);
  });

  it("takes the profile from the highest layer that names one", () => {
    const { config, sources } = resolveConfig({
      repoSettings: { profile: "security" },
      repoFile: { profile: "fast" },
    });
    expect(config.profile).toBe("fast");
    expect(config.output.walkthrough).toBe(false);
    expect(config.review.categories).toEqual(DEFAULT_CONFIG.review.categories);
    expect(sources.profile).toBe("repoFile");
  });

  it("replaces arrays rather than concatenating them", () => {
    const { config } = resolveConfig({ repoFile: { ignorePaths: ["generated/**"] } });
    expect(config.ignorePaths).toEqual(["generated/**"]);
  });

  it("merges language instructions and records them as one setting", () => {
    const { config, sources } = resolveConfig({
      repoSettings: { languageInstructions: { php: "Laravel" } },
      repoFile: { languageInstructions: { go: "Use errgroup" } },
    });
    expect(config.languageInstructions).toEqual({ php: "Laravel", go: "Use errgroup" });
    expect(sources.languageInstructions).toBe("repoFile");
    expect(sources["languageInstructions.php"]).toBeUndefined();
  });

  it("takes the endpoint and its key from the dashboard layers", () => {
    const { config, sources } = resolveConfig({
      global: { llm: { baseUrl: "https://proxy.example/v1", endpointKey: "openai" } },
      repoSettings: { llm: { baseUrl: "http://host.docker.internal:20128/v1" } },
    });

    expect(config.llm).toMatchObject({ baseUrl: "http://host.docker.internal:20128/v1", endpointKey: "openai" });
    expect(sources).toMatchObject({ "llm.baseUrl": "repoSettings", "llm.endpointKey": "global" });
  });

  it("layers a live dashboard connection reference", () => {
    const { config, sources } = resolveConfig({
      global: { llm: { connection: "openai" } },
      repoSettings: { llm: { connection: "ollama" } },
    });

    expect(config.llm.connection).toBe("ollama");
    expect(sources["llm.connection"]).toBe("repoSettings");
  });

  it("refuses an endpoint or key choice from the repository file and triggers", () => {
    for (const llm of [
      { baseUrl: "https://evil.example" },
      { endpointKey: "openai" },
      { connection: "openai" },
    ]) {
      expect(() => resolveConfig({ repoFile: { llm } as never })).toThrow();
      expect(() => resolveConfig({ trigger: { llm } as never })).toThrow();
    }
  });

  describe("rules", () => {
    const rule = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      description: `Rule ${id}.`,
      severity: "major" as const,
      ...extra,
    });

    it("are accepted by the dashboard layers", () => {
      expect(dashboardOverrideSchema.safeParse({ rules: [rule("no-b")] }).success).toBe(true);
      expect(dashboardOverrideSchema.safeParse({ rules: [rule("no-b", { pattern: "(?=b)" })] }).success).toBe(false);
    });

    it("combine across layers, lowest first, with each rule's source", () => {
      const { config, sources, warnings } = resolveConfig({
        global: { rules: [rule("global")] },
        repoSettings: { rules: [rule("settings")] },
        repoFile: { rules: [rule("file")] },
      });
      expect(config.rules.map((r) => r.id)).toEqual(["global", "settings", "file"]);
      expect(sources).toMatchObject({
        "rules.global": "global",
        "rules.settings": "repoSettings",
        "rules.file": "repoFile",
        rules: "repoFile",
      });
      expect(warnings).toEqual([]);
    });

    it("keep a lower layer's rule when a higher one reuses its id", () => {
      const { config, sources, warnings } = resolveConfig({
        global: { rules: [rule("shared", { severity: "critical" })] },
        repoSettings: { rules: [rule("mine"), rule("shared", { severity: "info" })] },
        repoFile: { rules: [rule("mine", { severity: "info" }), rule("file")] },
      });
      expect(config.rules).toEqual([rule("shared", { severity: "critical" }), rule("mine"), rule("file")]);
      expect(sources).toMatchObject({ "rules.shared": "global", "rules.mine": "repoSettings", "rules.file": "repoFile" });
      expect(warnings).toEqual([
        "Rule shared in the repository settings was ignored: a rule with that id is already set in the global config",
        "Rule mine in the repository file was ignored: a rule with that id is already set in the repository settings",
      ]);
    });

    it("leave out a layer's additions as a whole when the combination is over a limit", () => {
      const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => rule(`${prefix}-${i}`));
      const { config, sources, warnings } = resolveConfig({
        global: { rules: many("global", 40) },
        repoFile: { rules: many("file", 20) },
      });
      expect(config.rules).toHaveLength(40);
      expect(sources["rules.file-0"]).toBeUndefined();
      expect(sources.rules).toBe("global");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^Rules in the repository file were ignored: together with the rules below them/);
    });

    it("report clashes and limits by layer", () => {
      const { ruleIssues } = resolveConfig({
        global: { rules: [rule("shared")] },
        repoSettings: { rules: [rule("shared")] },
      });
      expect(ruleIssues).toEqual([expect.objectContaining({ layer: "repoSettings", kind: "clash" })]);
    });

    it("hold dashboard rules to the dashboard's thresholds, which a file can only tighten", () => {
      const raised = resolveConfig({
        global: { review: { severityFloor: "minor", minConfidence: 0.5 }, ignorePaths: ["dist/**"], rules: [rule("global")] },
        repoFile: { review: { severityFloor: "critical", minConfidence: 0.9 }, ignorePaths: ["**"], rules: [rule("file")] },
      }).config;
      expect(raised.review.severityFloor).toBe("critical");
      expect(raised.ruleGuard).toEqual({ ids: ["global"], severityFloor: "minor", minConfidence: 0.5, ignorePaths: ["dist/**"] });

      const lowered = resolveConfig({
        global: { review: { severityFloor: "major", minConfidence: 0.7 }, rules: [rule("global")] },
        repoFile: { review: { severityFloor: "info", minConfidence: 0.2 } },
      }).config;
      expect(lowered.ruleGuard).toMatchObject({ severityFloor: "info", minConfidence: 0.2 });

      // A file's profile does not change the dashboard's thresholds either.
      const profiled = resolveConfig({ global: { rules: [rule("global")] }, repoFile: { profile: "strict" } }).config;
      expect(profiled.review.minConfidence).toBe(0.6);
      expect(profiled.ruleGuard?.minConfidence).toBe(DEFAULT_CONFIG.review.minConfidence);
    });

    it("need no guard without a dashboard rule or a layer above the dashboard", () => {
      expect(resolveConfig({ global: { rules: [rule("global")] } }).config.ruleGuard).toBeUndefined();
      expect(resolveConfig({ global: {}, repoFile: { rules: [rule("file")] } }).config.ruleGuard).toBeUndefined();
    });

    it("cannot have the guard set by a layer", () => {
      expect(configOverrideSchema.safeParse({ ruleGuard: { ids: [], severityFloor: "info", minConfidence: 0, ignorePaths: [] } }).success).toBe(false);
      expect(dashboardOverrideSchema.safeParse({ ruleGuard: { ids: [], severityFloor: "info", minConfidence: 0, ignorePaths: [] } }).success).toBe(false);
    });

    it("default to none, attributed to the defaults", () => {
      const { config, sources } = resolveConfig({});
      expect(config.rules).toEqual([]);
      expect(sources.rules).toBe("default");
    });
  });

  it("only accepts an http(s) base URL and a known key slot", () => {
    expect(dashboardOverrideSchema.safeParse({ llm: { baseUrl: "ftp://proxy.example" } }).success).toBe(false);
    expect(dashboardOverrideSchema.safeParse({ llm: { endpointKey: "mistral" } }).success).toBe(false);
    expect(dashboardOverrideSchema.safeParse({ llm: { baseUrl: null, endpointKey: null } }).success).toBe(true);
  });

  it("accepts router model ids with slashes and parentheses", () => {
    const { config } = resolveConfig({
      global: { llm: { model: "openai/cx/gpt-5.6-sol(medium)", fallbackModels: ["openai/cx/gpt-5.6-sol(low)"] } },
    });
    expect(config.llm.model).toBe("openai/cx/gpt-5.6-sol(medium)");
    expect(() => resolveConfig({ global: { llm: { model: "openai/gpt 5" } } })).toThrow();
  });

  it("accepts Ollama model ids", () => {
    const { config } = resolveConfig({ global: { llm: { model: "ollama/qwen3" } } });
    expect(config.llm.model).toBe("ollama/qwen3");
  });

  it("rejects an invalid layer", () => {
    expect(() => resolveConfig({ trigger: { review: { maxFindings: 0 } } })).toThrow();
  });

  it("leaves the walkthrough and verify models unset, and records which layer set them", () => {
    expect(resolveConfig({}).config.llm).toMatchObject({ walkthroughModel: null, verifyModel: null });

    const { config, sources } = resolveConfig({
      global: { llm: { walkthroughModel: "anthropic/claude-haiku-5-5" } },
      repoFile: { llm: { verifyModel: "anthropic/claude-opus-5-5" } },
    });
    expect(config.llm).toMatchObject({
      walkthroughModel: "anthropic/claude-haiku-5-5",
      verifyModel: "anthropic/claude-opus-5-5",
    });
    expect(sources).toMatchObject({ "llm.walkthroughModel": "global", "llm.verifyModel": "repoFile" });
    expect(() => resolveConfig({ trigger: { llm: { verifyModel: "claude-opus" } } })).toThrow(/provider\/model/);
  });
});

describe("legacy trigger settings", () => {
  it("maps onPush: false to manual-only reviews, from the layer that set it", () => {
    const { config, sources } = resolveConfig({ global: { triggers: { onPush: false } } });
    expect(config.triggers.review).toBe("manual");
    expect(sources["triggers.review"]).toBe("global");
  });

  it("maps drafts: true to reviewing drafts too", () => {
    expect(resolveConfig({ repoFile: { triggers: { drafts: true } } }).config.triggers.review).toBe("all");
  });

  it("lets an explicit review setting win over the legacy keys", () => {
    const { config } = resolveConfig({ repoSettings: { triggers: { onPush: false, review: "published" } } });
    expect(config.triggers.review).toBe("published");
  });

  it("leaves a higher layer's review alone when a lower one turned onPush off", () => {
    const { config } = resolveConfig({
      global: { triggers: { onPush: false } },
      repoSettings: { triggers: { review: "all" } },
    });
    expect(config.triggers.review).toBe("all");
  });
});

describe("parseRepoFile", () => {
  it("maps snake_case YAML onto the schema, leaving language names alone", () => {
    const { override, warnings } = parseRepoFile(
      ".sentryward.yaml",
      [
        "profile: strict",
        "review:",
        "  severity_floor: major",
        "  require_evidence: false",
        "output:",
        "  post_check: false",
        "ignore_paths: [\"gen/**\"]",
        "language_instructions:",
        "  objective_c: Prefer ARC",
      ].join("\n"),
    );

    expect(warnings).toEqual([]);
    expect(override).toEqual({
      profile: "strict",
      review: { severityFloor: "major", requireEvidence: false },
      output: { postCheck: false },
      ignorePaths: ["gen/**"],
      languageInstructions: { objective_c: "Prefer ARC" },
    });
  });

  it("reads the triggers section", () => {
    const { override, warnings } = parseRepoFile(".sentryward.yaml", "triggers:\n  on_push: false\n  drafts: true\n");
    expect(warnings).toEqual([]);
    expect(override).toEqual({ triggers: { onPush: false, drafts: true } });
  });

  it("reads the review, summary and skip settings", () => {
    const yaml = [
      "triggers:",
      "  review: all",
      "  review_on_push: false",
      "  summary: manual",
      "  ignore_titles: [WIP]",
      "  skip_authors: [dependabot]",
      "  skip_labels: [no-review]",
      "  skip_source_branches: [release/]",
      "  skip_target_branches: [legacy]",
      "output:",
      "  summary_location: comment",
      "  blast_radius_label: true",
      "  effort_label: true",
      "  finding_counts: false",
      "  finding_lifecycle: false",
      "  review_stats: false",
      "  agent_prompts: false",
      "  agent_prompt_all: true",
      "  walkthrough_labels: false",
      "  walkthrough_blast_radius: false",
      "",
    ].join("\n");
    const { override, warnings } = parseRepoFile(".sentryward.yaml", yaml);
    expect(warnings).toEqual([]);
    expect(override).toEqual({
      triggers: {
        review: "all",
        reviewOnPush: false,
        summary: "manual",
        ignoreTitles: ["WIP"],
        skipAuthors: ["dependabot"],
        skipLabels: ["no-review"],
        skipSourceBranches: ["release/"],
        skipTargetBranches: ["legacy"],
      },
      output: {
        summaryLocation: "comment",
        blastRadiusLabel: true,
        effortLabel: true,
        findingCounts: false,
        findingLifecycle: false,
        reviewStats: false,
        agentPrompts: false,
        agentPromptAll: true,
        walkthroughLabels: false,
        walkthroughBlastRadius: false,
      },
    });
  });

    it("treats an empty file as no overrides", () => {
    expect(parseRepoFile(".sentryward.yaml", "# nothing yet\n")).toEqual({ override: {}, warnings: [] });
  });

  it("reads review.verify and rejects an unknown mode", () => {
    expect(parseRepoFile(".sentryward.yaml", "review:\n  verify: all\n")).toEqual({
      override: { review: { verify: "all" } },
      warnings: [],
    });
    expect(parseRepoFile(".sentryward.yaml", "review:\n  verify: sometimes\n").override).toBeUndefined();
  });

  it("reads the inline limits and summary only with findings, defaulting to posting everything", () => {
    expect(DEFAULT_CONFIG.output).toMatchObject({
      inlineMinSeverity: "info",
      maxInlineComments: null,
      summaryOnlyWithFindings: false,
    });
    const yaml = "output:\n  inline_min_severity: major\n  max_inline_comments: 5\n  summary_only_with_findings: true\n";
    expect(parseRepoFile(".sentryward.yaml", yaml)).toEqual({
      override: { output: { inlineMinSeverity: "major", maxInlineComments: 5, summaryOnlyWithFindings: true } },
      warnings: [],
    });
    const resolved = resolveConfig({ repoFile: parseRepoFile(".sentryward.yaml", yaml).override });
    expect(resolved.sources["output.maxInlineComments"]).toBe("repoFile");
    for (const bad of ["inline_min_severity: huge", "max_inline_comments: 0", "max_inline_comments: 101"]) {
      expect(parseRepoFile(".sentryward.yaml", `output:\n  ${bad}\n`).override).toBeUndefined();
    }
  });

  it("reads the per-purpose models", () => {
    const file = "llm:\n  walkthrough_model: anthropic/claude-haiku-5-5\n  verify_model: anthropic/claude-opus-5-5\n";
    expect(parseRepoFile(".sentryward.yaml", file)).toEqual({
      override: { llm: { walkthroughModel: "anthropic/claude-haiku-5-5", verifyModel: "anthropic/claude-opus-5-5" } },
      warnings: [],
    });
  });

  it("reads thinking and agentic context, one agent cap at a time", () => {
    const file = "llm:\n  thinking: medium\n  verify_thinking: low\nreview:\n  context: agentic\n  agent:\n    max_steps: 4\n";
    const { override, warnings } = parseRepoFile(".sentryward.yaml", file);
    expect(warnings).toEqual([]);
    const { config, sources } = resolveConfig({ repoFile: override });
    expect(config.llm).toMatchObject({ thinking: "medium", verifyThinking: "low" });
    expect(config.review.context).toBe("agentic");
    expect(config.review.agent).toEqual({ maxSteps: 4, maxToolTokens: 30_000, maxSearches: 5 });
    expect(sources["review.agent.maxSteps"]).toBe("repoFile");
    expect(sources["review.agent.maxSearches"]).toBe("default");
  });

  it("refuses capability settings, which only the dashboard may set", () => {
    const { override, warnings } = parseRepoFile(".sentryward.yaml", "llm:\n  capabilities:\n    tools: true\n");
    expect(override).toBeUndefined();
    expect(warnings[0]).toMatch(/unknown setting capabilities/);
    const { config } = resolveConfig({ global: { llm: { capabilities: { thinking: "none" } } } });
    expect(config.llm.capabilities).toEqual({ thinking: "none", tools: "auto" });
  });

  it("thinks hard in the strict profile and not at all in the fast one", () => {
    expect(resolveConfig({ repoFile: { profile: "strict" } }).config.llm.thinking).toBe("high");
    expect(resolveConfig({ repoFile: { profile: "fast" } }).config.llm.thinking).toBe("off");
    expect(resolveConfig({}).config.llm.thinking).toBe("off");
  });

  it("ignores the whole file and names an unknown setting in snake_case", () => {
    const { override, warnings } = parseRepoFile(
      ".sentryward.yaml",
      "review:\n  max_findings: 5\n  severity_flor: major\n",
    );
    expect(override).toBeUndefined();
    expect(warnings).toEqual([".sentryward.yaml was ignored: review: unknown setting severity_flor"]);
  });

  it("refuses credentials and endpoints, which the schema does not have", () => {
    const { override, warnings } = parseRepoFile(
      ".sentryward.yaml",
      "llm:\n  api_base: https://evil.example\n  api_keys:\n    anthropic: sk\n",
    );
    expect(override).toBeUndefined();
    expect(warnings[0]).toMatch(/unknown setting api_base, api_keys/);
  });

  it("refuses the endpoint and key choice, which only the dashboard may set", () => {
    const { override, warnings } = parseRepoFile(
      ".sentryward.yaml",
      "llm:\n  base_url: https://evil.example\n  endpoint_key: openai\n",
    );
    expect(override).toBeUndefined();
    expect(warnings[0]).toMatch(/unknown setting base_url, endpoint_key/);
  });

  it("reports an invalid value with its path", () => {
    const { warnings } = parseRepoFile(".sentryward.yaml", "review:\n  block_on: blocker\n");
    expect(warnings[0]).toMatch(/^\.sentryward\.yaml was ignored: review\.block_on: /);
  });

  it("reports unparseable YAML", () => {
    const { override, warnings } = parseRepoFile(".sentryward.yaml", "review: [unclosed\n");
    expect(override).toBeUndefined();
    expect(warnings[0]).toMatch(/could not be parsed/);
  });

  it("rejects a non-mapping document", () => {
    expect(parseRepoFile(".sentryward.yaml", "- a\n- b\n").warnings[0]).toMatch(/must be a mapping/);
  });

  it("rejects an oversized file without parsing it", () => {
    const { warnings } = parseRepoFile(".sentryward.yaml", `instructions: "${"x".repeat(70 * 1024)}"`);
    expect(warnings[0]).toMatch(/larger than 64 KB/);
  });
});

// Files keyed by `${ref}:${path}`; records which reads were made.
function fakeAdapter(files: Record<string, string>) {
  const reads: string[] = [];
  const adapter = {
    getFileAtRef: async (_project: string, path: string, ref: string) => {
      reads.push(`${ref}:${path}`);
      return files[`${ref}:${path}`] ?? null;
    },
  } as unknown as ForgeAdapter;
  return { adapter, reads };
}

describe("loadReviewConfig", () => {
  it("reads the repository file from the given (base) revision only", async () => {
    const { adapter, reads } = fakeAdapter({
      "base:.sentryward.yaml": "review:\n  block_on: major\n",
      "head:.sentryward.yaml": "review:\n  block_on: info\n",
    });

    const loaded = await loadReviewConfig({ adapter, project: "acme/web", ref: "base" });

    expect(loaded.config.review.blockOn).toBe("major");
    expect(loaded.repoFile).toBe(".sentryward.yaml");
    expect(reads).toEqual(["base:.sentryward.yaml"]);
  });

  it("ignores a file that only exists on the head", async () => {
    const { adapter } = fakeAdapter({ "head:.sentryward.yaml": "review:\n  block_on: info\n" });

    const loaded = await loadReviewConfig({ adapter, project: "acme/web", ref: "base" });

    expect(loaded.config.review.blockOn).toBe("critical");
    expect(loaded.repoFile).toBeNull();
  });

  it("falls back to .sentryward.yml and never merges the two", async () => {
    const { adapter, reads } = fakeAdapter({ "base:.sentryward.yml": "profile: fast\n" });

    const loaded = await loadReviewConfig({ adapter, project: "acme/web", ref: "base" });

    expect(loaded.repoFile).toBe(".sentryward.yml");
    expect(loaded.config.profile).toBe("fast");
    expect(reads).toEqual(["base:.sentryward.yaml", "base:.sentryward.yml"]);
  });

  it("keeps reviewing with a warning when the file is invalid", async () => {
    const { adapter } = fakeAdapter({ "base:.sentryward.yaml": "review:\n  nope: 1\n" });

    const loaded = await loadReviewConfig({
      adapter,
      project: "acme/web",
      ref: "base",
      repoSettings: { review: { maxFindings: 7 } },
    });

    expect(loaded.config.review.maxFindings).toBe(7);
    expect(loaded.warnings).toEqual([".sentryward.yaml was ignored: review: unknown setting nope"]);
  });

  it("adds the repository file's rules to the saved ones, ignoring repository settings while following the global config", async () => {
    const { adapter } = fakeAdapter({
      "base:.sentryward.yaml": "rules:\n  - id: shared\n    description: Weaker.\n    severity: info\n",
    });
    const shared = { id: "shared", description: "Strict.", severity: "critical" as const };
    const own = { id: "own", description: "Own.", severity: "minor" as const };

    const loaded = await loadReviewConfig({
      adapter,
      project: "acme/web",
      ref: "base",
      globalSettings: { rules: [shared] },
      repoSettings: { rules: [own] },
      followGlobal: true,
    });

    expect(loaded.config.rules).toEqual([shared]);
    expect(loaded.warnings).toEqual(["Rule shared in the repository file was ignored: a rule with that id is already set in the global config"]);
  });

  it("ignores saved settings that no longer validate", async () => {
    const { adapter } = fakeAdapter({});

    const loaded = await loadReviewConfig({
      adapter,
      project: "acme/web",
      ref: "base",
      repoSettings: { review: { retiredSetting: true } },
    });

    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warnings[0]).toMatch(/no longer valid/);
  });
});
