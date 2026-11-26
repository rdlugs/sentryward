import { SEVERITIES, type Finding } from "./types"

// Same text as the prompts in the forge comment (server/src/review/render/agentPrompt.ts),
// so copying from the dashboard and from the PR gives the agent the same thing. Keep the
// two in sync. The server also escapes forge mentions; a clipboard paste needs none of that.
const VERIFY = "Verify this against the current code first; it may already be fixed."

// Marks where suggested code starts and ends, so it stays apart from the prose.
const CODE_DELIMITER = "----"

function lines(finding: Finding) {
  return finding.startLine === finding.endLine
    ? `line ${finding.startLine}`
    : `lines ${finding.startLine}-${finding.endLine}`
}

function location(finding: Finding) {
  // A requirement gap placed in no changed file.
  if (!finding.file) return "the change"
  const range = finding.startLine === finding.endLine ? `${finding.startLine}` : `${finding.startLine}-${finding.endLine}`
  return `${finding.file}:${range}`
}

function suggestion(finding: Finding) {
  return (finding.suggestion ?? "").replace(/\n$/, "")
}

function describe(finding: Finding) {
  const where = finding.file ? `In ${finding.file} around ${lines(finding)}` : "In this change"
  const parts = [`${where}: ${finding.title.trim()}`, "", finding.body.trim()]
  if (finding.impact) parts.push("", `Impact: ${finding.impact.trim()}`)
  if (finding.suggestion) parts.push("", "Suggested replacement for those lines:", "", suggestion(finding))
  if (finding.fixRationale) parts.push("", `Why this fix works: ${finding.fixRationale.trim()}`)
  return parts
}

export function findingPrompt(finding: Finding) {
  return [...describe(finding), "", VERIFY].join("\n")
}

// SEVERITIES runs most severe first, so a lower index sorts earlier.
export function allFindingsPrompt(findings: Finding[]) {
  const ordered = [...findings].sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine,
  )
  const parts = [
    "Verify each finding against the current code and only fix it if it still applies. Ordered by severity, most severe first.",
    "",
  ]
  ordered.forEach((finding, index) => {
    parts.push(`${index + 1}. [${finding.severity}] ${location(finding)} - ${finding.title.trim()}`, finding.body.trim())
    if (finding.suggestion) parts.push("Suggested replacement:", CODE_DELIMITER, suggestion(finding), CODE_DELIMITER)
    parts.push("")
  })
  return parts.join("\n").trimEnd()
}
