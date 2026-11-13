import picomatch from "picomatch";
import RE2 from "re2";
import type { Config, Rule } from "./config/schema.ts";
import { bucketFor } from "./core/buckets.ts";
import { fingerprint } from "./core/fingerprint.ts";
import type { ChangedFile, ChangeSet, Finding } from "./core/models.ts";
import { atLeast, type Category, type Severity } from "./core/severity.ts";
import { hunkLines } from "./context/diffText.ts";
import { fence } from "./render/markdown.ts";
import type { DropReason, ValidationResult } from "./validate/validator.ts";

// Team rules, from the dashboard layers and `.sentryward.yaml` combined
// (config/resolve.ts). A rule with a pattern is checked here, without a model;
// the rest are listed in the review prompt and come back as model findings
// naming the rule (validator.ts). Either way the finding has
// source "rule", the rule's id, severity and category.

export const DEFAULT_RULE_CATEGORY: Category = "maintainability";

// Longer lines (minified code, embedded data) are not matched: a violation
// there is noise nobody will act on. Cost is bounded by RE2 (config/schema.ts).
const MAX_MATCHED_LINE_CHARS = 2000;

const matchers = new WeakMap<Rule, (path: string) => boolean>();
const patterns = new WeakMap<Rule, RE2>();

export function ruleApplies(rule: Rule, path: string): boolean {
  if (!rule.paths?.length) return true;
  let matcher = matchers.get(rule);
  if (!matcher) {
    matcher = picomatch(rule.paths, { dot: true });
    matchers.set(rule, matcher);
  }
  return matcher(path);
}

// A dashboard rule is held to the guard's thresholds (config/resolve.ts), so a
// repository file cannot raise them past what the workspace set.
function guarded(config: Config, ruleId: string | null | undefined): boolean {
  return !!ruleId && !!config.ruleGuard?.ids.includes(ruleId);
}

export function ruleFloor(config: Config, ruleId: string | null | undefined): Severity {
  return guarded(config, ruleId) ? config.ruleGuard!.severityFloor : config.review.severityFloor;
}

export function ruleMinConfidence(config: Config, ruleId: string | null | undefined): number {
  return guarded(config, ruleId) ? config.ruleGuard!.minConfidence : config.review.minConfidence;
}

// The rules the model is asked to check: those a pattern cannot decide.
export function modelRules(config: Config): Rule[] {
  return config.rules.filter((rule) => rule.pattern === undefined);
}

// The rule a model finding names: undefined when it names none, null when the
// name does not hold (an unknown id, a pattern rule, or a rule whose paths
// leave the file out), which the validator drops.
export function modelRuleFor(config: Config, ruleId: string | null | undefined, path: string): Rule | null | undefined {
  const id = ruleId?.trim();
  if (!id) return undefined;
  return modelRules(config).find((rule) => rule.id === id && ruleApplies(rule, path)) ?? null;
}

// Up to the first sentence, so a title stays one line however long the rule.
// A full stop ends it only before a capital or the end, so "e.g. logger.info"
// does not.
export function ruleTitle(rule: Rule): string {
  const text = rule.description.replace(/\s+/g, " ").trim();
  const end = text.search(/[;:](\s|$)|\.(\s+[A-Z]|$)/);
  return (end > 0 ? text.slice(0, end) : text).slice(0, 200);
}

function ruleBody(rule: Rule): string {
  const good = rule.good?.trimEnd();
  return good ? `${rule.description.trim()}\n\nInstead:\n\n${fence(good)}` : rule.description.trim();
}

function compiled(rule: Rule & { pattern: string }): RE2 {
  let pattern = patterns.get(rule);
  if (!pattern) {
    pattern = new RE2(rule.pattern);
    patterns.set(rule, pattern);
  }
  return pattern;
}

// Pattern rules over the added lines of the reviewed files. Pure and
// order-stable, so the same diff and rules give the same findings and
// fingerprints on every run. Held to the floor (a rule below it is skipped
// whole) and dismissals like any other finding, but not to review.categories
// (see ruleSchema); the cap is applied by the caller across every source.
// guardedOnly holds files the effective ignore list drops but the dashboard's
// does not: only dashboard rules are checked there.
export function checkPatternRules(
  reviewed: ChangedFile[],
  changeSet: ChangeSet,
  config: Config,
  ignoredFingerprints?: ReadonlySet<string>,
  guardedOnly: ChangedFile[] = [],
): ValidationResult {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const kept = new Map<string, Finding>();

  // A rule below the floor can produce nothing, so it is not run at all.
  const rules = config.rules.filter(
    (rule): rule is Rule & { pattern: string } =>
      rule.pattern !== undefined && atLeast(rule.severity, ruleFloor(config, rule.id)),
  );
  if (rules.length === 0) return { findings: [], dropped, demoted: 0 };

  const files = [...reviewed.map((file) => ({ file, only: false })), ...guardedOnly.map((file) => ({ file, only: true }))];
  for (const { file, only } of files) {
    const applicable = rules.filter((rule) => ruleApplies(rule, file.path) && (!only || guarded(config, rule.id)));
    if (applicable.length === 0) continue;
    // Read once per file, not once per rule.
    const added = file.hunks
      .flatMap(hunkLines)
      .flatMap(({ marker, line, text }) => (marker === "+" && line !== undefined ? [{ line, text }] : []));
    for (const rule of applicable) {
      // RE2, as validated by the config schema, so a change author's line
      // cannot make a pattern backtrack. No flags: a global or sticky regex
      // would carry lastIndex between lines.
      const pattern = compiled(rule);
      const category = rule.category ?? DEFAULT_RULE_CATEGORY;
      const title = ruleTitle(rule);
      for (const { line, text } of added) {
        if (text.length > MAX_MATCHED_LINE_CHARS || !pattern.test(text)) continue;
        const kind = "potential_issue";
        const finding: Finding = {
          file: file.path,
          startLine: line,
          endLine: line,
          severity: rule.severity,
          category,
          kind,
          effort: "quick_win",
          title,
          body: ruleBody(rule),
          confidence: 1,
          evidence: "contract",
          evidenceNote: `Matches the pattern of rule ${rule.id}`,
          evidenceFiles: [],
          verification: "not_checked",
          source: "rule",
          ruleId: rule.id,
          // The matched line is part of the identity, as an analyzer's message
          // is for tool findings: two different violations in a file stay two
          // findings, and the same line text twice is reported once.
          fingerprint: fingerprint({ file: file.path, category, kind, title: `${title} ${text.trim()}`, ruleId: rule.id }),
          bucket: bucketFor({ file: file.path, startLine: line, kind }, changeSet),
        };
        if (ignoredFingerprints?.has(finding.fingerprint)) {
          drop("previously_ignored");
          continue;
        }
        if (kept.has(finding.fingerprint)) {
          drop("duplicate");
          continue;
        }
        kept.set(finding.fingerprint, finding);
      }
    }
  }

  return { findings: [...kept.values()], dropped, demoted: 0 };
}
