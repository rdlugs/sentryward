import { describe, expect, it } from "vitest"
import { parsePatch } from "./parsePatch"

describe("parsePatch", () => {
  it("numbers old and new lines from each hunk header", () => {
    const rows = parsePatch(
      ["@@ -10,3 +10,3 @@ fn main", " a", "-b", "+B", " c", "@@ -40 +40,2 @@", " x", "+y"].join("\n"),
    )
    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,3 @@ fn main" },
      { kind: "ctx", oldLine: 10, newLine: 10, text: "a" },
      { kind: "del", oldLine: 11, text: "b" },
      { kind: "add", newLine: 11, text: "B" },
      { kind: "ctx", oldLine: 12, newLine: 12, text: "c" },
      { kind: "hunk", text: "@@ -40 +40,2 @@" },
      { kind: "ctx", oldLine: 40, newLine: 40, text: "x" },
      { kind: "add", newLine: 41, text: "y" },
    ])
  })

  it("skips no-newline markers and a trailing newline, but keeps blank context lines", () => {
    const rows = parsePatch("@@ -1,3 +1,3 @@\n a\n\n-b\n\\ No newline at end of file\n+c\n")
    expect(rows.map((row) => row.kind)).toEqual(["hunk", "ctx", "ctx", "del", "add"])
    expect(rows[2]).toEqual({ kind: "ctx", oldLine: 2, newLine: 2, text: "" })
  })

  it("returns nothing for an empty patch", () => {
    expect(parsePatch("")).toEqual([])
  })
})
