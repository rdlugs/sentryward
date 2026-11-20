import type { Config, Specialist } from "../config/schema.ts";

// A lens is one way of looking at a planned chunk. Every chunk gets the
// general pass; a deep review (review.deep) adds one specialist pass per chunk
// for each selected specialist, each told to look for one kind of defect
// only. Narrow instructions find what a general pass skims over, at the cost
// of one model call per specialist per pass.
export interface Lens {
  // "general" for the general pass, otherwise the specialist's name.
  id: string;
  kind: "general" | "specialist";
  // What the pass looks for, appended to the system prompt. Written here, never
  // taken from a repository or a request, so it is trusted like the prompt.
  instructions?: string;
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

export function specialistLenses(config: Config): Lens[] {
  if (!config.review.deep.enabled) return [];
  return config.review.deep.specialists.map((id) => ({ id, kind: "specialist", instructions: SPECIALIST_INSTRUCTIONS[id] }));
}

// Every lens a review of this config runs, the general pass first.
export function lensesFor(config: Config): Lens[] {
  return [GENERAL_LENS, ...specialistLenses(config)];
}
