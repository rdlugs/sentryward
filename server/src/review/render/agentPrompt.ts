import type { Finding } from "../core/models.ts";
import { severityRank } from "../core/severity.ts";
import { fence, sanitize } from "./markdown.ts";

// Plain text a reader pastes into a coding agent. Each prompt stands on its own
// (file, lines, what is wrong, the proposed fix) because the agent sees none of
// the surrounding comment. Findings can be stale by the time someone acts on
// them, so the agent is told to check before editing.
const VERIFY = "Verify this against the current code first; it may already be fixed.";

// Marks where suggested code starts and ends, so it stays apart from the prose
// in a long plain-text prompt where no markdown renders.
const CODE_DELIMITER = "----";

function lines(finding: Finding): string {
  return finding.startLine === finding.endLine
    ? `line ${finding.startLine}`
    : `lines ${finding.startLine}-${finding.endLine}`;
}

function location(finding: Finding): string {
  // A requirement gap placed in no changed file.
  if (!finding.file) return "the change";
  const range = finding.startLine === finding.endLine ? `${finding.startLine}` : `${finding.startLine}-${finding.endLine}`;
  return `${finding.file}:${range}`;
}

function suggestion(finding: Finding): string {
  return finding.suggestion!.replace(/\n$/, "");
}

function describe(finding: Finding): string[] {
  const where = finding.file ? `In ${finding.file} around ${lines(finding)}` : "In this change";
  const parts = [`${where}: ${finding.title.trim()}`, "", finding.body.trim()];
  if (finding.impact) parts.push("", `Impact: ${finding.impact.trim()}`);
  if (finding.suggestion) parts.push("", "Suggested replacement for those lines:", "", suggestion(finding));
  if (finding.fixRationale) parts.push("", `Why this fix works: ${finding.fixRationale.trim()}`);
  return parts;
}

export function findingPrompt(finding: Finding): string {
  return sanitize([...describe(finding), "", VERIFY].join("\n"));
}

// Every finding in the review, most severe first so an agent (or a person
// trimming the paste) gets to the important ones before the nitpicks.
export function allFindingsPrompt(findings: Finding[]): string {
  const ordered = [...findings].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.file.localeCompare(b.file) || a.startLine - b.startLine,
  );
  const parts = [
    "Verify each finding against the current code and only fix it if it still applies. Ordered by severity, most severe first.",
    "",
  ];
  ordered.forEach((finding, index) => {
    parts.push(`${index + 1}. [${finding.severity}] ${location(finding)} - ${finding.title.trim()}`, finding.body.trim());
    if (finding.suggestion) parts.push("Suggested replacement:", CODE_DELIMITER, suggestion(finding), CODE_DELIMITER);
    parts.push("");
  });
  return sanitize(parts.join("\n").trimEnd());
}

// Collapsed, so it never crowds out the comment a person reads first.
export function agentPromptBlock(title: string, prompt: string): string[] {
  return ["<details>", `<summary>🤖 ${title}</summary>`, "", fence(prompt), "", "</details>"];
}
