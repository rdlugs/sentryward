export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "add"; newLine: number; text: string }
  | { kind: "del"; oldLine: number; text: string }
  | { kind: "ctx"; oldLine: number; newLine: number; text: string }

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// A stored patch (the forge's hunks, each starting at its @@ line) as rows
// with old and new line numbers. "\ No newline at end of file" says nothing a
// reader needs here, so it is left out.
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      inHunk = true
      rows.push({ kind: "hunk", text: line })
      continue
    }
    if (!inHunk || line.startsWith("\\")) continue
    if (line.startsWith("+")) rows.push({ kind: "add", newLine: newLine++, text: line.slice(1) })
    else if (line.startsWith("-")) rows.push({ kind: "del", oldLine: oldLine++, text: line.slice(1) })
    // A blank line inside a hunk is a context line whose leading space was trimmed.
    else rows.push({ kind: "ctx", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) })
  }
  // A patch ends with a newline, which would otherwise read as a blank context line.
  const last = rows.at(-1)
  if (last?.kind === "ctx" && last.text === "" && patch.endsWith("\n")) rows.pop()
  return rows
}
