import type { Config } from "../config/schema.ts";
import type { ChangedFile, ForgeProvider } from "../core/models.ts";
import type { CommitStatus } from "../forge/types.ts";
import { runReview } from "../pipeline.ts";
import { inlineComments } from "../publish/inline.ts";
import { labelChanges } from "../publish/labels.ts";
import { inlineLimits } from "../core/buckets.ts";
import { withDescriptionSummary } from "../core/markers.ts";
import { descriptionSummary, summaryPlacement } from "../publish/publisher.ts";
import { commitStatus } from "../publish/status.ts";
import { SAMPLE_NOW, sampleChange, sampleGenerate, sampleIssues } from "./sample.ts";

export interface DiffLine {
  type: "add" | "context";
  oldLine: number | null;
  newLine: number;
  text: string;
}

export interface PreviewInline {
  path: string;
  startLine: number;
  endLine: number;
  body: string;
  // The lines up to the comment, as a forge shows above an inline thread.
  diff: DiffLine[];
}

export interface PreviewPublication {
  provider: ForgeProvider;
  pr: {
    title: string;
    number: number;
    author: string;
    sourceBranch: string;
    targetBranch: string;
    labels: string[];
    // The description after publishing, with the high-level summary when it goes there.
    description: string;
  };
  status: CommitStatus | null;
  summaryComment: string | null;
  walkthroughComment: string | null;
  inline: PreviewInline[];
}

// How many lines of the diff to show above an inline comment.
const DIFF_CONTEXT = 4;

function diffAbove(file: ChangedFile, endLine: number): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.content.split("\n")) {
      if (raw.startsWith("@@")) continue;
      const marker = raw[0];
      if (marker === "-") {
        oldLine += 1;
        continue;
      }
      if (marker === "+") lines.push({ type: "add", oldLine: null, newLine, text: raw.slice(1) });
      else lines.push({ type: "context", oldLine, newLine, text: raw.slice(1) });
      if (marker !== "+") oldLine += 1;
      newLine += 1;
    }
  }
  const last = lines.findIndex((line) => line.newLine === endLine);
  return last === -1 ? [] : lines.slice(Math.max(0, last - DIFF_CONTEXT + 1), last + 1);
}

// What a requested review of the sample change would post with `config`,
// built from the same pieces publishReview uses (publish/publisher.ts), so the
// preview cannot drift from the real output.
export async function previewPublication(config: Config, provider: ForgeProvider): Promise<PreviewPublication> {
  const change = sampleChange(provider);
  const result = await runReview(
    { changeSet: change, config, issues: sampleIssues(provider) },
    { generate: sampleGenerate, now: () => SAMPLE_NOW },
  );
  const { output } = config;

  const placement = summaryPlacement(config, result);
  const files = new Map(change.files.map((file) => [file.path, file]));

  return {
    provider,
    pr: {
      title: change.title,
      number: change.forgeRef.number,
      author: change.author ?? "",
      sourceBranch: change.headRef ?? "",
      targetBranch: change.baseRef ?? "",
      labels: result.walkthrough ? labelChanges(result.walkthrough, output).add : [],
      description: withDescriptionSummary(change.description, descriptionSummary(config, result)),
    },
    status: output.postCheck ? commitStatus(result) : null,
    // The sample change has no earlier summary to update.
    summaryComment: placement.summaryCreate ? placement.summary : null,
    walkthroughComment: placement.walkthroughComment,
    inline: output.postInline
      ? inlineComments(result.findings, change, provider, new Set(), {
          agentPrompt: output.agentPrompts,
          rules: config.rules,
          limits: inlineLimits(output),
        }).map((comment) => ({
          path: comment.path,
          startLine: comment.startLine,
          endLine: comment.endLine,
          body: comment.body,
          diff: diffAbove(files.get(comment.path)!, comment.endLine),
        }))
      : [],
  };
}
