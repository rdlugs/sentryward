import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { ConfigOverride } from "../src/review/config/schema.ts";
import type { ChangeSet, ReviewResult } from "../src/review/core/models.ts";
import { approvalBody, approvalDecision } from "../src/review/publish/approve.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { sampleResult } from "./helpers/result.ts";

type Approval = NonNullable<NonNullable<ConfigOverride["output"]>["approval"]>;

// Only the dashboard layers can turn approval on (resolve.ts holdApproval).
const config = (approval: Approval = {}) =>
  resolveConfig({ global: { output: { approval: { enabled: true, ...approval } } } }).config;

async function passing(findings = true): Promise<ReviewResult> {
  const result = await sampleResult();
  return {
    ...result,
    status: "completed",
    findings: findings ? result.findings : [],
    verdict: { verdict: "pass", blockOn: "critical", blocking: [] },
  };
}

const change = (overrides: Partial<ChangeSet> = {}): ChangeSet => ({ ...makeChangeSet(), author: "alice", labels: [], ...overrides });

const ROUTE_PATCH = ["@@ -3,2 +3,2 @@", " ", '-router.get("/users", requireAuth, list);', '+router.get("/users", list);'].join("\n");

describe("approvalDecision", () => {
  it("does nothing while approval is off", async () => {
    const off = resolveConfig({}).config;
    expect(off.output.approval.enabled).toBe(false);
    expect(approvalDecision(off, await passing(), change())).toBeNull();
  });

  it("approves a passing review, and with when: no_findings only one with no findings", async () => {
    expect(approvalDecision(config(), await passing(), change())).toEqual({ action: "approve", reasons: [] });
    expect(approvalDecision(config({ when: "no_findings" }), await passing(), change())).toMatchObject({
      action: "withdraw",
      reasons: [expect.stringMatching(/findings? still open/)],
    });
    expect(approvalDecision(config({ when: "no_findings" }), await passing(false), change())).toEqual({
      action: "approve",
      reasons: [],
    });
  });

  it("withdraws when the review did not complete and found nothing blocking", async () => {
    const partial = { ...(await passing(false)), status: "partial" as const };
    expect(approvalDecision(config(), partial, change())).toEqual({ action: "withdraw", reasons: ["The review did not complete"] });
    const error = { ...(await passing(false)), verdict: { verdict: "error" as const, blockOn: "critical" as const, blocking: [] } };
    expect(approvalDecision(config(), error, change())?.action).toBe("withdraw");
  });

  it("withdraws on a blocked verdict, or requests changes when asked", async () => {
    const blocked = await sampleResult();
    expect(approvalDecision(config(), blocked, change())).toEqual({
      action: "withdraw",
      reasons: ["1 finding at or above critical"],
    });
    expect(approvalDecision(config({ requestChanges: true }), blocked, change())?.action).toBe("request_changes");
  });

  it("names the blocking findings of a partial review rather than calling it incomplete", async () => {
    const blocked = { ...(await sampleResult()), status: "partial" as const };
    expect(approvalDecision(config({ requestChanges: true }), blocked, change())).toEqual({
      action: "request_changes",
      reasons: ["1 finding at or above critical"],
    });
  });

  it("holds the approval back when the forge listed only part of the files", async () => {
    expect(approvalDecision(config(), await passing(), change({ filesTruncated: true }))).toEqual({
      action: "withdraw",
      reasons: [expect.stringMatching(/^The forge listed only \d+ files? of the change/)],
    });
  });

  it("holds the approval back for a blocked path, on either side of a rename", async () => {
    const policy = config({ blockPaths: ["infra/**"] });
    const touched = change({
      files: makeChangeSet([{ path: "infra/main.tf", changeType: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" }]).files,
    });
    expect(approvalDecision(policy, await passing(), touched)).toEqual({
      action: "withdraw",
      reasons: ["It changes infra/main.tf, which needs a person's approval"],
    });
    const moved = change({
      files: [{ ...makeChangeSet().files[0]!, path: "src/main.tf", previousPath: "infra/main.tf", changeType: "renamed" }],
    });
    expect(approvalDecision(policy, await passing(), moved)?.action).toBe("withdraw");
    expect(approvalDecision(policy, await passing(), change())?.action).toBe("approve");
  });

  it("approves only listed authors and never skipped ones, ignoring case", async () => {
    const result = await passing();
    expect(approvalDecision(config({ onlyAuthors: ["Alice"] }), result, change())?.action).toBe("approve");
    expect(approvalDecision(config({ onlyAuthors: ["bob"] }), result, change())).toEqual({
      action: "withdraw",
      reasons: ["Changes by alice are not approved automatically"],
    });
    expect(approvalDecision(config({ onlyAuthors: ["bob"] }), result, change({ author: undefined }))?.reasons).toEqual([
      "The change's author is unknown",
    ]);
    expect(approvalDecision(config({ skipAuthors: ["ALICE"] }), result, change())?.action).toBe("withdraw");
  });

  it("holds the approval back for a blocking label, matched exactly", async () => {
    const result = await passing();
    const policy = config({ blockLabels: ["needs-review"] });
    expect(approvalDecision(policy, result, change({ labels: ["needs-review"] }))?.reasons).toEqual([
      'The change has the label "needs-review"',
    ]);
    expect(approvalDecision(policy, result, change({ labels: ["Needs-Review"] }))?.action).toBe("approve");
  });

  it("holds the approval back for the risk kinds asked for, read from the diff", async () => {
    const result = await passing();
    const routes = change({ files: makeChangeSet([{ path: "src/routes/users.ts", changeType: "modified", patch: ROUTE_PATCH }]).files });
    expect(approvalDecision(config({ blockOnRisk: ["auth"] }), result, routes)).toEqual({
      action: "withdraw",
      reasons: ["It touches authorization"],
    });
    expect(approvalDecision(config({ blockOnRisk: ["database"] }), result, routes)?.action).toBe("approve");
    expect(approvalDecision(config(), result, routes)?.action).toBe("approve");
  });

  it("lists every policy that matched", async () => {
    const decision = approvalDecision(
      config({ skipAuthors: ["alice"], blockLabels: ["hold"] }),
      await passing(),
      change({ labels: ["hold"] }),
    );
    expect(decision?.reasons).toHaveLength(2);
  });
});

describe("approvalBody", () => {
  it("says why, with the link to the review", async () => {
    const result = await passing();
    expect(approvalBody(result, { action: "approve", reasons: [] }, "http://x")).toBe(
      "Sentryward approves this change: No findings at or above critical.\n\n[Review in Sentryward](http://x)",
    );
    expect(approvalBody(await passing(false), { action: "approve", reasons: [] })).toBe("Sentryward approves this change: No findings.");
    expect(approvalBody(result, { action: "request_changes", reasons: ["a", "b"] })).toBe("Sentryward requests changes: a; b.");
    expect(approvalBody(result, { action: "withdraw", reasons: ["a"] })).toBe("Sentryward no longer approves this change: a.");
  });
});
