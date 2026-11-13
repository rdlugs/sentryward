import type { ChangedFile, ReviewResult } from "../core/models.ts";

export function lineCounts(files: ChangedFile[]): ReviewResult["files"] {
  return files.map((file) => {
    let additions = 0;
    let deletions = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.content.split("\n").slice(1)) {
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) deletions += 1;
      }
    }
    return {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      changeType: file.changeType,
      additions,
      deletions,
    };
  });
}

// The dashboard shows each file's diff from the stored result, so it shows the
// revision that was reviewed, and retention clears it with the rest. A lockfile
// or a change of thousands of files would otherwise bloat the result row, so
// patches are capped per file and in total; the rest are listed without one.
// GET /api/reviews/:id/diff applies the same limits to a diff fetched for a
// review that has none stored, so both read alike.
export const MAX_STORED_PATCH_CHARS = 200_000;
export const MAX_STORED_PATCHES_CHARS = 2_000_000;

export function storedFiles(files: ChangedFile[]): ReviewResult["files"] {
  let budget = MAX_STORED_PATCHES_CHARS;
  return lineCounts(files).map((counts, index) => {
    const file = files[index]!;
    if (file.isBinary) return { ...counts, patchOmitted: "binary" as const };
    if (file.patchUnavailable) return { ...counts, patchOmitted: "unavailable" as const };
    // A file with no hunks (a pure rename, an empty file) stores an empty
    // patch, so the dashboard can tell it from a result kept before patches.
    const patch = file.hunks.map((hunk) => hunk.content).join("\n");
    if (patch.length > MAX_STORED_PATCH_CHARS || patch.length > budget) {
      return { ...counts, patchOmitted: "too_large" as const };
    }
    budget -= patch.length;
    return { ...counts, patch };
  });
}
