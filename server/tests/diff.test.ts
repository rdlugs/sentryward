import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffPosition, isAddedLine, newFileLines, type ChangedFile } from "../src/review/core/models.ts";
import { parsePatch, parseUnifiedDiff, toChangedFile } from "../src/review/diff/parse.ts";

const fixture = join(import.meta.dirname, "fixtures/diffs/basic");
const files = parseUnifiedDiff(readFileSync(join(fixture, "diff.patch"), "utf8"));
const byPath = new Map(files.map((file) => [file.path, file]));

// Position p is the p-th line below the file's first @@, so this recovers the
// patch text a position points at.
function patchLines(path: string): string[] {
  const patch = readFileSync(join(fixture, "diff.patch"), "utf8");
  const section = patch.split(/^(?=diff --git )/m).find((s) => s.includes(` b/${path}\n`))!;
  const lines = section.split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@"));
  return lines.slice(first);
}

describe("parseUnifiedDiff against a real git diff", () => {
  it("finds every file with its change type", () => {
    expect(files.map((f) => [f.path, f.changeType])).toEqual([
      ["added.ts", "added"],
      ["deleted.txt", "deleted"],
      ["multi.txt", "modified"],
      ["noeol.txt", "modified"],
      ["renamed.txt", "renamed"],
    ]);
    expect(byPath.get("renamed.txt")?.previousPath).toBe("rename-old.txt");
    expect(byPath.get("added.ts")?.language).toBe("typescript");
  });

  // The invariant everything downstream depends on: a mapped new-file line
  // number must name the same text in the real file on disk.
  it.each(["added.ts", "multi.txt", "noeol.txt", "renamed.txt"])(
    "maps every new line in %s to its real content and position",
    (path) => {
      const file = byPath.get(path)!;
      const after = readFileSync(join(fixture, "after", path), "utf8").split("\n");
      const patch = patchLines(path);
      const mapped = file.hunks.flatMap((hunk) => Object.entries(hunk.newLineToPosition));

      expect(mapped.length).toBeGreaterThan(0);
      for (const [line, position] of mapped) {
        expect(patch[position]!.slice(1)).toBe(after[Number(line) - 1]);
      }
    },
  );

  it("marks only added lines as added", () => {
    const multi = byPath.get("multi.txt")!;
    expect(multi.hunks.flatMap((h) => h.addedLines)).toEqual([3, 31, 32, 59]);
    expect(isAddedLine(multi, 31)).toBe(true);
    expect(isAddedLine(multi, 30)).toBe(false);
  });

  it("keeps counting positions across hunk headers", () => {
    const multi = byPath.get("multi.txt")!;
    // Hunk 1 spans positions 1-7 ("-line 3" is 3, "+line three" is 4); the
    // second @@ is position 8.
    expect(diffPosition(multi, 3)).toBe(4);
    expect(diffPosition(multi, 28)).toBe(9);
    expect(diffPosition(multi, 59)).toBe(diffPosition(multi, 58)! + 2);
  });

  it("records the old line of every context line", () => {
    const multi = byPath.get("multi.txt")!;
    // Two lines were added and one removed above, so new 33 was old 32.
    expect(multi.hunks[1]!.contextOldLines["33"]).toBe(32);
    expect(multi.hunks[0]!.contextOldLines["1"]).toBe(1);
    expect(multi.hunks[0]!.contextOldLines["3"]).toBeUndefined();
  });

    it("gives lines outside every hunk no position", () => {
    expect(diffPosition(byPath.get("multi.txt")!, 15)).toBeUndefined();
  });

  it("counts the no-newline marker as a position without mapping it", () => {
    const noeol = byPath.get("noeol.txt")!;
    expect(noeol.hunks[0]!.addedLines).toEqual([2, 3, 4]);
    // " a", "-b", "-c", "\ No newline", "+B", "+c", "+d"
    expect(diffPosition(noeol, 2)).toBe(5);
    expect(diffPosition(noeol, 4)).toBe(7);
  });

  it("maps no new lines for a deleted file", () => {
    const deleted = byPath.get("deleted.txt")!;
    expect(deleted.hunks.flatMap((h) => Object.keys(h.newLineToPosition))).toEqual([]);
  });
});

describe("parsePatch", () => {
  it("treats an omitted hunk length as 1", () => {
    const [hunk] = parsePatch("@@ -1 +1 @@\n-old\n+new");
    expect(hunk).toMatchObject({ oldLines: 1, newLines: 1, addedLines: [1] });
  });

  it("captures the section header text", () => {
    const [hunk] = parsePatch("@@ -10,2 +10,2 @@ function main() {\n a\n-b\n+c");
    expect(hunk!.header).toBe("function main() {");
  });

  it("handles CRLF patches", () => {
    const [hunk] = parsePatch("@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n");
    expect(hunk!.addedLines).toEqual([2]);
    expect(hunk!.newLineToPosition).toEqual({ "1": 1, "2": 3 });
    expect(hunk!.contextOldLines).toEqual({ "1": 1 });
  });
});

describe("newFileLines", () => {
  const file: ChangedFile = {
    path: "a.ts",
    changeType: "modified",
    isBinary: false,
    patchUnavailable: false,
    hunks: parsePatch("@@ -5,4 +5,4 @@\n keep\n-gone\n+added\n tail\n-last\n\\ No newline at end of file\n+last\n"),
  };

  it("reads new-file text across removed lines and no-newline markers", () => {
    expect(newFileLines(file, 5, 6)).toEqual(["keep", "added"]);
    expect(newFileLines(file, 6, 8)).toEqual(["added", "tail", "last"]);
  });

  it("is undefined for a line the diff does not hold", () => {
    expect(newFileLines(file, 4, 4)).toBeUndefined();
    expect(newFileLines(file, 8, 9)).toBeUndefined();
  });
});

describe("toChangedFile", () => {
  it("flags a withheld patch as unavailable", () => {
    const file = toChangedFile({ path: "big.json", changeType: "modified", patch: undefined });
    expect(file).toMatchObject({ patchUnavailable: true, isBinary: false, hunks: [] });
  });

  it("detects a binary diff", () => {
    const file = toChangedFile({
      path: "logo.png",
      changeType: "modified",
      patch: "Binary files a/logo.png and b/logo.png differ",
    });
    expect(file).toMatchObject({ isBinary: true, patchUnavailable: false, hunks: [] });
  });

  it("does not treat an empty patch (pure rename) as withheld", () => {
    const file = toChangedFile({
      path: "b.ts",
      previousPath: "a.ts",
      changeType: "renamed",
      patch: "",
    });
    expect(file).toMatchObject({ patchUnavailable: false, previousPath: "a.ts" });
  });
});
