import type { ChangeSet } from "../core/models.ts";
import { SUMMARY_MARKER } from "../core/markers.ts";
import { FORGE_INFO } from "../forge/providers.ts";
import { STATUS_CONTEXT } from "../forge/types.ts";
import { BRAND_FOOTER, PROGRESS_BAR_URL } from "./markdown.ts";

// What this run will publish, so the placeholder only promises what arrives,
// and where the dashboard shows its live progress.
export interface ProgressOutputs {
  walkthrough: boolean;
  inline: boolean;
  status: boolean;
  targetUrl?: string;
}

// Posted when a review starts and replaced by the summary when it ends; it
// carries the summary marker so the replacement edits this same comment. No
// heading: it is a status card, not an (empty) report.
export function progressMarkdown(changeSet: ChangeSet, outputs: ProgressOutputs): string {
  const { provider, headSha, webUrl } = changeSet.forgeRef;
  const short = `\`${headSha.slice(0, 7)}\``;
  const sha = webUrl ? `[${short}](${FORGE_INFO[provider].commitUrl(webUrl, headSha)})` : short;
  const expect = [outputs.walkthrough ? "📝 Walkthrough and summary appear here" : "📝 Summary appears here"];
  if (outputs.inline) expect.push("💬 Findings land inline on the diff");
  if (outputs.status) expect.push(`✔️ \`${STATUS_CONTEXT}\` status`);
  return card([
    `<img src="${PROGRESS_BAR_URL}" alt="Review in progress" width="320" height="4">`,
    `⏳ **Review in progress** · ${sha}`,
    scope(changeSet),
    expect.join(" · "),
    ...(outputs.targetUrl ? [`[View live progress ↗](${outputs.targetUrl})`] : []),
  ]);
}

// Replaces the progress note when a run stops early, so the change does not
// keep promising a review that will never arrive.
export function cancelledMarkdown(reason: string): string {
  return card(["⏹️ **Review cancelled**", `${reason}.`]);
}

function card(lines: string[]): string {
  return [...lines.flatMap((line) => [line, ""]), BRAND_FOOTER, "", SUMMARY_MARKER, ""].join("\n");
}

// Counted from the parsed hunks, so binary files and files whose patch the
// forge withheld count as files but add no lines. Every "-" line after a
// hunk header is a removal (file headers are not part of hunk content).
function scope(changeSet: ChangeSet): string {
  let added = 0;
  let removed = 0;
  for (const file of changeSet.files) {
    for (const hunk of file.hunks) {
      added += hunk.addedLines.length;
      removed += hunk.content.split("\n").slice(1).filter((line) => line.startsWith("-")).length;
    }
  }
  const files = changeSet.files.length;
  return `📂 ${files} ${files === 1 ? "file" : "files"} · ➕ ${added} ➖ ${removed}`;
}
