import type { Config } from "../config/schema.ts";
import type { DropReason } from "../validate/validator.ts";
import { bucketFor } from "./buckets.ts";
import { fingerprint } from "./fingerprint.ts";
import type { ChangeSet, Finding, Walkthrough } from "./models.ts";
import { atLeast } from "./severity.ts";

const MAX_TITLE_CHARS = 160;
const SEVERITY = "major";
const CONFIDENCE = 0.5;

export interface RequirementGaps {
  findings: Finding[];
  dropped: Partial<Record<DropReason, number>>;
}

// A requirement a linked issue asks for that the walkthrough judged missing,
// as a finding, so it is listed under "Requirements not met", tracked across
// runs by fingerprint and counted by the verdict like any other.
// Major rather than critical: it rests on the model reading free-form issue
// text, so it blocks only where a workspace chose blockOn major or lower.
// Partial requirements stay in the linked-issue table only, so one gap is
// never reported twice. A gap has no line by nature; when the walkthrough named
// no changed file for it, the file is empty and surfaces show the issue instead.
// The workspace's floor and minimum confidence apply as to any finding;
// review.categories does not, since turning on assess_linked_issues already
// asked for these.
export function requirementGapFindings(
  walkthrough: Walkthrough | undefined,
  changeSet: ChangeSet,
  config: Pick<Config, "review">,
  ignoredFingerprints?: ReadonlySet<string>,
): RequirementGaps {
  const findings: Finding[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  const seen = new Set<string>();
  for (const issue of walkthrough?.linkedIssues ?? []) {
    for (const requirement of issue.requirements ?? []) {
      if (requirement.status !== "missing") continue;
      const title = truncate(`${issue.ref}: ${requirement.text}`, MAX_TITLE_CHARS);
      const file = requirement.file ?? "";
      const line = requirement.line ?? 1;
      // The file is left out of the identity: the model names it afresh on
      // every run and may name another one or none, and the same requirement
      // must stay the same gap (and stay dismissed) when it does.
      const id = gapFingerprint(title);
      if (seen.has(id) || ignoredFingerprints?.has(id)) continue;
      seen.add(id);
      if (CONFIDENCE < config.review.minConfidence) {
        dropped.low_confidence = (dropped.low_confidence ?? 0) + 1;
        continue;
      }
      if (!atLeast(SEVERITY, config.review.severityFloor)) {
        dropped.below_floor = (dropped.below_floor ?? 0) + 1;
        continue;
      }
      const identity = { file, category: "logic" as const, kind: "requirement_gap" as const, title };
      findings.push({
        ...identity,
        startLine: line,
        endLine: line,
        severity: SEVERITY,
        effort: "moderate",
        body: [`${issue.ref} (${issue.title}) asks for this, and the change does not do it.`, requirement.fix ?? ""]
          .filter(Boolean)
          .join(" "),
        confidence: CONFIDENCE,
        // The issue is the contract the change is measured against.
        evidence: "contract",
        evidenceNote: `Linked issue ${issue.ref}`,
        evidenceFiles: [],
        source: "llm",
        fingerprint: id,
        bucket: bucketFor({ ...identity, startLine: line }, changeSet),
      });
    }
  }
  return { findings, dropped };
}

function gapFingerprint(title: string): string {
  return fingerprint({ file: "", category: "logic", kind: "requirement_gap", title });
}

// The linked issue a gap belongs to, read back from its title ("#12: ..."),
// which is all a stored finding row keeps of it.
export function gapIssueRef(title: string): string | undefined {
  const end = title.indexOf(": ");
  return end > 0 ? title.slice(0, end) : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
