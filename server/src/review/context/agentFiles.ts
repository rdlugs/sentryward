import picomatch from "picomatch";
import { parse } from "yaml";
import { cacheKey, cached, type ForgeCache } from "../forge/cache.ts";
import type { ForgeAdapter } from "../forge/types.ts";
import type { ChangedFile } from "../core/models.ts";
import { mapLimit } from "../core/mapLimit.ts";
import { ignoreMatcher } from "./ignore.ts";

// Instruction files teams already write for coding agents, used as review
// guidance when review.agentFiles is on. They are read from the base revision,
// like .sentryward.yaml, so a change cannot steer its own review, and they are
// still repository content anyone with push access wrote: the prompt wraps
// them as untrusted and they never become rules.

export interface AgentFile {
  path: string;
  text: string;
}

export interface AgentFilesResult {
  // What goes into the prompt, nearest folder first, already fitted to maxChars.
  files: AgentFile[];
  warnings: string[];
}

export interface LoadAgentFilesInput {
  adapter: Pick<ForgeAdapter, "host" | "getFileAtRef" | "listDirAtRef">;
  project: string;
  // The base revision, never the head.
  ref: string;
  changedFiles: Pick<ChangedFile, "path" | "previousPath">[];
  ignorePaths: string[];
  maxChars: number;
  cache?: ForgeCache;
}

// Read in every folder above a changed file, as agents do for nested files.
export const FOLDER_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
// Repository-wide only.
const ROOT_FILES = [".cursorrules"] as const;
const COPILOT_FILE = ".github/copilot-instructions.md";
const CURSOR_RULES_DIR = ".cursor/rules";
// Folders listed per review, root included; the deepest are kept, since the
// nearest file is the most specific one.
export const MAX_AGENT_DIRS = 12;
// Cursor rules read to learn whether they apply, and the applying ones used.
// The use cap comes after the check, so rules that do not apply to the change
// cannot crowd out ones that do.
export const MAX_CURSOR_RULE_READS = 30;
export const MAX_CURSOR_RULES = 10;
// Cursor rule subfolders listed (one level only).
const MAX_CURSOR_SUBDIRS = 5;
// The same limit as .sentryward.yaml: anything bigger is not a set of
// conventions, so it is kept out of the prompt. GitLab's tree listing carries
// no sizes, so the file is read before it can be checked.
const MAX_FILE_BYTES = 64 * 1024;
const CONCURRENCY = 4;

function parentFolders(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

// Deepest first, then by name, so the cap keeps the most specific folders and
// the order is stable across runs.
function candidateFolders(reviewedPaths: string[]): { folders: string[]; dropped: number } {
  const folders = new Set<string>();
  for (const path of reviewedPaths) {
    for (const folder of parentFolders(path)) folders.add(folder);
  }
  const sorted = [...folders].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  const nested = sorted.slice(0, MAX_AGENT_DIRS - 1);
  return { folders: [...nested, ""], dropped: sorted.length - nested.length };
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

// A listing names a file plainly, or with "@" when it is a symlink (an AGENTS.md
// pointing at CLAUDE.md is common). GitHub reads a symlink as its target's
// text; GitLab reads it as the target's path, which resolveSymlink follows.
function lists(entries: Set<string>, name: string): boolean {
  return entries.has(name) || entries.has(`${name}@`);
}

// The repository path a symlink's text names, when the text is a link target
// at all: one line, no spaces. "" is a target outside the repository, which
// is never read. null means the text is already the target's, as GitHub
// returns it.
function symlinkTarget(linkPath: string, text: string): string | null {
  const target = text.trim();
  if (!target || /\s/.test(target)) return null;
  if (target.startsWith("/")) return "";
  const parts = linkPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") {
      if (!parts.length) return "";
      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  const resolved = parts.join("/");
  return resolved && resolved !== linkPath ? resolved : null;
}

interface CursorRule {
  alwaysApply: boolean;
  globs: string[];
  body: string;
}

function looseFrontmatter(text: string): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const pair = /^(globs|alwaysApply):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!pair) continue;
    const value = pair[2]!.replace(/^(["'])(.*)\1$/, "$2");
    if (pair[1] === "globs") record.globs = value;
    else record.alwaysApply = value.toLowerCase() === "true";
  }
  return record;
}

// Cursor's .mdc files carry YAML frontmatter saying when a rule applies. Only
// "always" rules and rules whose globs match a changed file are used: a rule
// with neither is attached by hand or picked by the agent from its
// description, which a review cannot reproduce.
export function parseCursorRule(text: string): CursorRule {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { alwaysApply: false, globs: [], body: text };
  let meta: unknown;
  try {
    meta = parse(match[1]!, { maxAliasCount: 10 });
  } catch {
    // Cursor writes globs unquoted (`globs: *.ts,*.tsx`), which YAML reads as
    // an alias and rejects; Cursor's own reader is not strict YAML, so the
    // two keys that matter are read line by line instead.
    meta = looseFrontmatter(match[1]!);
  }
  const record = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
  const rawGlobs = record.globs;
  const globs = (Array.isArray(rawGlobs) ? rawGlobs : typeof rawGlobs === "string" ? rawGlobs.split(",") : [])
    .filter((glob): glob is string => typeof glob === "string")
    .map((glob) => glob.trim())
    .filter(Boolean);
  return { alwaysApply: record.alwaysApply === true, globs, body: text.slice(match[0].length) };
}

const HEADING = (path: string) => `### ${path}\n`;
const SEPARATOR = "\n\n";

// The characters a list of files takes in the prompt, headings included.
export function agentFilesChars(files: AgentFile[]): number {
  return files.reduce((total, file, index) => total + (index ? SEPARATOR.length : 0) + HEADING(file.path).length + file.text.length, 0);
}

export function renderAgentFiles(files: AgentFile[]): string {
  return files.map((file) => `${HEADING(file.path)}${file.text}`).join(SEPARATOR);
}

// Whole files in order until one does not fit; that one is cut to the room
// left, and the rest are left out. The result is exactly what the prompt holds,
// so the review can list the files it used and plan its budget exactly.
export function fitAgentFiles(files: AgentFile[], maxChars: number): { files: AgentFile[]; left: number } {
  const fitted: AgentFile[] = [];
  let used = 0;
  for (const [index, file] of files.entries()) {
    const head = (fitted.length ? SEPARATOR.length : 0) + HEADING(file.path).length;
    const room = maxChars - used - head;
    if (file.text.length <= room) {
      fitted.push(file);
      used += head + file.text.length;
      continue;
    }
    // A sliver of a file is noise; only cut one when a useful part fits.
    if (room >= 200) fitted.push({ path: file.path, text: `${file.text.slice(0, room - 12)}\n[truncated]` });
    return { files: fitted, left: files.length - index - (room >= 200 ? 1 : 0) };
  }
  return { files: fitted, left: 0 };
}

export async function loadAgentFiles(input: LoadAgentFilesInput): Promise<AgentFilesResult> {
  const { adapter, project, ref, cache } = input;
  const warnings: string[] = [];
  let failed: string | null = null;
  // One failed read is reported once and leaves the rest of the files in use:
  // the review still runs on the dashboard guidance and defaults.
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      failed ??= err instanceof Error ? err.message.split("\n")[0]! : "unknown error";
      return null;
    }
  };
  const listDir = (path: string) =>
    attempt(() => cached(cache, cacheKey("dir", adapter.host, project, path, ref), () => adapter.listDirAtRef(project, path, ref)));
  const readFile = (path: string) =>
    attempt(() => cached(cache, cacheKey("file", adapter.host, project, path, ref), () => adapter.getFileAtRef(project, path, ref)));

  // Files the review leaves out neither add folders nor match Cursor globs.
  const ignored = ignoreMatcher(input.ignorePaths);
  const reviewedPaths = input.changedFiles
    .flatMap((file) => [file.path, file.previousPath])
    .filter((path): path is string => !!path && !ignored(path));

  const { folders, dropped } = candidateFolders(reviewedPaths);
  if (dropped > 0) {
    warnings.push(
      `${dropped} ${dropped === 1 ? "folder" : "folders"} above changed files ${dropped === 1 ? "was" : "were"} not checked for agent instruction files (at most ${MAX_AGENT_DIRS} are)`,
    );
  }
  const listings = await mapLimit(folders, CONCURRENCY, async (folder) => {
    const listing = await listDir(folder);
    return { folder, listing };
  });

  const wanted: string[] = [];
  const symlinks = new Set<string>();
  let rootEntries = new Set<string>();
  const want = (entries: Set<string>, folder: string, name: string, truncated = false) => {
    // A forge caps a listing; past the cap the file may still be there.
    if (!lists(entries, name) && !truncated) return;
    const path = join(folder, name);
    wanted.push(path);
    if (entries.has(`${name}@`)) symlinks.add(path);
  };
  for (const { folder, listing } of listings) {
    if (!listing) continue;
    const entries = new Set(listing.entries);
    if (folder === "") rootEntries = entries;
    for (const name of FOLDER_FILES) want(entries, folder, name, listing.truncated);
  }
  for (const name of ROOT_FILES) want(rootEntries, "", name);
  if (rootEntries.has(".github/")) wanted.push(COPILOT_FILE);

  const cursorRules: string[] = [];
  if (rootEntries.has(".cursor/")) {
    const top = await listDir(CURSOR_RULES_DIR);
    const subdirs = (top?.entries ?? [])
      .filter((entry) => entry.endsWith("/"))
      .slice(0, MAX_CURSOR_SUBDIRS)
      .map((entry) => join(CURSOR_RULES_DIR, entry.slice(0, -1)));
    const nested = await mapLimit(subdirs, CONCURRENCY, async (dir) => ({ dir, listing: await listDir(dir) }));
    const mdc = (dir: string, entries: string[] = []) =>
      entries
        .filter((entry) => /\.mdc@?$/.test(entry))
        .map((entry) => {
          const path = join(dir, entry.replace(/@$/, ""));
          if (entry.endsWith("@")) symlinks.add(path);
          return path;
        });
    cursorRules.push(...mdc(CURSOR_RULES_DIR, top?.entries), ...nested.flatMap(({ dir, listing }) => mdc(dir, listing?.entries)));
    cursorRules.sort();
  }
  if (cursorRules.length > MAX_CURSOR_RULE_READS) {
    const unchecked = cursorRules.length - MAX_CURSOR_RULE_READS;
    warnings.push(
      `${unchecked} Cursor ${unchecked === 1 ? "rule was" : "rules were"} not checked (at most ${MAX_CURSOR_RULE_READS} are read)`,
    );
  }

  const toRead = [...wanted, ...cursorRules.slice(0, MAX_CURSOR_RULE_READS)];
  // GitLab reads a symlink as its target's path: follow it one hop. A target
  // already being read is left to its own entry; a target that cannot be read
  // means the text was the file itself after all.
  const readResolved = async (path: string): Promise<string | null> => {
    const text = await readFile(path);
    if (text === null || !symlinks.has(path)) return text;
    const target = symlinkTarget(path, text);
    if (target === null) return text;
    if (target === "" || toRead.includes(target)) return null;
    return (await readFile(target)) ?? text;
  };
  const texts = await mapLimit(toRead, CONCURRENCY, async (path) => ({
    path,
    text: await readResolved(path),
  }));

  const files: AgentFile[] = [];
  const seen = new Set<string>();
  let rulesUsed = 0;
  let rulesLeftOut = 0;
  for (const { path, text } of texts) {
    if (text === null) continue;
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      warnings.push(`${path} is larger than 64 KB and was not used as review guidance`);
      continue;
    }
    let body = text;
    if (path.endsWith(".mdc")) {
      const rule = parseCursorRule(text);
      // A glob without a slash (`*.tsx`) matches at any depth, as in Cursor.
      // picomatch's basename option would also flatten `src/db/**`, so only
      // slashless globs are widened.
      const globs = rule.globs.map((glob) => (glob.includes("/") ? glob : `**/${glob}`));
      const matches = globs.length ? picomatch(globs, { dot: true }) : null;
      const applies = rule.alwaysApply || (!!matches && reviewedPaths.some((changed) => matches(changed)));
      if (!applies) continue;
      if (rulesUsed >= MAX_CURSOR_RULES) {
        rulesLeftOut++;
        continue;
      }
      rulesUsed++;
      body = rule.body;
    }
    body = body.trim();
    // A symlinked AGENTS.md reads as its CLAUDE.md target on GitHub: the same text once is enough.
    if (!body || seen.has(body)) continue;
    seen.add(body);
    files.push({ path, text: body });
  }
  if (rulesLeftOut > 0) {
    warnings.push(
      `${rulesLeftOut} matching Cursor ${rulesLeftOut === 1 ? "rule was" : "rules were"} left out (at most ${MAX_CURSOR_RULES} are used)`,
    );
  }

  if (failed) warnings.push(`Some agent instruction files could not be read: ${failed}`);
  const fitted = fitAgentFiles(files, input.maxChars);
  if (fitted.left > 0) {
    warnings.push(
      `${fitted.left} agent instruction ${fitted.left === 1 ? "file was" : "files were"} left out to stay within review.agent_files.max_chars`,
    );
  }
  return { files: fitted.files, warnings };
}
