import picomatch from "picomatch";
import type { Config, Specialist } from "../config/schema.ts";
import type { RiskyArea } from "../core/models.ts";

// A lens is one way of looking at a planned chunk. Every chunk gets the
// general pass; a deep review (review.deep) adds one specialist pass per chunk
// for each selected specialist, each told to look for one kind of defect
// only, and every enabled custom reviewer (config.reviewers) adds one per
// chunk holding a file it covers. Narrow instructions find what a general
// pass skims over, at the cost of one additional pass per lens, which may make
// multiple model calls in agentic mode.
export interface Lens {
  // "general" for the general pass, otherwise the specialist's or custom
  // reviewer's id. The schema keeps custom ids apart from the built-in ones.
  id: string;
  kind: "general" | "specialist" | "custom";
  // What the pass looks for, appended to the system prompt. A specialist's is
  // written here; a saved custom reviewer's comes from the dashboard or base
  // revision, while a trial accepts it from an authorized settings editor's
  // request. Both are treated as trusted like repository guidance and rules.
  instructions?: string;
  // A custom reviewer's display name, and the globs over file paths it
  // covers (absent: every reviewed file).
  name?: string;
  paths?: string[];
}

export const GENERAL_LENS: Lens = { id: "general", kind: "general" };

// One kind of defect each. They say what to look for and, as importantly, what
// to leave to the general pass, so the specialists do not repeat its findings.
export const SPECIALIST_INSTRUCTIONS: Record<Specialist, string> = {
  naming:
    "Code whose name, comment, log message or error message says one thing while the code does another: a function named for checking that also mutates, a flag whose meaning is inverted, a message describing the wrong condition, a comment the change made false.",
  invariants:
    "Broken invariants and concurrency defects: state that must stay consistent (a counter and a list, a cache and its source, two related columns) updated on one path but not another; check-then-act races; shared state mutated without the lock or transaction the surrounding code uses; assumptions about ordering between concurrent operations.",
  boundaries:
    "Boundary, index and ordering assumptions: off-by-one errors, inclusive versus exclusive ranges, empty and single-element inputs, the first and last page or item, integer overflow or truncation, time zones and date boundaries, and code that assumes a sort order, a unique key or a non-empty result it is not given.",
  contracts:
    "A changed contract whose users were not updated: a function, method, type, response shape, event payload, configuration key or database column whose signature, meaning, return value, thrown errors or nullability changed while a caller, consumer, serializer or test still relies on the old behaviour. Use the CONTEXT blocks and the list of files in the change to find those users.",
  tests:
    "Tests that would still pass if the behaviour they cover broke: assertions that cannot fail, mocks that replace the code under test, expectations copied from the implementation, asserting only that no error was thrown, a changed behaviour whose existing test was weakened or deleted, and a new branch the tests never reach. Report on the test lines, or on the changed code a test should cover.",
  leaks:
    "Data leaking where it should not go: secrets, tokens, passwords, personal data or internal identifiers written to logs, error messages, API responses, analytics events, URLs or client-side code; error details or stack traces returned to callers; fields added to a response or serializer without checking who may see them.",
  consistency:
    "Changed files that disagree with each other: a value renamed or added in one file and used under the old or a different name in another, a schema or migration that does not match the code using it, client and server disagreeing on a field or route, a constant or default changed in one place but not its copies. Use the list of files in the change to see what else was changed.",
};

// Whether this review runs the specialists. "auto" decides from the risky
// areas of the files the run reviews; `auto` is set only then, so the result
// can say why deep review did or did not run.
export interface DeepDecision {
  run: boolean;
  auto?: { matched: RiskyArea[] };
}

export function deepDecision(config: Config, areas: RiskyArea[]): DeepDecision {
  const { enabled, autoOn } = config.review.deep;
  if (enabled !== "auto") return { run: enabled };
  const matched = areas.filter((area) => autoOn.includes(area.kind));
  return { run: matched.length > 0, auto: { matched } };
}

// Compared with true, never read as truthy: "auto" is a string.
export function specialistLenses(config: Config, runDeep = config.review.deep.enabled === true): Lens[] {
  if (!runDeep) return [];
  return config.review.deep.specialists.map((id) => ({ id, kind: "specialist", instructions: SPECIALIST_INSTRUCTIONS[id] }));
}

export function customLenses(config: Config): Lens[] {
  return config.reviewers
    .filter((reviewer) => reviewer.enabled !== false)
    .map((reviewer) => ({
      id: reviewer.id,
      kind: "custom",
      name: reviewer.name,
      instructions: reviewer.instructions,
      ...(reviewer.paths?.length ? { paths: reviewer.paths } : {}),
    }));
}

// Every lens a review of this config runs, the general pass first.
export function lensesFor(config: Config, runDeep = config.review.deep.enabled === true): Lens[] {
  return [GENERAL_LENS, ...specialistLenses(config, runDeep), ...customLenses(config)];
}

const matchers = new WeakMap<object, (path: string) => boolean>();

// Whether a lens, or the custom reviewer behind one, looks at this file. Only
// custom reviewers are scoped; the rest cover every reviewed file.
export function lensCovers(scoped: { paths?: string[] }, path: string): boolean {
  if (!scoped.paths?.length) return true;
  let matcher = matchers.get(scoped);
  if (!matcher) {
    matcher = picomatch(scoped.paths, { dot: true });
    matchers.set(scoped, matcher);
  }
  return matcher(path);
}
