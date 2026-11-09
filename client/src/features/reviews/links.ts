import { PROVIDERS } from "@/features/forge/providers"
import type { Provider, ReviewListItem } from "./types"

// A link to the reviewed revision of a file at a line range.
export function forgeFileUrl(
  change: { provider: Provider; host: string; project: string; headSha: string },
  file: string,
  startLine: number,
  endLine: number,
) {
  const path = file.split("/").map(encodeURIComponent).join("/")
  return PROVIDERS[change.provider].fileUrl(change.host, change.project, change.headSha, path, startLine, endLine)
}

// "12" or "12-14", as a finding's location is written.
export function findingLines(finding: { startLine: number; endLine: number }) {
  return finding.startLine === finding.endLine ? `${finding.startLine}` : `${finding.startLine}-${finding.endLine}`
}

export function changeLabel(provider: Provider, number: number) {
  return PROVIDERS[provider].changeLabel(number)
}

// "Pull request #42" or "Merge request !42": a change before it has a title.
export function untitledChange(provider: Provider, number: number) {
  return `${PROVIDERS[provider].changeNoun} ${changeLabel(provider, number)}`
}

// What a review is called in lists and dialogs: the change title, or "Pull request #42" before there is one.
export function changeTitle(review: ReviewListItem) {
  return review.title ?? review.summary?.title ?? untitledChange(review.repository.provider, review.number)
}
