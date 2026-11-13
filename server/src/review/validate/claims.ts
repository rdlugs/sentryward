import { posix } from "node:path";
import type { ChangeSet, Claim, Finding } from "../core/models.ts";
import { hunkLines } from "../context/diffText.ts";
import type { ContextSource } from "../context/gather.ts";
import { escapeRegExp } from "../core/regex.ts";
import { safePath, type SearchBudget } from "../agent/tools.ts";
import type { DropReason } from "./validator.ts";

// Checks the fact a finding says it rests on against the repository at the
// change's head, without a model call. A static pass sees part of a file, so
// "nothing uses this" or "this file does not exist" is a common false
// positive the repository can settle with a lookup.
//
// Only a positive contradiction drops a finding: the path exists, or a
// reference was read at the head. Absence never proves the claim (search
// indexes lag, results are capped, a reference can be built dynamically), so
// a missing result, an error or a spent budget keeps the finding as it was.
// The same goes for anything ambiguous: a matcher that is unsure says
// nothing, since losing a refutation is cheap and dropping a true finding is
// what this check promises never to do.
//
// GitHub code search only indexes the default branch, so a search hit is a
// candidate, never evidence: the file is read at the head and the reference
// must still be there.

// Code search is rate-limited hard on GitHub, so claim searches come out of
// the review's shared budget (review.agent.max_searches) and are capped again
// here; reads go through the cache.
export const MAX_CLAIM_SEARCHES = 5;
export const MAX_CLAIM_READS = 15;
// A shorter name matches too much by accident to be worth a search.
const MIN_TERM_LENGTH = 3;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// Prose that mentions a name or a path does not use it.
const DOC_FILE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;
// Extensions an import may leave out or swap (`./format.js` for format.ts).
const MODULE_EXT = /\.(?:[cm]?[jt]sx?|json|vue|svelte|py|rb|php|go|rs|java|kt|css|scss|sass|less)$/;
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
// Leading words of a line that is a statement, not a typed declaration, so
// `return total(x)` is a call, not a method `total` returning `return`.
const STATEMENT_WORDS =
  "return|await|yield|throw|new|else|case|in|of|and|or|not|typeof|void|delete|if|elif|while|for|assert|raise|echo|print|puts|go|defer";
const MODIFIERS =
  "(?:(?:export|default|public|private|protected|internal|static|async|override|readonly|abstract|final|declare|get|set|pub|open)\\s+)*";

export interface CheckClaimsInput {
  findings: Finding[];
  changeSet: ChangeSet;
  source: ContextSource;
  // The review's shared code search budget.
  searches: SearchBudget;
  maxSearches?: number;
  maxReads?: number;
}

export interface CheckClaimsResult {
  findings: Finding[];
  dropped: Partial<Record<DropReason, number>>;
}

type Outcome = "refuted" | "inconclusive";

// What counts as a reference to the claim's subject. `line` looks at one line
// of `path`; `file`, when given, must also hold for the whole file content.
interface Matcher {
  line: (text: string, path: string) => boolean;
  file?: (path: string, content: string) => boolean;
}

// A mention in a comment is not a use, so comment lines never refute.
function isCommentLine(text: string): boolean {
  return /^\s*(\/\/|#|\*|\/\*|--|<!--)/.test(text);
}

function isDocFile(path: string): boolean {
  return DOC_FILE.test(path);
}

function stringLiterals(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL)].map((match) => match[2]!);
}

// The line with string contents blanked, so `"total"` or `type: "audit"` is
// not taken for code that names them.
function codeOnly(text: string): string {
  return text.replace(STRING_LITERAL, (match) => match[0] + " ".repeat(match.length - 2) + match[match.length - 1]);
}

// A path as a module: without an extension an import may omit, and a
// directory's index standing for the directory.
function moduleKey(path: string): string {
  return path.replace(MODULE_EXT, "").replace(/\/index$/, "");
}

// The repository path a relative import in `fromFile` points at, or null for
// a package or alias import, or one that leaves the repository.
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!/^\.\.?(\/|$)/.test(spec)) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  return resolved === ".." || resolved.startsWith("../") ? null : resolved;
}

// Whether `spec`, a string in `fromFile`, names the module at `target`.
// Relative specifiers are resolved; an alias (`@/lib/audit`, `~/lib/audit`)
// must name at least a directory and the file, and the target must end with
// it. A bare word (`"audit"`) is never enough.
function namesModule(fromFile: string, spec: string, target: string): boolean {
  const key = moduleKey(target);
  const resolved = resolveSpecifier(fromFile, spec);
  if (resolved !== null) return resolved === target || moduleKey(resolved) === key;
  const tail = spec.replace(/^[@~#][^/]*\//, "");
  if (!/^[\w.@-]+(\/[\w.@-]+)+$/.test(tail)) return false;
  const tailKey = moduleKey(tail);
  return key === tailKey || key.endsWith(`/${tailKey}`);
}

function importsModule(fromFile: string, content: string, target: string): boolean {
  return content
    .split("\n")
    .some((text) => !isCommentLine(text) && stringLiterals(text).some((spec) => namesModule(fromFile, spec, target)));
}

// What a use and a declaration of `name` look like on one line. A use is the
// name as a whole word outside strings, not after a `.` (`obj.name` is
// another symbol; a spread `...name` is still a use).
function symbolPatterns(name: string) {
  const n = escapeRegExp(name);
  const use = new RegExp(`(?<![\\w$])(?<![^.]\\.)${n}(?![\\w$])`);
  // Another declaration of the same name is a different symbol, not a use.
  // Broader than context/symbols.ts, which only wants callables.
  const declarations = [
    new RegExp(`(?<![\\w$])(?:const|let|var|val|function\\*?|def|fn|func|class|interface|struct|enum|trait|type)\\s+${n}(?![\\w$])`),
    // A class or object method: `total(cart): number {`.
    new RegExp(`^\\s*${MODIFIERS}\\*?${n}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^=;{]*)?\\{\\s*$`),
    // A class or object property: `total: number`, `total = 0`.
    new RegExp(`^\\s*${MODIFIERS}${n}\\s*[?!]?\\s*(?::(?!:)|=(?![=>]))`),
    // A Go method: `func (s *Svc) total(`.
    new RegExp(`\\bfunc\\s*\\([^)]*\\)\\s*${n}\\s*[(\\[]`),
    // A typed method (Java, C#, Kotlin): `public int total(Cart cart) {`.
    // Without a trailing `;`, which a call statement would have.
    new RegExp(`^\\s*${MODIFIERS}(?!(?:${STATEMENT_WORDS})\\s)[\\w<>\\[\\],.?]+\\s+${n}\\s*\\([^;]*$`),
  ];
  const declares = (text: string) => declarations.some((pattern) => pattern.test(text));
  const uses = (text: string) => !declares(text) && use.test(codeOnly(text));
  return { uses, declares };
}

export async function checkClaims(input: CheckClaimsInput): Promise<CheckClaimsResult> {
  const { changeSet, source } = input;
  let searchesLeft = input.maxSearches ?? MAX_CLAIM_SEARCHES;
  let readsLeft = input.maxReads ?? MAX_CLAIM_READS;
  const reads = new Map<string, Promise<string | null>>();
  // Undefined: the budget was spent or the read failed, which settles nothing.
  // The budget is taken synchronously, so concurrent reads still respect it.
  const read = async (path: string): Promise<string | null | undefined> => {
    let pending = reads.get(path);
    if (!pending) {
      if (readsLeft <= 0) return undefined;
      readsLeft -= 1;
      pending = source.readFile(path);
      reads.set(path, pending);
    }
    try {
      return await pending;
    } catch {
      return undefined;
    }
  };
  const search = async (term: string): Promise<string[]> => {
    if (searchesLeft <= 0 || !input.searches.take()) return [];
    searchesLeft -= 1;
    try {
      return await source.searchCode(term);
    } catch {
      return [];
    }
  };
  const deleted = new Set(changeSet.files.filter((file) => file.changeType === "deleted").map((file) => file.path));
  const present = new Set(changeSet.files.filter((file) => file.changeType !== "deleted").map((file) => file.path));
  // An empty file exists: only null (missing) or undefined (unknown) do not.
  const exists = async (path: string): Promise<boolean> => present.has(path) || typeof (await read(path)) === "string";
  // Lines the change adds, by file, so a reference the change itself adds is
  // found without a search (the index has never seen it).
  const added = changeSet.files
    .filter((file) => file.changeType !== "deleted")
    .map((file) => ({
      path: file.path,
      lines: file.hunks.flatMap((hunk) =>
        hunkLines(hunk).flatMap((line) => (line.marker === "+" && line.line !== undefined ? [{ line: line.line, text: line.text }] : [])),
      ),
    }));

  // Whether `lines` of `path` refer to the target anywhere but on the
  // finding's own lines.
  const refersIn = (path: string, lines: { line: number; text: string }[], finding: Finding, matcher: Matcher): boolean =>
    lines.some(
      ({ line, text }) =>
        !(path === finding.file && line >= finding.startLine && line <= finding.endLine) &&
        !isCommentLine(text) &&
        matcher.line(text, path),
    );

  const numbered = (content: string) => content.split("\n").map((text, index) => ({ line: index + 1, text }));

  // A reference in the diff, the finding's own file, or a searched file read
  // at the head. Files the change deletes take their references with them,
  // `skip` (the claim's own file) cannot refer to itself, and docs only
  // mention things.
  const referenced = async (finding: Finding, term: string, matcher: Matcher, skip?: string): Promise<boolean> => {
    const counts = (path: string) => path !== skip && !deleted.has(path) && !isDocFile(path);
    // The finding's own file unread at the head (budget, error) is judged by
    // the lines the change adds to it; another file must be read.
    const fileHolds = async (path: string): Promise<boolean> => {
      if (!matcher.file) return true;
      const content = await read(path);
      if (typeof content === "string") return matcher.file(path, content);
      const own = path === finding.file && added.find((file) => file.path === path);
      return !!own && matcher.file(path, own.lines.map((line) => line.text).join("\n"));
    };
    for (const file of added) {
      if (counts(file.path) && refersIn(file.path, file.lines, finding, matcher) && (await fileHolds(file.path))) return true;
    }
    if (counts(finding.file)) {
      const own = await read(finding.file);
      if (own && refersIn(finding.file, numbered(own), finding, matcher) && (!matcher.file || matcher.file(finding.file, own))) {
        return true;
      }
    }
    const candidates = (await search(term)).filter((path) => path !== finding.file && counts(path));
    const contents = await Promise.all(candidates.map(read));
    return candidates.some((path, index) => {
      const content = contents[index];
      return typeof content === "string" && refersIn(path, numbered(content), finding, matcher) && (!matcher.file || matcher.file(path, content));
    });
  };

  // Every path the subject of a missing_path claim could mean: from the root,
  // and, when the finding's file imports it relatively, from that file's
  // directory. A model often names a path as the import spells it.
  const missingPathCandidates = async (finding: Finding, subject: string): Promise<string[] | undefined> => {
    const fromDir = posix.normalize(posix.join(posix.dirname(finding.file), subject.trim()));
    const local = fromDir === ".." || fromDir.startsWith("../") ? undefined : safePath(fromDir);
    if (/^\.\.\//.test(subject.trim())) return local ? [local] : undefined;
    const root = safePath(subject);
    if (!root) return undefined;
    if (!local || local === root) return [root];
    const own = await read(finding.file);
    const ownLines = [
      ...(typeof own === "string" ? own.split("\n") : []),
      ...(added.find((file) => file.path === finding.file)?.lines.map((line) => line.text) ?? []),
    ];
    const importsLocal = ownLines.some((text) =>
      stringLiterals(text).some((spec) => {
        const resolved = resolveSpecifier(finding.file, spec);
        return resolved !== null && moduleKey(resolved) === moduleKey(local);
      }),
    );
    return importsLocal ? [root, local] : [root];
  };

  const check = async (finding: Finding, claim: Claim): Promise<Outcome> => {
    switch (claim.kind) {
      case "missing_path": {
        const paths = await missingPathCandidates(finding, claim.subject);
        if (!paths || paths.some((path) => deleted.has(path))) return "inconclusive";
        for (const path of paths) {
          if (!(await exists(path))) return "inconclusive";
        }
        return "refuted";
      }
      case "unused_symbol": {
        const name = claim.subject.trim();
        if (!IDENTIFIER.test(name) || name.length < MIN_TERM_LENGTH) return "inconclusive";
        const { uses, declares } = symbolPatterns(name);
        const declarations = (content: string) => content.split("\n").filter(declares).length;
        const matcher: Matcher = {
          line: (text) => uses(text),
          // In the finding's own file a second declaration makes any use
          // ambiguous (another function's local of the same name). Another
          // file's use counts only if it imports the finding's file and does
          // not declare the name itself. Without scope analysis, a same-named
          // local in another function of the same file can still refute.
          file: (path, content) =>
            path === finding.file ? declarations(content) <= 1 : declarations(content) === 0 && importsModule(path, content, finding.file),
        };
        return (await referenced(finding, name, matcher)) ? "refuted" : "inconclusive";
      }
      case "unreferenced_file": {
        const path = safePath(claim.subject);
        if (!path) return "inconclusive";
        // The basename without its last extension: foo.test.ts searches
        // "foo.test", which "./foo" (the implementation) does not match.
        const base = path.split("/").pop()!;
        const dot = base.lastIndexOf(".");
        const term = dot > 0 ? base.slice(0, dot) : base;
        if (term.length < MIN_TERM_LENGTH || !IDENTIFIER.test(term.replace(/[-.]/g, "_"))) return "inconclusive";
        // An import or path string that resolves to the file, with or without
        // its extension: "./format", '../lib/format.js', "@/lib/format".
        const matcher: Matcher = { line: (text, from) => stringLiterals(text).some((spec) => namesModule(from, spec, path)) };
        return (await referenced(finding, term, matcher, path)) ? "refuted" : "inconclusive";
      }
    }
  };

  const dropped: Partial<Record<DropReason, number>> = {};
  const findings: Finding[] = [];
  // One at a time, so the shared caps are spent on the worst findings first
  // (the validator sorted them).
  for (const finding of input.findings) {
    if (finding.claim && (await check(finding, finding.claim)) === "refuted") {
      dropped.claim_refuted = (dropped.claim_refuted ?? 0) + 1;
      continue;
    }
    findings.push(finding);
  }
  return { findings, dropped };
}
