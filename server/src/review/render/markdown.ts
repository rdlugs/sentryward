import { BUCKET_TITLE, SUMMARY_BUCKETS, inlineSelection, type InlineLimits } from "../core/buckets.ts";
import type {
  Bucket,
  Finding,
  InvalidatedReason,
  IssueAssessment,
  IssueRef,
  Lifecycle,
  Omission,
  ReviewResult,
  Walkthrough,
} from "../core/models.ts";
import { SEVERITIES, type Severity } from "../core/severity.ts";
import { DESCRIPTION_SUMMARY_END, DESCRIPTION_SUMMARY_START, SUMMARY_MARKER } from "../core/markers.ts";
import { agentPromptBlock, allFindingsPrompt } from "./agentPrompt.ts";
import { summarize } from "./json.ts";
import { RISK_KIND_TEXT } from "../context/risk.ts";

export { SUMMARY_MARKER };

// Forges fetch the image themselves, so it must be a public absolute URL.
const LOGO_URL = "https://raw.githubusercontent.com/rdlugs/sentryward/main/client/public/sentryward-32.png";

// The only place Sentryward names itself in what it posts: a small credit at the
// bottom of every comment, so the content reads as the review, not the tool.
export const BRAND_FOOTER = `<sub><img src="${LOGO_URL}" alt="" width="14" height="14" align="absmiddle"> Sentryward</sub>`;

const VERDICT_LINE = {
  pass: "✅ **Pass**",
  blocked: "⛔ **Blocked**",
  error: "⚠️ **Review incomplete**",
} as const;

// Forges render only text, so icons are emoji. The severity colours follow the
// dashboard's palette (red, orange, sky, muted) so both read the same.
export const SEVERITY_ICON: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🔵",
  info: "⚪",
};

const BUCKET_ICON: Record<Bucket, string> = {
  actionable: "🛠️",
  requirement_gap: "📋",
  outside_diff: "📍",
  nitpick: "🧹",
};

// Actionable findings the inline limits left without a thread.
const HELD_BACK_ICON = "📥";

const OMISSION_TEXT: Record<Omission["reason"], string> = {
  ignored: "ignored by configuration",
  binary: "binary file",
  deleted: "deleted",
  patch_unavailable: "diff not provided by the forge",
  too_large: "too large for one review pass",
  budget: "review pass limit reached",
  chunk_failed: "review pass failed",
};

// Model text is posted under Sentryward's name, so it must not ping people, close
// HTML it did not open, or forge Sentryward's own markers.
export function sanitize(text: string): string {
  return text
    .replace(/<!--\s*sentryward:/gi, "<!-- (quoted) sentryward:")
    .replace(/(^|[^\w`])@(?=[\w-])/g, "$1@​");
}

// For text shown inside an HTML block (details) that may itself contain tags:
// a stray "</details>" would end the block early. Newlines are kept.
export function htmlBlockText(text: string): string {
  return sanitize(text).replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
}

// For text inside HTML (summary tags) and table cells. Backslashes are escaped
// first so text ending in "\" cannot swallow the escape of a following "|".
function inline(text: string): string {
  return codeCell(text.replace(/\\/g, "\\\\"));
}

// For text inside a code span, where markdown keeps backslashes as written but
// a table still needs its pipes escaped.
function codeCell(text: string): string {
  return sanitize(text).replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;")).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

// " · <prefix> <value>" after a finding's severity and category. The value may
// come from outside (an analyzer name from the forge), so it is escaped:
// backslashes with the emphasis characters, in one pass, so a value ending in
// "\" cannot cancel the escape after it.
function labelSuffix(prefix: string, value: string): string {
  return ` · ${prefix} ${codeCell(value.replace(/[\\*_`]/g, "\\$&"))}`;
}

// Names the analyzer behind a tool finding.
export function toolSuffix(finding: Finding): string {
  return finding.source === "tool" && finding.tool ? labelSuffix("via", finding.tool) : "";
}

// Names the team rule behind a rule finding. The id is constrained by the
// config schema, but is escaped like a tool name all the same.
export function ruleSuffix(finding: Finding): string {
  return finding.source === "rule" && finding.ruleId ? labelSuffix("rule", finding.ruleId) : "";
}

// Only an outcome is worth a word: "not checked" on every finding would be
// noise whenever review.verify is off.
export function verificationSuffix(finding: Finding): string {
  if (finding.verification === "verified") return " · ✅ verified";
  if (finding.verification === "uncertain") return " · ❔ uncertain after verification";
  return "";
}

// Impact goes under the explanation; the rationale under the fix it explains.
export function impactLines(finding: Finding): string[] {
  return finding.impact ? ["", `**💥 Impact:** ${sanitize(finding.impact)}`] : [];
}

const MAX_AFFECTED_FILES = 5;

// For text in a code span outside a table: markdown shows any escape
// literally there, so only backticks (which would end the span) are dropped.
function codeSpan(text: string): string {
  return `\`${sanitize(text).replace(/`/g, "").replace(/\n+/g, " ")}\``;
}

// The callers a broken contract breaks. Other findings list files their
// evidence only read (definitions, imports), which are not affected, so they
// show none. Paths come from the model, so they are only ever code.
export function affectedLines(finding: Finding): string[] {
  if (finding.evidence !== "contract") return [];
  const files = finding.evidenceFiles.filter((path) => path !== finding.file);
  if (!files.length) return [];
  const shown = files.slice(0, MAX_AFFECTED_FILES).map(codeSpan);
  const more = files.length - shown.length;
  return ["", `**📎 Affected:** ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`];
}

export function fixRationaleLines(finding: Finding): string[] {
  return finding.fixRationale ? ["", `**🛠️ Why this fix works:** ${sanitize(finding.fixRationale)}`] : [];
}

// A gone finding's snapshot may lack the end line; it then reads as one line.
type Located = { file: string; startLine: number; endLine?: number };

function location(finding: Located): string {
  const end = finding.endLine ?? finding.startLine;
  const lines = finding.startLine === end ? `${finding.startLine}` : `${finding.startLine}-${end}`;
  return `\`${finding.file}:${lines}\``;
}

function indexLine(finding: Located & { severity: Severity; title: string }): string {
  return `- ${SEVERITY_ICON[finding.severity]} **${finding.severity}** ${location(finding)}: ${inline(finding.title)}`;
}

function bucketSummary(bucket: Bucket, count: number): string {
  return `<summary>${BUCKET_ICON[bucket]} ${BUCKET_TITLE[bucket]} (${count})</summary>`;
}

function plural(count: number, word: string, words = `${word}s`): string {
  return `${count} ${count === 1 ? word : words}`;
}

export function fence(code: string, language = ""): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${language}\n${code.replace(/\n$/, "")}\n${ticks}`;
}

function verdictSection(result: ReviewResult): string[] {
  const { verdict, blockOn, blocking } = result.verdict;
  const lines: string[] = [];
  if (verdict === "blocked") {
    lines.push(`${VERDICT_LINE.blocked}: ${plural(blocking.length, "finding")} at or above ${blockOn}.`);
  } else if (verdict === "pass") {
    lines.push(`${VERDICT_LINE.pass}: no findings at or above ${blockOn}.`);
  } else {
    const why = result.status === "failed" ? "the review did not complete" : "part of the change was not reviewed";
    lines.push(`${VERDICT_LINE.error}: ${why}, so the absence of findings is not a pass.`);
  }

  if (blocking.length) {
    const byPrint = new Map(result.findings.map((f) => [f.fingerprint, f]));
    lines.push("");
    for (const print of blocking) {
      const finding = byPrint.get(print);
      if (finding) lines.push(indexLine(finding));
    }
  }
  return lines;
}

function countsLine(result: ReviewResult): string {
  const summary = summarize(result);
  if (summary.total === 0) return "No findings.";
  const severities = SEVERITIES.filter((s) => summary.bySeverity[s])
    .map((s) => `${summary.bySeverity[s]} ${s}`)
    .join(", ");
  const inlineCount = summary.byBucket.actionable ?? 0;
  const rest = summary.total - inlineCount;
  return `${plural(summary.total, "finding")} (${severities}): ${inlineCount} actionable, ${rest} in the sections below.`;
}

const ASSESSMENT_TEXT: Record<IssueAssessment, string> = {
  addressed: "✅ Addressed",
  partial: "🟡 Partly addressed",
  not_addressed: "❌ Not addressed",
  unclear: "❔ Unclear",
};

function issueLink(issue: IssueRef): string {
  const title = inline(issue.title);
  return issue.url && /^https?:\/\//.test(issue.url) ? `[${issue.ref}](${issue.url}) ${title}` : `${issue.ref} ${title}`;
}

// The optional walkthrough parts. Each is only in the result when its setting
// was on, so a stored review renders as it was produced.
function walkthroughExtras(walkthrough: Walkthrough, options: WalkthroughOptions): string[] {
  const lines: string[] = [];
  if (walkthrough.sequenceDiagram) {
    lines.push("", "<details>", "<summary>📊 Sequence diagram</summary>", "", fence(walkthrough.sequenceDiagram, "mermaid"), "", "</details>");
  }
  if (walkthrough.linkedIssues?.length) {
    lines.push("", "<details open>", `<summary>🔗 Linked issues (${walkthrough.linkedIssues.length})</summary>`, "");
    lines.push("| Issue | Assessment | Notes |", "| --- | --- | --- |");
    for (const issue of walkthrough.linkedIssues) {
      lines.push(`| ${issueLink(issue)} | ${ASSESSMENT_TEXT[issue.assessment]} | ${inline(issue.note)} |`);
    }
    lines.push("", "</details>");
  }
  if (walkthrough.relatedIssues?.length) {
    lines.push("", "<details>", `<summary>🔍 Possibly related issues (${walkthrough.relatedIssues.length})</summary>`, "");
    for (const issue of walkthrough.relatedIssues) {
      lines.push(`- ${issueLink(issue)}${issue.reason ? `: ${inline(issue.reason)}` : ""}`);
    }
    lines.push("", "</details>");
  }
  return lines;
}

export interface WalkthroughOptions {
  // output.estimateEffort; the estimate is still made, for the effort label.
  effort?: boolean;
  // The high-level summary goes in the walkthrough rather than the description.
  highLevelSummary?: boolean;
  // output.walkthroughLabels and output.walkthroughBlastRadius.
  labels?: boolean;
  blastRadius?: boolean;
}

// Display options from a config's output settings. Missing settings, as in a
// job stored before they existed, render as those jobs were.
export function walkthroughOptions(
  output:
    | {
        estimateEffort?: boolean;
        highLevelSummaryPlacement?: string;
        walkthroughLabels?: boolean;
        walkthroughBlastRadius?: boolean;
      }
    | undefined,
): WalkthroughOptions {
  return {
    effort: output?.estimateEffort !== false,
    highLevelSummary: output?.highLevelSummaryPlacement === "walkthrough",
    labels: output?.walkthroughLabels !== false,
    blastRadius: output?.walkthroughBlastRadius !== false,
  };
}

// The heading the comment opens with, and the walkthrough under it. A
// high-level summary placed in the walkthrough takes the overview's place, so
// the comment does not describe the change twice; the overview is still the
// fallback when this review has no summary.
function walkthroughSection(
  result: ReviewResult,
  options: WalkthroughOptions = {},
): { heading: string; lines: string[] } | null {
  const walkthrough = result.walkthrough;
  if (!walkthrough) return null;
  const summary = options.highLevelSummary ? walkthrough.highLevelSummary : undefined;
  const heading = summary ? "## High-level summary" : "## Summary";
  const lines = ["", sanitize(summary ?? walkthrough.overview)];
  const meta = [
    options.labels !== false && walkthrough.labels.length ? `🏷️ Labels: ${walkthrough.labels.map((l) => `\`${codeCell(l)}\``).join(", ")}` : "",
    options.effort !== false ? `⏱️ Review effort: ${walkthrough.estimatedEffort}/5` : "",
    options.blastRadius !== false && walkthrough.blastRadius ? `💥 Blast radius: ${walkthrough.blastRadius}` : "",
  ].filter(Boolean);
  if (meta.length) lines.push("", meta.join(" · "));
  // Part of the blast radius, so its setting hides both.
  if (options.blastRadius !== false && walkthrough.riskyAreas?.length) {
    lines.push("", "<details open>", `<summary>⚠️ Risky areas (${walkthrough.riskyAreas.length})</summary>`, "");
    lines.push("| Area | File | Why |", "| --- | --- | --- |");
    for (const area of walkthrough.riskyAreas) {
      const why = area.via ? `${area.reason} (${area.via})` : area.reason;
      lines.push(`| ${RISK_KIND_TEXT[area.kind]} | \`${codeCell(area.path)}\` | ${inline(why)} |`);
    }
    lines.push("", "</details>");
  }
  if (walkthrough.fileSummaries.length) {
    lines.push("", "<details>", `<summary>📂 Changes (${plural(walkthrough.fileSummaries.length, "file")})</summary>`, "");
    lines.push("| File | Summary |", "| --- | --- |");
    for (const entry of walkthrough.fileSummaries) {
      lines.push(`| \`${codeCell(entry.path)}\` | ${inline(entry.summary)} |`);
    }
    lines.push("", "</details>");
  }
  lines.push(...walkthroughExtras(walkthrough, options));
  return { heading, lines };
}

function findingDetail(finding: Finding): string[] {
  const lines = [
    `#### ${location(finding)}: ${inline(finding.title)}`,
    "",
    `${SEVERITY_ICON[finding.severity]} *${finding.severity} · ${finding.category} · ${finding.kind.replace(/_/g, " ")}${toolSuffix(finding)}${ruleSuffix(finding)}${verificationSuffix(finding)}*`,
    "",
    sanitize(finding.body),
    ...impactLines(finding),
    ...affectedLines(finding),
  ];
  if (finding.evidenceNote) lines.push("", `**🔎 Evidence:** ${sanitize(finding.evidenceNote)}`);
  if (finding.suggestion) lines.push("", fence(finding.suggestion));
  lines.push(...fixRationaleLines(finding));
  return lines;
}

function detailSection(summary: string, findings: Finding[]): string[] {
  const lines = ["", "<details>", summary, ""];
  findings.forEach((finding, index) => {
    if (index) lines.push("");
    lines.push(...findingDetail(finding));
  });
  lines.push("", "</details>");
  return lines;
}

function bucketSections(result: ReviewResult, limits?: InlineLimits): string[] {
  const lines: string[] = [];
  const { inline: actionable, heldBack } = inlineSelection(result.findings, limits);
  if (actionable.length) {
    // Each has its own inline thread; the summary only indexes them.
    lines.push("", "<details>", bucketSummary("actionable", actionable.length), "");
    for (const finding of actionable) {
      lines.push(indexLine(finding));
    }
    lines.push("", "</details>");
  }
  // Below the inline threshold or over the cap: no thread holds them, so the
  // summary carries them in full.
  if (heldBack.length) {
    lines.push(...detailSection(`<summary>${HELD_BACK_ICON} Not posted inline (${heldBack.length})</summary>`, heldBack));
  }
  for (const bucket of SUMMARY_BUCKETS) {
    const findings = result.findings.filter((f) => f.bucket === bucket);
    if (!findings.length) continue;
    lines.push(...detailSection(bucketSummary(bucket, findings.length), findings));
  }
  return lines;
}

function coverageSection(result: ReviewResult): string[] {
  const lines: string[] = [];
  const { omissions } = result.coverage;
  if (omissions.length) {
    lines.push("", "<details>", `<summary>🚫 Not reviewed (${plural(omissions.length, "item")})</summary>`, "");
    for (const omission of omissions) {
      const detail = omission.detail ? `, ${inline(omission.detail)}` : "";
      lines.push(`- \`${codeCell(omission.path)}\`: ${OMISSION_TEXT[omission.reason]}${detail}`);
    }
    lines.push("", "</details>");
  }
  const notes = [...result.errors, ...result.warnings];
  if (notes.length) {
    lines.push("", "**📝 Notes**", "", ...notes.map((note) => `- ${inline(note)}`));
  }
  return lines;
}

// Says up front that the findings below are partly an earlier review's, so a
// reader does not take untouched files as freshly checked. Counts the files a
// pass actually finished, not the ones planned, so a failed pass is not
// reported as reviewed.
function incrementalNote(result: ReviewResult): string[] {
  const { incremental } = result;
  if (!incremental) return [];
  const range = `\`${incremental.fromSha.slice(0, 7)}..${incremental.toSha.slice(0, 7)}\``;
  const carried = incremental.carried ? `; ${plural(incremental.carried, "finding")} carried over from the earlier review` : "";
  const planned = incremental.files.length;
  const reviewedFiles = new Set(result.coverage.reviewedFiles);
  const reviewed = incremental.files.filter((path) => reviewedFiles.has(path)).length;
  let scope: string;
  if (planned === 0) scope = "no file of this change was touched since the last review";
  else if (reviewed === planned) {
    scope = `${plural(planned, "file")} changed since the last review ${planned === 1 ? "was" : "were"} reviewed`;
  } else scope = `${reviewed} of ${plural(planned, "file")} changed since the last review ${reviewed === 1 ? "was" : "were"} reviewed`;
  return ["", `> 🔁 Incremental review of ${range}: ${scope}${carried}.`];
}

const INVALIDATED_TEXT: Record<InvalidatedReason, string> = {
  renamed: "file renamed",
  deleted: "file deleted",
  left_change: "file no longer in the change",
  moved: "moved to another file",
};

function goneLine(gone: Lifecycle["gone"][number]): string {
  const why = gone.reason ? ` (${INVALIDATED_TEXT[gone.reason]})` : "";
  return `${indexLine(gone)}${why}`;
}

// Each list is capped so a large refactor (hundreds of findings invalidated by
// renames) cannot push the comment past the forge's size limit.
const LIFECYCLE_LIMIT = 20;

function capped(items: string[]): string[] {
  if (items.length <= LIFECYCLE_LIMIT) return items;
  return [...items.slice(0, LIFECYCLE_LIMIT), `- …and ${items.length - LIFECYCLE_LIMIT} more`];
}

// What this run changed against the earlier reviews of the change. New, still
// open and reopened findings are also in the sections below; the lists here
// say which is which, and name the gone ones, which are nowhere else.
// Invalidated findings are kept apart from fixed ones: their code was moved or
// removed, so they no longer apply, but nothing says they were fixed. Left out
// when every list is empty: earlier findings were all ignored or resolved
// before, and this run reports none.
function lifecycleSection(result: ReviewResult): string[] {
  const { lifecycle } = result;
  if (!lifecycle) return [];
  const byPrint = new Map(result.findings.map((f) => [f.fingerprint, f]));
  const listed = (prints: string[]) => prints.flatMap((print) => {
    const finding = byPrint.get(print);
    return finding ? [indexLine(finding)] : [];
  });
  const fixed = lifecycle.gone.filter((gone) => gone.outcome === "fixed");
  const invalidated = lifecycle.gone.filter((gone) => gone.outcome === "invalidated");
  const groups: [string, string, string[]][] = [
    ["🆕", "New", listed(lifecycle.new)],
    ["⏳", "Still open", listed(lifecycle.stillOpen)],
    ["↩️", "Reopened", listed(lifecycle.reopened)],
    ["✅", "Fixed", fixed.map(goneLine)],
    ["♻️", "Invalidated", invalidated.map(goneLine)],
  ];
  const counts = groups.filter(([, , items]) => items.length).map(([, label, items]) => `${items.length} ${label.toLowerCase()}`);
  if (!counts.length) return [];
  const lines = ["", `> 🔄 Since the last review: ${counts.join(", ")}.`];
  for (const [icon, label, items] of groups) {
    if (!items.length) continue;
    lines.push("", "<details>", `<summary>${icon} ${label} (${items.length})</summary>`, "", ...capped(items), "", "</details>");
  }
  return lines;
}

function footer(result: ReviewResult): string {
  const models = [...new Set(result.usage.map((u) => u.model))].join(", ") || "no model call";
  const passes = plural(result.coverage.passes, "review pass", "review passes");
  const refuted = result.validation.dropped.refuted ?? 0;
  const verification = refuted ? ` · ${plural(refuted, "finding")} refuted on verification` : "";
  const commits = result.incremental
    ? `${result.incremental.fromSha.slice(0, 7)}..${result.change.headSha.slice(0, 7)}`
    : result.change.headSha.slice(0, 7);
  return `<sub>Reviewed \`${commits}\` with ${models} · ${passes} · ${plural(result.coverage.reviewedFiles.length, "file")} reviewed${verification}</sub>`;
}

// The one markdown document for a review. The forge summary comment and the
// dashboard's "copy markdown" are this function's output, byte for byte; it
// depends only on the result, so re-rendering a stored review reproduces it.
// The walkthrough, when there is one, opens the document under its heading
// (walkthroughSection), so one comment carries what the change does and what
// the review found. `walkthrough: false` leaves it out, `counts: false` the line
// counting the findings (output.findingCounts), `stats: false` the line
// naming the commit, models and coverage (output.reviewStats), `lifecycle:
// false` the comparison with the earlier reviews (output.findingLifecycle),
// `agentPrompt: false` the one prompt covering every finding
// (output.agentPromptAll), and `inline` holds back the actionable findings
// the inline limits leave without a thread (output.inlineMinSeverity,
// output.maxInlineComments). The rest shape the walkthrough (walkthroughOptions).
export function toMarkdown(
  result: ReviewResult,
  options: {
    walkthrough?: boolean;
    counts?: boolean;
    stats?: boolean;
    lifecycle?: boolean;
    agentPrompt?: boolean;
    inline?: InlineLimits;
  } & WalkthroughOptions = {},
): string {
  const walkthrough = options.walkthrough === false ? null : walkthroughSection(result, options);
  const lines = [walkthrough?.heading ?? "## Summary", ...(walkthrough?.lines ?? [])];
  lines.push("", ...verdictSection(result));
  if (options.counts !== false) lines.push("", countsLine(result));
  lines.push(...incrementalNote(result));
  if (options.lifecycle !== false) lines.push(...lifecycleSection(result));
  lines.push(...bucketSections(result, options.inline));
  if (options.agentPrompt !== false && result.findings.length) {
    lines.push("", ...agentPromptBlock(`Prompt for AI agents (${plural(result.findings.length, "finding")})`, allFindingsPrompt(result.findings)));
  }
  lines.push(...coverageSection(result));
  if (options.stats !== false) lines.push("", footer(result));
  lines.push("", BRAND_FOOTER, "", SUMMARY_MARKER);
  return `${lines.join("\n")}\n`;
}

// The walkthrough on its own, for a comment of its own while the review
// comment is turned off. Empty when the review has none.
export function walkthroughMarkdown(result: ReviewResult, options: WalkthroughOptions = {}): string {
  const section = walkthroughSection(result, options);
  if (!section) return "";
  return `${[section.heading, ...section.lines, "", BRAND_FOOTER].join("\n")}\n`;
}

// The high-level summary as a block for the PR/MR description, between
// markers so a later run replaces it and a review never reads it back as the
// author's text. Empty when the review has none.
export function descriptionSummaryBlock(result: ReviewResult): string {
  const summary = result.walkthrough?.highLevelSummary;
  if (!summary) return "";
  return [DESCRIPTION_SUMMARY_START, "## High-level summary", "", sanitize(summary), DESCRIPTION_SUMMARY_END].join("\n");
}
