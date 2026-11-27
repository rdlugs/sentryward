import type { Config } from "../config/schema.ts";
import type { Walkthrough } from "../core/models.ts";

export const BLAST_RADIUS_LABELS: Record<NonNullable<Walkthrough["blastRadius"]>, string> = {
  small: "Small blast radius",
  medium: "Medium blast radius",
  large: "Large blast radius",
};

// Indexed by the walkthrough's 1-5 effort estimate.
export const EFFORT_LABELS: Record<number, string> = {
  1: "1-5 Minutes",
  2: "5-10 Minutes",
  3: "10-20 Minutes",
  4: "20-40 Minutes",
  5: "40+ Minutes",
};

// The labels this review should carry, and the rest of each enabled family to
// take off, so a later run that changes its estimate replaces the old label.
// A family that is turned off is left alone: those labels may be the team's own.
export function labelChanges(walkthrough: Walkthrough, output: Config["output"]): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  const pick = (family: Record<string | number, string>, current: string | undefined) => {
    if (current) add.push(current);
    remove.push(...Object.values(family).filter((label) => label !== current));
  };
  if (output.blastRadiusLabel && walkthrough.blastRadius) {
    pick(BLAST_RADIUS_LABELS, BLAST_RADIUS_LABELS[walkthrough.blastRadius]);
  }
  if (output.effortLabel) pick(EFFORT_LABELS, EFFORT_LABELS[walkthrough.estimatedEffort]);
  return { add, remove };
}

// The labels the change carries once this run's label changes land, which is
// what the approval's block_labels policy must judge. When the write failed
// (`applied` false) the additions still count but the removals do not, so a
// failure can only hold an approval back, never let one through.
export function labelsAfter(labels: string[] | undefined, changes: { add: string[]; remove: string[] }, applied = true): string[] {
  const removed = new Set(applied ? changes.remove : []);
  const kept = (labels ?? []).filter((label) => !removed.has(label));
  return [...new Set([...kept, ...changes.add])];
}
