import picomatch from "picomatch";
import { parse } from "yaml";
import { cacheKey, cached, type ForgeCache } from "../forge/cache.ts";
import { FORGE_INFO } from "../forge/providers.ts";
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
  adapter: Pick<ForgeAdapter, "provider" | "host" | "getFileAtRef" | "listDirAtRef">;
  project: string;
  // The base revision, never the head.
  ref: string;
  changedFiles: Pick<ChangedFile, "path" | "previousPath" | "changeType" | "isBinary" | "patchUnavailable" | "hunks">[];
  ignorePaths: string[];
  maxChars: number;
  cache?: ForgeCache;
  // The review's cancel signal: once it fires, no more forge reads are made.
  signal?: AbortSignal;
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
// Folders listed under .cursor/rules, itself included, nearest levels first:
// Cursor reads rules at any depth, but each folder is one more forge call.
export const MAX_CURSOR_DIRS = 8;
// The same limit as .sentryward.yaml: anything bigger is not a set of
// conventions, so it is kept out of the prompt. GitLab's tree listing carries
// no sizes, so the file is read before it can be checked.
const MAX_FILE_BYTES = 64 * 1024;
const CONCURRENCY = 4;

// Whether a repository path is one the loader may read, built from the same
// names so the two cannot drift. Used to tell whether the guidance a review
// was given has changed since.
export function isAgentFilePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    (FOLDER_FILES as readonly string[]).includes(name) ||
    (ROOT_FILES as readonly string[]).includes(path) ||
    path === COPILOT_FILE ||
    (path.startsWith(`${CURSOR_RULES_DIR}/`) && path.endsWith(".mdc"))
  );
}

function parentFolders(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

const depth = (folder: string) => folder.split("/").length;
const deepestFirst = (a: string, b: string) => depth(b) - depth(a) || a.localeCompare(b);

// The cap keeps the folders above the most reviewed files: a package folder
// (`server/`) speaks for more of the change than a leaf holding one file, and
// ranking by depth alone would drop it as soon as many leaves changed. Equal
// coverage keeps the deeper, more specific folder, then sorts by name so the
// same folders are kept on every run. The kept folders come back deepest
// first, so the nearest file still leads the prompt.
function candidateFolders(reviewedPaths: string[]): { folders: string[]; dropped: string[] } {
  const coverage = new Map<string, number>();
  for (const path of reviewedPaths) {
    for (const folder of parentFolders(path)) coverage.set(folder, (coverage.get(folder) ?? 0) + 1);
  }
  const ranked = [...coverage.keys()].sort((a, b) => coverage.get(b)! - coverage.get(a)! || deepestFirst(a, b));
  const nested = ranked.slice(0, MAX_AGENT_DIRS - 1).sort(deepestFirst);
  return { folders: [...nested, ""], dropped: ranked.slice(MAX_AGENT_DIRS - 1).sort(deepestFirst) };
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

// A listing names a file plainly, or with "@" when it is a symlink (an AGENTS.md
// pointing at CLAUDE.md is common). GitHub reads a symlink as its target's
// text; GitLab reads it as the target's path, which readResolved follows
// (FORGE_INFO.symlinkReadsAs).
function lists(entries: Set<string>, name: string): boolean {
  return entries.has(name) || entries.has(`${name}@`);
}

// The repository path a symlink's text names, when the text is a link target
// at all: one line, no spaces. "" is a target outside the repository, which
// is never read. null means the text cannot be a target (or names the link
// itself). Only used on forges that read a symlink as its target path.
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
  // The frontmatter names globs, but none could be read from it: the rule
  // can then never apply, which the loader reports rather than hide.
  unreadGlobs: boolean;
  body: string;
}

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2");

function looseFrontmatter(text: string): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const pair = /^(globs|alwaysApply):[ \t]*(.*?)[ \t]*$/.exec(lines[index]!);
    if (!pair) continue;
    const value = unquote(pair[2]!);
    if (pair[1] === "alwaysApply") {
      record.alwaysApply = value.toLowerCase() === "true";
      continue;
    }
    // A flow list (`[a, b]`) on the same line, or a block list on the lines
    // that follow; anything else is Cursor's comma-separated string.
    const flow = /^\[(.*)\]$/.exec(value);
    if (flow) {
      record.globs = splitGlobs(flow[1]!).map((glob) => unquote(glob.trim()));
    } else if (value) {
      record.globs = value;
    } else {
      const items: string[] = [];
      for (let next = index + 1; next < lines.length; next++) {
        const item = /^[ \t]*-[ \t]+(.*?)[ \t]*$/.exec(lines[next]!);
        if (!item) break;
        items.push(unquote(item[1]!));
        index = next;
      }
      record.globs = items;
    }
  }
  return record;
}

// Cursor's .mdc files carry YAML frontmatter saying when a rule applies. Only
// "always" rules and rules whose globs match a changed file are used: a rule
// with neither is attached by hand or picked by the agent from its
// description, which a review cannot reproduce.
export function parseCursorRule(text: string): CursorRule {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { alwaysApply: false, globs: [], unreadGlobs: false, body: text };
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
  const globs = (Array.isArray(rawGlobs) ? rawGlobs : typeof rawGlobs === "string" ? splitGlobs(rawGlobs) : [])
    .filter((glob): glob is string => typeof glob === "string")
    .map((glob) => glob.trim())
    .filter(Boolean);
  // A quoted "true" is valid YAML for a string, but the line-by-line reader
  // accepts it, so both readers must agree on it.
  const alwaysApply = record.alwaysApply === true || (typeof record.alwaysApply === "string" && record.alwaysApply.toLowerCase() === "true");
  // An empty `globs:` is how Cursor writes "no globs", so only a value that
  // is there but yields nothing counts as unread.
  const hasValue = Array.isArray(rawGlobs) ? rawGlobs.length > 0 : typeof rawGlobs === "string" ? rawGlobs.trim() !== "" : rawGlobs != null;
  return { alwaysApply, globs, unreadGlobs: hasValue && !globs.length, body: text.slice(match[0].length) };
}

// Cursor separates globs with commas, but a brace set (`*.{ts,tsx}`) has
// commas of its own that picomatch expands: split only outside braces.
function splitGlobs(value: string): string[] {
  const globs: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      globs.push(value.slice(start, index));
      start = index + 1;
    }
  }
  globs.push(value.slice(start));
  return globs;
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
// so the review can list the files it used and plan its budget exactly. The
// cut file stays listed (part of it reached the model) and is named in
// `truncated`, so the review can say the rest did not.
export function fitAgentFiles(
  files: AgentFile[],
  maxChars: number,
): { files: AgentFile[]; left: number; truncated?: string } {
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
    if (room < 200) return { files: fitted, left: files.length - index };
    fitted.push({ path: file.path, text: `${file.text.slice(0, room - 12)}\n[truncated]` });
    return { files: fitted, left: files.length - index - 1, truncated: file.path };
  }
  return { files: fitted, left: 0 };
}

export async function loadAgentFiles(input: LoadAgentFilesInput): Promise<AgentFilesResult> {
  const { adapter, project, ref, cache } = input;
  const warnings: string[] = [];
  let failed: string | null = null;
  // One failed read is reported once and leaves the rest of the files in use:
  // the review still runs on the dashboard guidance and defaults.
  // A cancelled review stops reading: what is left is skipped, not reported
  // as unreadable, since the review will not run anyway.
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    if (input.signal?.aborted) return null;
    try {
      return await fn();
    } catch (err) {
      if (input.signal?.aborted) return null;
      failed ??= err instanceof Error ? err.message.split("\n")[0]! : "unknown error";
      return null;
    }
  };
  const listDir = (path: string) =>
    attempt(() => cached(cache, cacheKey("dir", adapter.host, project, path, ref), () => adapter.listDirAtRef(project, path, ref)));
  // Memoised here as well as in the forge cache: a symlink and its target are
  // both read, and the forge cache is off when review.disableCache is set.
  const reads = new Map<string, Promise<string | null>>();
  const readFile = (path: string) => {
    let read = reads.get(path);
    if (!read) {
      read = attempt(() =>
        cached(cache, cacheKey("file", adapter.host, project, path, ref), () => adapter.getFileAtRef(project, path, ref)),
      );
      reads.set(path, read);
    }
    return read;
  };

  // Files the review leaves out neither add folders nor match Cursor globs:
  // the same ones classifyFiles omits (ignored, deleted, binary, patch
  // withheld, or no hunks, as in a pure rename). Whether a file is ignored is
  // decided by its new path, as classifyFiles does: a file moved into an
  // ignored folder is not reviewed, so its old folder adds nothing. An edited
  // rename otherwise keeps its old path: the file is still reviewed, and the
  // conventions of the folder it left may still apply.
  const ignored = ignoreMatcher(input.ignorePaths);
  const reviewedPaths = input.changedFiles
    .filter(
      (file) =>
        file.changeType !== "deleted" && !file.isBinary && !file.patchUnavailable && file.hunks.length > 0 && !ignored(file.path),
    )
    .flatMap((file) => [file.path, file.previousPath])
    .filter((path): path is string => !!path && !ignored(path));

  const { folders, dropped } = candidateFolders(reviewedPaths);
  if (dropped.length > 0) {
    const named = dropped.slice(0, 3).join(", ");
    const more = dropped.length > 3 ? ` and ${dropped.length - 3} more` : "";
    warnings.push(
      `${dropped.length} ${dropped.length === 1 ? "folder" : "folders"} above changed files ${dropped.length === 1 ? "was" : "were"} not checked for agent instruction files (at most ${MAX_AGENT_DIRS} are): ${named}${more}`,
    );
  }
  const listings = await mapLimit(folders, CONCURRENCY, async (folder) => {
    const listing = await listDir(folder);
    return { folder, listing };
  });

  const wanted: string[] = [];
  // Known symlinks ("@" in a listing), and files tried only because a
  // truncated listing could not say whether they exist, let alone their mode.
  const symlinks = new Set<string>();
  const maybeSymlinks = new Set<string>();
  let rootEntries = new Set<string>();
  let rootTruncated = false;
  const want = (entries: Set<string>, folder: string, name: string, truncated = false) => {
    // A forge caps a listing; past the cap the file may still be there.
    if (!lists(entries, name) && !truncated) return;
    const path = join(folder, name);
    wanted.push(path);
    if (entries.has(`${name}@`)) symlinks.add(path);
    else if (!entries.has(name)) maybeSymlinks.add(path);
  };
  for (const { folder, listing } of listings) {
    if (!listing) continue;
    const entries = new Set(listing.entries);
    if (folder === "") {
      rootEntries = entries;
      rootTruncated = listing.truncated;
    }
    for (const name of FOLDER_FILES) want(entries, folder, name, listing.truncated);
  }
  for (const name of ROOT_FILES) want(rootEntries, "", name, rootTruncated);
  // Past a truncated root listing, .github/ and .cursor/ may exist unlisted; a
  // missing one costs a single read that finds nothing.
  if (rootEntries.has(".github/") || rootTruncated) wanted.push(COPILOT_FILE);

  const cursorRules: string[] = [];
  if (rootEntries.has(".cursor/") || rootTruncated) {
    const mdc = (dir: string, entries: string[]) =>
      entries
        .filter((entry) => /\.mdc@?$/.test(entry))
        .map((entry) => {
          const path = join(dir, entry.replace(/@$/, ""));
          if (entry.endsWith("@")) symlinks.add(path);
          return path;
        });
    // Level by level, so the cap keeps the shallower folders, and sorted, so
    // the same folders are kept on every run.
    let level = [CURSOR_RULES_DIR];
    let listed = 0;
    let unlisted = 0;
    while (level.length) {
      const batch = level.slice(0, MAX_CURSOR_DIRS - listed);
      unlisted += level.length - batch.length;
      listed += batch.length;
      const found = await mapLimit(batch, CONCURRENCY, async (dir) => ({ dir, listing: await listDir(dir) }));
      level = [];
      for (const { dir, listing } of found) {
        const entries = [...(listing?.entries ?? [])].sort();
        cursorRules.push(...mdc(dir, entries));
        level.push(...entries.filter((entry) => entry.endsWith("/")).map((entry) => join(dir, entry.slice(0, -1))));
      }
    }
    if (unlisted > 0) {
      warnings.push(
        `${unlisted} Cursor rule ${unlisted === 1 ? "folder was" : "folders were"} not checked (at most ${MAX_CURSOR_DIRS} are listed)`,
      );
    }
    cursorRules.sort();
  }
  if (cursorRules.length > MAX_CURSOR_RULE_READS) {
    const unchecked = cursorRules.length - MAX_CURSOR_RULE_READS;
    warnings.push(
      `${unchecked} Cursor ${unchecked === 1 ? "rule was" : "rules were"} not checked (at most ${MAX_CURSOR_RULE_READS} are read)`,
    );
  }

  const toRead = [...wanted, ...cursorRules.slice(0, MAX_CURSOR_RULE_READS)];
  // A forge that reads a symlink as its target's content needs nothing more,
  // and its text must not be taken for a path even when it looks like one.
  // GitLab reads a symlink as its target path: follow it one hop, even to a
  // target with an entry of its own. That entry may still be dropped (a rule
  // that does not apply, a file over the size limit), and the link must then
  // stand as it does on GitHub; when both are used, the repeated text is
  // dropped below like any other.
  const readsTarget = FORGE_INFO[adapter.provider].symlinkReadsAs === "target";
  const readResolved = async (path: string): Promise<string | null> => {
    const text = await readFile(path);
    if (text === null || !readsTarget) return text;
    const known = symlinks.has(path);
    if (!known && !maybeSymlinks.has(path)) return text;
    const target = symlinkTarget(path, text);
    if (known) {
      // The text is a path, never guidance: a link that cannot be followed is
      // dropped rather than shown to the model as a "convention".
      if (!target) return null;
      return readFile(target);
    }
    // The mode is unknown (a truncated listing): text that names a file which
    // reads is taken as a link to it; anything else is the file itself. Text
    // naming somewhere outside the repository could never be followed, so it
    // is more likely the file's own content (`/api/v2`) than a link.
    if (target === null || target === "") return text;
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
    const isRule = path.endsWith(".mdc");
    if (isRule) {
      const rule = parseCursorRule(text);
      // A glob without a slash (`*.tsx`) matches at any depth, as in Cursor.
      // picomatch's basename option would also flatten `src/db/**`, so only
      // slashless globs are widened.
      const globs = rule.globs.map((glob) => (glob.includes("/") ? glob : `**/${glob}`));
      const matches = globs.length ? picomatch(globs, { dot: true }) : null;
      const applies = rule.alwaysApply || (!!matches && reviewedPaths.some((changed) => matches(changed)));
      if (!applies) {
        if (rule.unreadGlobs) warnings.push(`${path} has globs that could not be read; the rule was not used`);
        continue;
      }
      body = rule.body;
    }
    body = body.trim();
    // A symlinked AGENTS.md reads as its CLAUDE.md target on GitHub: the same text once is enough.
    if (!body || seen.has(body)) continue;
    // Counted only once a rule adds text, so empty or repeated rules cannot
    // crowd out one that applies.
    if (isRule) {
      if (rulesUsed >= MAX_CURSOR_RULES) {
        rulesLeftOut++;
        continue;
      }
      rulesUsed++;
    }
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
  if (fitted.truncated) {
    warnings.push(`${fitted.truncated} was cut to stay within review.agent_files.max_chars`);
  }
  if (fitted.left > 0) {
    warnings.push(
      `${fitted.left} agent instruction ${fitted.left === 1 ? "file was" : "files were"} left out to stay within review.agent_files.max_chars`,
    );
  }
  return { files: fitted.files, warnings };
}
