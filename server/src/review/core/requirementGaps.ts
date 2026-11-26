import { bucketFor } from "./buckets.ts";
import { fingerprint } from "./fingerprint.ts";
import type { ChangeSet, Finding, Walkthrough } from "./models.ts";

const MAX_TITLE_CHARS = 160;

// A requirement a linked issue asks for that the walkthrough judged missing,
// as a finding, so it is listed under "Requirements not met", tracked across
// runs by fingerprint and counted by the verdict like any other.
// Major rather than critical: it rests on the model reading free-form issue
// text, so it blocks only where a workspace chose blockOn major or lower.
// Partial requirements stay in the linked-issue table only, so one gap is
// never reported twice. A gap has no line by nature; when the walkthrough named
// no changed file for it, the file is empty and surfaces show the issue instead.
export function requirementGapFindings(
  walkthrough: Walkthrough | undefined,
  changeSet: ChangeSet,
  ignoredFingerprints?: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const issue of walkthrough?.linkedIssues ?? []) {
    for (const requirement of issue.requirements ?? []) {
      if (requirement.status !== "missing") continue;
      const title = truncate(`${issue.ref}: ${requirement.text}`, MAX_TITLE_CHARS);
      const file = requirement.file ?? "";
      const line = requirement.line ?? 1;
      const identity = { file, category: "logic" as const, kind: "requirement_gap" as const, title };
      const id = fingerprint(identity);
      if (seen.has(id) || ignoredFingerprints?.has(id)) continue;
      seen.add(id);
      findings.push({
        ...identity,
        startLine: line,
        endLine: line,
        severity: "major",
        effort: "moderate",
        body: [`${issue.ref} (${issue.title}) asks for this, and the change does not do it.`, requirement.fix ?? ""]
          .filter(Boolean)
          .join(" "),
        confidence: 0.5,
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
  return findings;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
