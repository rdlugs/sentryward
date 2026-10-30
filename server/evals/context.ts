import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ContextSource } from "../src/review/context/gather.ts";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

// Stands in for the forge's head revision: a case's after/ tree. A case
// without one reviews the diff alone, as when context gathering fails.
export function caseContext(caseDir: string): ContextSource | undefined {
  const root = resolve(caseDir, "after");
  if (!existsSync(root)) return undefined;
  const files = walk(root).map((path) => relative(root, path).split(sep).join("/"));

  return {
    async readFile(path) {
      const absolute = resolve(root, path);
      // Paths come from the diff and the model's context requests; keep them
      // inside the case.
      if (!absolute.startsWith(root + sep) || !existsSync(absolute)) return null;
      return readFileSync(absolute, "utf8");
    },
    async searchCode(term) {
      return files.filter((path) => readFileSync(join(root, path), "utf8").includes(term));
    },
    async listDir(path) {
      const absolute = resolve(root, path);
      if ((absolute !== root && !absolute.startsWith(root + sep)) || !existsSync(absolute)) return null;
      if (!statSync(absolute).isDirectory()) return null;
      return readdirSync(absolute, { withFileTypes: true }).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    },
  };
}
