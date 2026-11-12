import type { ChangeSet, Claim, Finding } from "../core/models.ts";
import { hunkLines } from "../context/diffText.ts";
import type { ContextSource } from "../context/gather.ts";
import { escapeRegExp } from "../core/regex.ts";
import { safePath } from "../agent/tools.ts";
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
//
// GitHub code search only indexes the default branch, so a search hit is a
// candidate, never evidence: the file is read at the head and the reference
// must still be there.

// Code search is rate-limited hard on GitHub; reads go through the cache.
export const MAX_CLAIM_SEARCHES = 5;
export const MAX_CLAIM_READS = 15;
// A shorter name matches too much by accident to be worth a search.
const MIN_TERM_LENGTH = 3;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export interface CheckClaimsInput {
  findings: Finding[];
  changeSet: ChangeSet;
  source: ContextSource;
  maxSearches?: number;
  maxReads?: number;
}

export interface CheckClaimsResult {
  findings: Finding[];
  dropped: Partial<Record<DropReason, number>>;
  // Claims looked at, and those the repository could not settle either way.
  checked: number;
  inconclusive: number;
}

type Outcome = "refuted" | "inconclusive";

// A mention in a comment is not a use, so comment lines never refute.
function isCommentLine(text: string): boolean {
  return /^\s*(\/\/|#|\*|\/\*|--|<!--)/.test(text);
}

function stem(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.indexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export async function checkClaims(input: CheckClaimsInput): Promise<CheckClaimsResult> {
  const { changeSet, source } = input;
  let searchesLeft = input.maxSearches ?? MAX_CLAIM_SEARCHES;
  let readsLeft = input.maxReads ?? MAX_CLAIM_READS;
  const reads = new Map<string, Promise<string | null>>();
  // Undefined: the budget was spent or the read failed, which settles nothing.
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
    if (searchesLeft <= 0) return [];
    searchesLeft -= 1;
    try {
      return await source.searchCode(term);
    } catch {
      return [];
    }
  };

  const deleted = new Set(changeSet.files.filter((file) => file.changeType === "deleted").map((file) => file.path));
  const present = new Set(changeSet.files.filter((file) => file.changeType !== "deleted").map((file) => file.path));
  // Lines the change adds, by file, so a reference the change itself adds is
  // found without a search (the index has never seen it).
  const added = changeSet.files
    .filter((file) => file.changeType !== "deleted")
    .map((file) => ({
      path: file.path,
      lines: file.hunks.flatMap((hunk) => hunkLines(hunk).filter((line) => line.marker === "+" && line.line !== undefined)),
    }));

  // Whether `text` (lines of `path`) refers to the target anywhere but on the
  // finding's own lines. `matches` decides what a reference looks like.
  const refersIn = (
    path: string,
    lines: { line: number; text: string }[],
    finding: Finding,
    matches: (text: string) => boolean,
  ): boolean =>
    lines.some(
      ({ line, text }) =>
        !(path === finding.file && line >= finding.startLine && line <= finding.endLine) &&
        !isCommentLine(text) &&
        matches(text),
    );

  const numbered = (content: string) => content.split("\n").map((text, index) => ({ line: index + 1, text }));

  // A reference in the diff, the finding's own file, or a searched file read
  // at the head. Search candidates the change deletes are skipped: their
  // references go with them.
  const referenced = async (finding: Finding, term: string, matches: (text: string) => boolean, skip?: string): Promise<boolean> => {
    for (const file of added) {
      if (file.path !== skip && refersIn(file.path, file.lines.map((l) => ({ line: l.line!, text: l.text })), finding, matches)) {
        return true;
      }
    }
    if (finding.file !== skip) {
      const own = await read(finding.file);
      if (own && refersIn(finding.file, numbered(own), finding, matches)) return true;
    }
    for (const path of await search(term)) {
      if (path === finding.file || path === skip || deleted.has(path)) continue;
      const content = await read(path);
      if (content === undefined) break;
      if (content && refersIn(path, numbered(content), finding, matches)) return true;
    }
    return false;
  };

  const check = async (finding: Finding, claim: Claim): Promise<Outcome> => {
    switch (claim.kind) {
      case "missing_path": {
        const path = safePath(claim.subject);
        if (!path || deleted.has(path)) return "inconclusive";
        if (present.has(path)) return "refuted";
        return (await read(path)) ? "refuted" : "inconclusive";
      }
      case "unused_symbol": {
        const name = claim.subject.trim();
        if (!IDENTIFIER.test(name) || name.length < MIN_TERM_LENGTH) return "inconclusive";
        const word = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}($|[^\\w$])`);
        // Another declaration of the same name is a different symbol, not a
        // use. Broader than context/symbols.ts, which only wants callables.
        const declares = new RegExp(
          `\\b(?:const|let|var|val|function\\*?|def|fn|func|class|interface|struct|enum|trait|type)\\s+${escapeRegExp(name)}\\b`,
        );
        const uses = (text: string) => word.test(text) && !declares.test(text);
        return (await referenced(finding, name, uses)) ? "refuted" : "inconclusive";
      }
      case "unreferenced_file": {
        const path = safePath(claim.subject);
        const term = path && stem(path);
        if (!path || !term || term.length < MIN_TERM_LENGTH || !IDENTIFIER.test(term.replace(/-/g, "_"))) return "inconclusive";
        // An import or path string naming the file, with or without its
        // extension: "./format", '../lib/format.js', `format.ts`.
        const specifier = new RegExp(`["'\`][^"'\`]*\\b${escapeRegExp(term)}(\\.[\\w.]+)?["'\`]`);
        return (await referenced(finding, term, (text) => specifier.test(text), path)) ? "refuted" : "inconclusive";
      }
    }
  };

  const dropped: Partial<Record<DropReason, number>> = {};
  const findings: Finding[] = [];
  let checked = 0;
  let inconclusive = 0;
  // One at a time, so the shared caps are spent on the worst findings first
  // (the validator sorted them).
  for (const finding of input.findings) {
    if (!finding.claim) {
      findings.push(finding);
      continue;
    }
    checked += 1;
    if ((await check(finding, finding.claim)) === "refuted") {
      dropped.claim_refuted = (dropped.claim_refuted ?? 0) + 1;
      continue;
    }
    inconclusive += 1;
    findings.push(finding);
  }
  return { findings, dropped, checked, inconclusive };
}
