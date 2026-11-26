// A requirement gap the walkthrough placed in no changed file is stored with
// an empty file (server/src/review/core/requirementGaps.ts). Its title already
// names the issue, so surfaces show this instead of a meaningless ":1".
export const NO_FILE_LABEL = "Linked issue"

export function findingLocation(file: string, lines: string | number): string {
  return file ? `${file}:${lines}` : NO_FILE_LABEL
}
