import type { ChangeSet } from "../core/models.ts";
import { limiter, mapLimit } from "../core/mapLimit.ts";
import type { Chunk, ChunkPart } from "./chunk.ts";
import {
  CONTEXT_PRIORITY,
  MAX_CONTEXT_FILE_CHARS,
  declarationScope,
  fileContextBlocks,
  fileLines,
  rangesBlock,
  type ContextBlock,
} from "./fileContext.ts";
import {
  addedDeclarations,
  callLines,
  callSiteWindow,
  declarationLine,
  enclosingDeclaration,
  moduleCandidates,
  partSymbols,
  relativeImports,
  traceable,
} from "./symbols.ts";

// Where context comes from. The worker reads through the forge (and its
// cache); without a source a review sees the diff alone.
export interface ContextSource {
  // A file at the change's head revision, or null when it is not there.
  readFile(path: string): Promise<string | null>;
  // Paths of files mentioning `term`, best match first. May search another
  // revision than the head: GitHub only indexes the default branch.
  searchCode(term: string): Promise<string[]>;
  // Entries of a directory at the head revision ("" is the root), directories
  // ending in "/", or null when the path is missing or not a directory. Only
  // agentic passes list directories, so a source may leave it out.
  listDir?(path: string): Promise<string[] | null>;
}

export interface GatherInput {
  chunks: Chunk[];
  changeSet: ChangeSet;
  source: ContextSource;
  // Context tokens a pass may still take once its diff is paid for.
  budgetFor: (chunk: Chunk) => number;
  concurrency: number;
  // Hops of callers to follow from a changed name (review.impactDepth).
  depth?: number;
}

// A file outside the change that calls into it, directly or through others.
export interface ReachedCaller {
  path: string;
  // The changed name first, then each caller in between, ending with the
  // name this file calls.
  chain: string[];
  hops: number;
}

interface TracedCaller {
  chain: string[];
  path: string;
  lines: string[];
  sites: number[];
  hop: number;
}

export interface GatheredContext {
  // Rendered context per chunk, in chunk order.
  contexts: string[];
  // Every caller found, whether or not its block fit a pass.
  reach: ReachedCaller[];
  warnings: string[];
}

const MAX_DEFINITIONS_PER_PART = 6;
// Code search is the costliest lookup and GitHub rate-limits it hard, so a
// review searches for at most this many names the change defines, those
// whose declaration changed first, and at most MAX_CALLER_SEARCHES in all
// once callers of callers are traced.
const MAX_DIRECT_SEARCHES = 5;
const MAX_CALLER_SEARCHES = 8;
const MAX_CALLER_FILES = 3;
const MAX_CALL_SITES_PER_FILE = 3;
const MAX_LISTED_PATHS = 5;
// Below this a pass has no room for even a short block, so nothing is fetched for it.
const MIN_CONTEXT_TOKENS = 50;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// One from each list in turn: the first of every list, then the second.
function roundRobin(lists: string[][]): string[] {
  const out: string[] = [];
  for (let i = 0; lists.some((list) => i < list.length); i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]!);
  }
  return out;
}

// Highest priority first; a block that does not fit is skipped and smaller
// ones after it are still tried. What is left out is never an omission: the
// diff itself was reviewed in full.
export function fillContext(blocks: ContextBlock[], budget: number): string {
  const seen = new Set<string>();
  const texts: string[] = [];
  let used = 0;
  for (const block of [...blocks].sort((a, b) => a.priority - b.priority)) {
    if (seen.has(block.text)) continue;
    seen.add(block.text);
    const cost = block.tokens + 1;
    if (used + cost > budget) continue;
    texts.push(block.text);
    used += cost;
  }
  return texts.join("\n\n");
}

// Best effort throughout: a read or search that fails leaves that context
// out with a warning, and the pass reviews the diff alone.
export async function gatherContext(input: GatherInput): Promise<GatheredContext> {
  const { chunks, changeSet, source } = input;
  const failedReads = new Set<string>();
  let searchError: string | undefined;
  let searchSucceeded = false;

  // Passes gather side by side, and each fans out over its files, so the
  // forge calls themselves share one limit.
  const forgeCall = limiter(input.concurrency);
  // Every path is read once per review, however many passes want it.
  const reads = new Map<string, Promise<string[] | null>>();
  const read = (path: string): Promise<string[] | null> => {
    let pending = reads.get(path);
    if (!pending) {
      pending = forgeCall(() => source.readFile(path)).then(
        (text) => (text === null || text.length > MAX_CONTEXT_FILE_CHARS ? null : fileLines(text)),
        () => {
          failedReads.add(path);
          return null;
        },
      );
      reads.set(path, pending);
    }
    return pending;
  };
  const searches = new Map<string, Promise<string[]>>();
  const search = (term: string): Promise<string[]> => {
    let pending = searches.get(term);
    if (!pending) {
      // The first failure is most often a rate limit, which more searches
      // would only prolong, so the rest of the review goes without. Checked
      // and recorded inside the limited call, so a search already queued
      // behind the failing one sees it.
      pending = forgeCall(async () => {
        if (searchError) return [];
        try {
          const paths = await source.searchCode(term);
          searchSucceeded = true;
          return paths;
        } catch (err) {
          searchError ??= message(err);
          return [];
        }
      });
      searches.set(term, pending);
    }
    return pending;
  };

  const changed = new Set(changeSet.files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]));
  // Which files declare each name on an added line, so a name one file
  // removes and another declares counts as moved.
  const declaredBy = new Map<string, Set<string>>();
  for (const file of changeSet.files) {
    for (const name of addedDeclarations(file.hunks)) {
      let paths = declaredBy.get(name);
      if (!paths) declaredBy.set(name, (paths = new Set()));
      paths.add(file.path);
    }
  }
  const movedInto = (path: string) =>
    new Set([...declaredBy].filter(([, paths]) => [...paths].some((other) => other !== path)).map(([name]) => name));
  const symbols = new Map(
    chunks.flatMap((chunk) => chunk.parts.map((part) => [part, partSymbols(part.hunks, movedInto(part.file.path))] as const)),
  );
  const budgets = new Map(chunks.map((chunk) => [chunk, input.budgetFor(chunk)]));
  const gathered = (part: ChunkPart) => part.file.changeType !== "deleted" && !part.file.isBinary;
  const tracedParts = chunks.flatMap((chunk) => (budgets.get(chunk)! < MIN_CONTEXT_TOKENS ? [] : chunk.parts.filter(gathered)));
  // Direct callers are claimed before any pass starts, so tracing further
  // never costs a changed name its search; deeper hops share what is left,
  // in the order traceCallers reaches them. Parts take turns, changed
  // declarations first, so one file removing many names cannot take every
  // search from a broken contract in another.
  const claimed = new Set(
    [
      ...new Set([
        ...roundRobin(tracedParts.map((part) => symbols.get(part)!.defined.filter((name) => symbols.get(part)!.contracts.has(name)))),
        ...roundRobin(tracedParts.map((part) => symbols.get(part)!.defined)),
      ]),
    ].slice(0, MAX_DIRECT_SEARCHES),
  );
  const direct = new Set(claimed);
  const claim = (name: string): boolean => {
    if (claimed.has(name)) return true;
    if (claimed.size >= MAX_CALLER_SEARCHES) return false;
    claimed.add(name);
    return true;
  };
  const depth = Math.max(1, input.depth ?? 1);
  const reached = new Map<string, ReachedCaller>();

  async function definitionBlocks(part: ChunkPart, content: string, inChunk: Set<string>): Promise<ContextBlock[]> {
    const bindings = relativeImports(content);
    const wanted = symbols.get(part)!
      .called.filter((name) => bindings.has(name))
      .slice(0, MAX_DEFINITIONS_PER_PART);
    const found = await Promise.all(
      wanted.map(async (name) => {
        const binding = bindings.get(name)!;
        for (const path of moduleCandidates(part.file.path, binding.module)) {
          // The pass already shows that file's diff and scopes.
          if (inChunk.has(path)) return undefined;
          const lines = await read(path);
          if (!lines) continue;
          const line = declarationLine(lines, binding.exported);
          if (line === undefined) return undefined;
          return rangesBlock(path, `definition of ${name}`, CONTEXT_PRIORITY.definition, lines, [
            declarationScope(lines, line),
          ]);
        }
        return undefined;
      }),
    );
    return found.filter((block): block is ContextBlock => !!block);
  }

  // Breadth first from the names each part changes: each caller's enclosing
  // declaration is the next hop's name, until review.impactDepth. A name is
  // traced once per part, never through a generic name, and never into a
  // file the change touches, whose own diff already shows it. All parts
  // move a hop at a time in chunk order, and each hop's names claim
  // searches before any runs, so the shared budget and the reach list come
  // out the same however the forge's reads interleave.
  async function traceCallers(): Promise<Map<ChunkPart, TracedCaller[]>> {
    const parts = tracedParts;
    const traces = new Map(parts.map((part) => [part, [] as TracedCaller[]]));
    const traced = new Map(parts.map((part) => [part, new Set(symbols.get(part)!.defined)]));
    let frontier = parts.flatMap((part) =>
      symbols.get(part)!.defined.filter((name) => direct.has(name)).map((name) => ({ part, chain: [name] })),
    );
    for (let hop = 1; hop <= depth && frontier.length; hop++) {
      const searched = hop === 1 ? frontier : frontier.filter(({ chain }) => claim(chain.at(-1)!));
      const found = await Promise.all(
        searched.map(async ({ part, chain }) => {
          const name = chain.at(-1)!;
          const paths = (await search(name)).filter((path) => !changed.has(path)).slice(0, MAX_CALLER_FILES);
          return Promise.all(
            paths.map(async (path) => {
              const lines = await read(path);
              const sites = lines ? callLines(lines, name, MAX_CALL_SITES_PER_FILE) : [];
              return lines && sites.length ? { part, chain, path, lines, sites, hop } : undefined;
            }),
          );
        }),
      );
      const next: { part: ChunkPart; chain: string[] }[] = [];
      for (const caller of found.flat()) {
        if (!caller) continue;
        const { part, chain, path, lines, sites } = caller;
        traces.get(part)!.push(caller);
        const key = `${path}\0${chain.join("\0")}`;
        if (!reached.has(key)) reached.set(key, { path, chain, hops: hop });
        if (hop === depth) continue;
        const seen = traced.get(part)!;
        for (const line of sites) {
          const enclosing = enclosingDeclaration(lines, line);
          if (!enclosing || !traceable(enclosing.name) || seen.has(enclosing.name)) continue;
          seen.add(enclosing.name);
          next.push({ part, chain: [...chain, enclosing.name] });
        }
      }
      frontier = next;
    }
    return traces;
  }
  const tracing = traceCallers();

  function callerBlocks(part: ChunkPart, callers: TracedCaller[]): ContextBlock[] {
    const changes = symbols.get(part)!.contracts;
    return callers.flatMap(({ chain, path, lines, sites, hop }) => {
      const name = chain.at(-1)!;
      const label =
        hop === 1
          ? `call sites of ${name}${changes.has(name) ? ` (${changes.get(name)})` : ""}`
          : `call sites of ${name} (calls ${chain.slice(0, -1).reverse().join(" -> ")}; ${hop} hops from the change)`;
      const block = rangesBlock(
        path,
        label,
        hop === 1 ? CONTEXT_PRIORITY.callers : CONTEXT_PRIORITY.indirectCallers,
        lines,
        sites.map((line) => callSiteWindow(lines, line)),
      );
      return block ? [block] : [];
    });
  }

  async function partBlocks(part: ChunkPart, inChunk: Set<string>): Promise<ContextBlock[]> {
    if (!gathered(part)) return [];
    const lines = await read(part.file.path);
    const blocks = lines ? fileContextBlocks(part.file, part.hunks, lines) : [];
    if (lines) blocks.push(...(await definitionBlocks(part, lines.join("\n"), inChunk)));
    blocks.push(...callerBlocks(part, (await tracing).get(part) ?? []));
    return blocks;
  }

  const contexts = await mapLimit(chunks, input.concurrency, async (chunk) => {
    const budget = budgets.get(chunk)!;
    if (budget < MIN_CONTEXT_TOKENS) return "";
    const inChunk = new Set(chunk.parts.map((part) => part.file.path));
    const blocks = (await Promise.all(chunk.parts.map((part) => partBlocks(part, inChunk)))).flat();
    return fillContext(blocks, budget);
  });

  const warnings: string[] = [];
  if (failedReads.size) {
    const paths = [...failedReads].sort();
    const listed = paths.slice(0, MAX_LISTED_PATHS).join(", ");
    const more = paths.length > MAX_LISTED_PATHS ? ` and ${paths.length - MAX_LISTED_PATHS} more` : "";
    warnings.push(`Review context could not be read for ${listed}${more}; the diff was reviewed without it`);
  }
  if (searchError) {
    warnings.push(
      searchSucceeded
        ? `Some caller searches failed, so passes may be missing call sites: ${searchError}`
        : `Caller search failed, so passes saw no call sites: ${searchError}`,
    );
  }
  return { contexts, reach: [...reached.values()], warnings };
}
