import { PROFILES } from "./profiles.ts";
import {
  DEFAULT_CONFIG,
  configOverrideSchema,
  configSchema,
  combinedRulesError,
  combinedReviewersError,
  dashboardOverrideSchema,
  type Config,
  type ConfigOverride,
  type DashboardOverride,
  type ProfileName,
  type RuleGuard,
  type ApprovalGuard,
} from "./schema.ts";
import { atLeast } from "../core/severity.ts";

export type LayerName = "default" | "profile" | "global" | "repoSettings" | "directory" | "repoFile" | "trigger";

export interface ConfigLayers {
  // The owner's global config from the dashboard, validated on write.
  global?: DashboardOverride;
  // Saved in the dashboard, validated on write.
  repoSettings?: DashboardOverride;
  // The settings of the one folder the change sits in (directories.ts), saved
  // in the dashboard next to the repository settings.
  directory?: DashboardOverride;
  // `.sentryward.yaml` from the base revision, already parsed.
  repoFile?: ConfigOverride;
  // A one-off override from whatever started the review.
  trigger?: ConfigOverride;
}

export interface ResolvedConfig {
  config: Config;
  // Dotted leaf path to the layer that set it, so a result can say why a
  // setting has the value it does.
  sources: Record<string, LayerName>;
  // Rules and custom reviewers a layer could not add (combinedFrom); the
  // config still resolves.
  warnings: string[];
  // The same, by layer, for callers that reject a save instead of warning.
  // Reviewers are included, so every save check that holds rules holds them.
  combinedIssues: CombinedIssue[];
}

export interface CombinedIssue {
  layer: LayerName;
  // Which combined list the issue is about.
  list: "rules" | "reviewers";
  // "clash": an id already set below; "limit": the layer's additions broke a
  // limit together with those below and were left out.
  kind: "clash" | "limit";
  message: string;
}

type Plain = Record<string, unknown>;

const DASHBOARD_LAYERS = new Set<LayerName>(["global", "repoSettings", "directory"]);

function isPlainObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Objects merge key by key; arrays and scalars replace. Replacing arrays is
// what a user expects from `ignore_paths: [...]` in a file.
function merge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key] as Plain, value) : value;
  }
  return out;
}

// languageInstructions is a map keyed by language; its keys are data, not
// settings, so it is recorded as one leaf.
const MAP_PATHS = new Set(["languageInstructions"]);

function recordLeaves(value: unknown, layer: LayerName, sources: Record<string, LayerName>, path = "") {
  if (isPlainObject(value) && !MAP_PATHS.has(path)) {
    for (const [key, child] of Object.entries(value)) {
      recordLeaves(child, layer, sources, path ? `${path}.${key}` : key);
    }
  } else if (value !== undefined && path) {
    sources[path] = layer;
  }
}

// Settings saved before `triggers.review` existed: `onPush: false` meant no
// automatic reviews at all and `drafts: true` included drafts. A layer that
// sets them without `review` keeps that meaning, attributed to the same layer.
export function withLegacyTriggers<T extends ConfigOverride>(layer: T): T {
  const triggers = layer.triggers;
  if (!triggers || triggers.review !== undefined) return layer;
  if (triggers.onPush === false) return { ...layer, triggers: { ...triggers, review: "manual" } };
  if (triggers.drafts === true) return { ...layer, triggers: { ...triggers, review: "all" } };
  return layer;
}

const LAYER_LABELS: Record<LayerName, string> = {
  default: "the defaults",
  profile: "the profile",
  global: "the global config",
  repoSettings: "the repository settings",
  directory: "the folder settings",
  repoFile: "the repository file",
  trigger: "the trigger",
};

// The lists that combine across layers instead of replacing, and how their
// messages name one entry and the whole list.
const COMBINED = {
  rules: { one: "Rule", many: "Rules", noun: "rule", limit: combinedRulesError },
  reviewers: { one: "Custom reviewer", many: "Custom reviewers", noun: "custom reviewer", limit: combinedReviewersError },
} as const;
type CombinedKey = keyof typeof COMBINED;

// Rules and custom reviewers combine across layers instead of replacing like
// other lists: each layer adds to those below it and can never drop or
// redefine one of them, so a repository file cannot loosen what the workspace
// requires. Every layer was validated on its own, so only the combination can
// break a limit; then that layer's additions are left out as a whole, never
// half of them.
function combinedFrom<K extends CombinedKey>(
  key: K,
  layers: [LayerName, ConfigOverride | undefined][],
  sources: Record<string, LayerName>,
  issues: CombinedIssue[],
): NonNullable<ConfigOverride[K]> {
  const { one, many, noun, limit } = COMBINED[key];
  type Entry = NonNullable<ConfigOverride[K]>[number];
  let entries: Entry[] = [];
  for (const [name, layer] of layers) {
    const own = layer?.[key] as Entry[] | undefined;
    if (!own?.length) continue;
    const added: Entry[] = [];
    for (const entry of own) {
      const owner = sources[`${key}.${entry.id}`];
      if (owner) {
        issues.push({
          layer: name,
          list: key,
          kind: "clash",
          message: `${one} ${entry.id} in ${LAYER_LABELS[name]} was ignored: a ${noun} with that id is already set in ${LAYER_LABELS[owner]}`,
        });
      } else added.push(entry);
    }
    if (!added.length) continue;
    const combined = [...entries, ...added];
    const reason = (limit as (list: Entry[]) => string | undefined)(combined);
    if (reason) {
      issues.push({
        layer: name,
        list: key,
        kind: "limit",
        message: `${many} in ${LAYER_LABELS[name]} were ignored: together with the ${noun}s below them, ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`,
      });
      continue;
    }
    entries = combined;
    for (const entry of added) sources[`${key}.${entry.id}`] = name;
    sources[key] = name;
  }
  return entries as NonNullable<ConfigOverride[K]>;
}

function withoutCombined<T extends ConfigOverride>(layer: T): T {
  if (layer.rules === undefined && layer.reviewers === undefined) return layer;
  const { rules: _rules, reviewers: _reviewers, ...rest } = layer;
  return rest as T;
}

// Precedence, lowest first: defaults, profile preset, global config,
// repository settings, folder settings, repository file, trigger. The profile itself is chosen by the highest layer
// that names one.
export function resolveConfig(layers: ConfigLayers): ResolvedConfig {
  const ordered: [LayerName, DashboardOverride | undefined][] = [
    ["global", layers.global],
    ["repoSettings", layers.repoSettings],
    ["directory", layers.directory],
    ["repoFile", layers.repoFile],
    ["trigger", layers.trigger],
  ];
  // Only the dashboard layers may set endpoints.
  for (const [name, layer] of ordered) {
    if (!layer) continue;
    if (DASHBOARD_LAYERS.has(name)) dashboardOverrideSchema.parse(layer);
    else configOverrideSchema.parse(layer);
  }

  const naming = [...ordered].reverse().find(([, layer]) => layer?.profile);
  const profile: ProfileName = naming?.[1]?.profile ?? DEFAULT_CONFIG.profile;

  const sources: Record<string, LayerName> = {};
  recordLeaves(DEFAULT_CONFIG, "default", sources);
  let merged = merge({}, DEFAULT_CONFIG);

  const stack: [LayerName, DashboardOverride][] = [["profile", { ...PROFILES[profile], profile }]];
  for (const [name, layer] of ordered) {
    if (layer) stack.push([name, withLegacyTriggers(layer)]);
  }
  for (const [name, layer] of stack) {
    merged = merge(merged, withoutCombined(layer) as Plain);
    recordLeaves(withoutCombined(layer), name, sources);
  }
  // `profile` is decided above, not merged; attribute it to whoever named it.
  sources.profile = naming?.[0] ?? "default";
  const combinedIssues: CombinedIssue[] = [];
  merged.rules = combinedFrom("rules", ordered, sources, combinedIssues);
  merged.reviewers = combinedFrom("reviewers", ordered, sources, combinedIssues);
  const config = configSchema.parse(merged);
  const ruleGuard = guardFor(layers, config, sources);
  if (ruleGuard) config.ruleGuard = ruleGuard;
  const approvalGuard = approvalGuardFor(layers, config);
  if (approvalGuard) config.approvalGuard = approvalGuard;
  const approvalWarnings = holdApproval(layers, config, sources);

  return { config, sources, warnings: [...combinedIssues.map((issue) => issue.message), ...approvalWarnings], combinedIssues };
}

// Logins cannot contain parentheses on either forge, so this matches nobody.
export const NO_APPROVED_AUTHOR = "(nobody)";

// The approval policy is a security control, like rules: the repository file
// and the trigger may tighten what the dashboard layers set, never loosen it.
// They can turn approval off, ask for "no_findings", and add blocks; an
// onlyAuthors list narrows the dashboard's. A loosening is ignored with a
// warning. Returns the warnings; `config` and `sources` are updated in place.
function holdApproval(layers: ConfigLayers, config: Config, sources: Record<string, LayerName>): string[] {
  const repoLayers = (
    [
      ["repoFile", layers.repoFile],
      ["trigger", layers.trigger],
    ] as const
  ).flatMap(([name, layer]) => (layer?.output?.approval ? [[name, layer.output.approval] as const] : []));
  if (!repoLayers.length) return [];

  const dashboard = resolveConfig({ global: layers.global, repoSettings: layers.repoSettings, directory: layers.directory });
  const base = dashboard.config.output.approval;
  const held = { ...base };
  const set: Partial<Record<keyof typeof held, LayerName>> = {};
  const warnings: string[] = [];
  const union = <T>(a: T[], b: T[] | undefined) => [...new Set([...a, ...(b ?? [])])];

  for (const [name, own] of repoLayers) {
    const where = LAYER_LABELS[name];
    if (own.enabled === false && held.enabled) {
      held.enabled = false;
      set.enabled = name;
    } else if (own.enabled === true && !held.enabled) {
      warnings.push(`Approval in ${where} was ignored: only the dashboard settings can turn approval on`);
    }
    if (own.when === "no_findings" && held.when !== "no_findings") {
      held.when = "no_findings";
      set.when = name;
    } else if (own.when === "pass" && held.when === "no_findings") {
      warnings.push(`Approval "when: pass" in ${where} was ignored: the dashboard settings approve only reviews with no findings`);
    }
    // Withdrawing and requesting changes both hold the approval back.
    if (own.requestChanges !== undefined && own.requestChanges !== held.requestChanges) {
      held.requestChanges = own.requestChanges;
      set.requestChanges = name;
    }
    for (const key of ["blockPaths", "skipAuthors", "blockLabels", "blockOnRisk"] as const) {
      // Asks whether the layer adds a member, not whether the length grew: the
      // union also dedupes the dashboard's own list, which may repeat entries.
      const theirs: string[] = own[key] ?? [];
      if (theirs.some((item) => !(held[key] as string[]).includes(item))) {
        (held as Record<typeof key, string[]>)[key] = union<string>(held[key], theirs);
        set[key] = name;
      }
    }
    if (own.onlyAuthors?.length) {
      if (!held.onlyAuthors.length) {
        held.onlyAuthors = [...own.onlyAuthors];
      } else {
        const theirs = new Set(own.onlyAuthors.map((login) => login.toLowerCase()));
        const both = held.onlyAuthors.filter((login) => theirs.has(login.toLowerCase()));
        // An empty intersection must still approve nobody, not everybody.
        held.onlyAuthors = both.length ? both : [NO_APPROVED_AUTHOR];
      }
      set.onlyAuthors = name;
    }
  }

  config.output.approval = held;
  for (const key of Object.keys(held) as (keyof typeof held)[]) {
    const path = `output.approval.${key}`;
    sources[path] = set[key] ?? dashboard.sources[path] ?? "default";
  }
  return warnings;
}

// The verdict is the review's own, so a repository file or trigger may loosen
// review.blockOn (or stop tool findings blocking) for it. An automatic
// approval is a security control like the approval policy above: it still
// answers to the threshold the dashboard layers resolve to, or the effective
// one where that is stricter. Only set when the dashboard is the stricter one.
function approvalGuardFor(layers: ConfigLayers, config: Config): ApprovalGuard | undefined {
  if (!layers.repoFile && !layers.trigger) return undefined;
  const dashboard = resolveConfig({ global: layers.global, repoSettings: layers.repoSettings, directory: layers.directory }).config;
  const { blockOn, toolFindingsBlock } = config.review;
  const held: ApprovalGuard = {
    // The lower severity is the stricter threshold.
    blockOn: atLeast(blockOn, dashboard.review.blockOn) ? dashboard.review.blockOn : blockOn,
    toolFindingsBlock: toolFindingsBlock || dashboard.review.toolFindingsBlock,
  };
  return held.blockOn !== blockOn || held.toolFindingsBlock !== toolFindingsBlock ? held : undefined;
}

// Dashboard rules are held to the thresholds the dashboard layers resolve to
// on their own, profile included, or to the effective ones where those are
// stricter: a repository file or trigger can ask for more of them, never less.
// Only needed when such a layer exists and there is a dashboard rule to hold.
function guardFor(layers: ConfigLayers, config: Config, sources: Record<string, LayerName>): RuleGuard | undefined {
  if (!layers.repoFile && !layers.trigger) return undefined;
  const ids = config.rules.filter((rule) => DASHBOARD_LAYERS.has(sources[`rules.${rule.id}`]!)).map((rule) => rule.id);
  if (!ids.length) return undefined;
  const dashboard = resolveConfig({ global: layers.global, repoSettings: layers.repoSettings, directory: layers.directory }).config;
  const floor = config.review.severityFloor;
  return {
    ids,
    severityFloor: atLeast(floor, dashboard.review.severityFloor) ? dashboard.review.severityFloor : floor,
    minConfidence: Math.min(config.review.minConfidence, dashboard.review.minConfidence),
    ignorePaths: dashboard.ignorePaths,
  };
}
