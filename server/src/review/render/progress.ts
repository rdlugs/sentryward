import type { ChangeSet } from "../core/models.ts";
import { SUMMARY_MARKER } from "../core/markers.ts";
import { FORGE_INFO } from "../forge/providers.ts";
import { BRAND_FOOTER, PROGRESS_BADGE_URL } from "./markdown.ts";

// Where the dashboard shows this run's live progress, when it is reachable.
export interface ProgressOutputs {
  targetUrl?: string;
}

// Posted when a review starts and replaced by the summary when it ends; it
// carries the summary marker so the replacement edits this same comment. No
// heading and no details (file counts, what will be posted): it is a loading
// state, and the animated badge carries it; the text only names the commit.
export function progressMarkdown(changeSet: ChangeSet, outputs: ProgressOutputs = {}): string {
  const { provider, headSha, webUrl } = changeSet.forgeRef;
  const short = `\`${headSha.slice(0, 7)}\``;
  const sha = webUrl ? `[${short}](${FORGE_INFO[provider].commitUrl(webUrl, headSha)})` : short;
  return card([
    `<img src="${PROGRESS_BADGE_URL}" alt="Review in progress" width="360" height="48">`,
    `Reviewing ${sha} · results will replace this comment`,
    ...(outputs.targetUrl ? [`[View live progress](${outputs.targetUrl})`] : []),
  ]);
}

// Replaces the progress note when a run stops early, so the change does not
// keep promising a review that will never arrive.
export function cancelledMarkdown(reason: string): string {
  return card(["🚫 **Review cancelled**", `${reason}.`]);
}

function card(lines: string[]): string {
  return [...lines.flatMap((line) => [line, ""]), BRAND_FOOTER, "", SUMMARY_MARKER, ""].join("\n");
}
