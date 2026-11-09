import type { Rule } from "../config/schema.ts";
import type { ChangeSet, Finding, ForgeProvider } from "../core/models.ts";
import { fingerprintMarker } from "../core/markers.ts";
import { FORGE_INFO } from "../forge/providers.ts";
import type { InlineComment } from "../forge/types.ts";
import { agentPromptBlock, findingPrompt } from "../render/agentPrompt.ts";
import {
  BRAND_FOOTER,
  SEVERITY_ICON,
  fixRationaleLines,
  affectedLines,
  impactLines,
  ruleLines,
  sanitize,
  ruleSuffix,
  toolSuffix,
  verificationSuffix,
} from "../render/markdown.ts";

function fence(code: string, info: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${info}\n${code.replace(/\n$/, "")}\n${ticks}`;
}

export interface InlineOptions {
  // output.agentPrompts; on unless turned off.
  agentPrompt?: boolean;
  // The resolved config's rules, to spell out the one a rule finding broke.
  rules?: Rule[];
  // Fingerprints the inline limits held back to the summary
  // (core/buckets.ts inlineSelection, decided once by the caller).
  heldBack?: ReadonlySet<string>;
}

export function inlineBody(finding: Finding, provider: ForgeProvider, options: InlineOptions = {}): string {
  const lines = [
    `${SEVERITY_ICON[finding.severity]} **${finding.severity}** · ${finding.category}${finding.kind === "potential_issue" ? "" : ` · ${finding.kind.replace(/_/g, " ")}`}${toolSuffix(finding)}${ruleSuffix(finding)}${verificationSuffix(finding)}`,
    "",
    `**${sanitize(finding.title)}**`,
    "",
    sanitize(finding.body),
    ...impactLines(finding),
    ...affectedLines(finding),
  ];
  if (finding.suggestion) lines.push("", fence(finding.suggestion, FORGE_INFO[provider].suggestionInfo(finding.startLine, finding.endLine)));
  lines.push(...fixRationaleLines(finding));
  lines.push(...ruleLines(finding, options.rules));
  // Collapsed like the agent prompt: supporting detail, not what a reader needs first.
  if (finding.evidenceNote) lines.push("", "<details>", "<summary>🔎 Evidence</summary>", "", sanitize(finding.evidenceNote), "", "</details>");
  if (options.agentPrompt !== false) lines.push("", ...agentPromptBlock("Prompt for AI agents", findingPrompt(finding)));
  lines.push("", BRAND_FOOTER, "", fingerprintMarker(finding.fingerprint));
  return lines.join("\n");
}

// Only actionable findings become inline threads, and of those only the ones
// the inline limits did not hold back; everything else lives in the summary.
// The bucket was decided once, when the finding was validated.
export function inlineComments(
  findings: Finding[],
  changeSet: ChangeSet,
  provider: ForgeProvider,
  alreadyPosted: Set<string>,
  options: InlineOptions = {},
): InlineComment[] {
  const files = new Map(changeSet.files.map((file) => [file.path, file]));
  const comments: InlineComment[] = [];
  for (const finding of findings) {
    if (finding.bucket !== "actionable" || alreadyPosted.has(finding.fingerprint)) continue;
    if (options.heldBack?.has(finding.fingerprint)) continue;
    const file = files.get(finding.file);
    if (!file) continue;
    const oldLine = file.hunks
      .map((hunk) => hunk.contextOldLines[String(finding.startLine)])
      .find((line) => line !== undefined);
    comments.push({
      fingerprint: finding.fingerprint,
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      startLine: finding.startLine,
      endLine: finding.endLine,
      ...(oldLine !== undefined ? { oldLine } : {}),
      body: inlineBody(finding, provider, options),
    });
  }
  return comments;
}
