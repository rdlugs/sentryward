import type { Config } from "../config/schema.ts";
import { canAnchor } from "../core/buckets.ts";
import type { ChangedFile, ChangeSet, IssueContext, IssueRequirement, LlmUsage, RiskyArea, Walkthrough } from "../core/models.ts";
import { estimateTokens } from "../context/budget.ts";
import { renderFileDiff } from "../context/diffText.ts";
import { riskFacts } from "../context/risk.ts";
import {
  DEFAULT_HIGH_LEVEL_SUMMARY_INSTRUCTIONS,
  WALKTHROUGH_SYSTEM_PROMPT,
  walkthroughUserPrompt,
  type WalkthroughExtras,
} from "./prompt.ts";
import { callUsage, failedUsage, type Generate, generateWithFallback, modelChain } from "./providers.ts";
import {
  MAX_ISSUE_REQUIREMENTS,
  repairWalkthroughOutput,
  walkthroughSchemaFor,
  type FullWalkthroughOutput,
} from "./schemas.ts";

// The overview needs breadth, not every line: files are included whole until
// this budget, then listed by name only.
const WALKTHROUGH_DIFF_TOKENS = 20_000;

function overviewDiff(files: ChangedFile[]): string {
  const blocks: string[] = [];
  const listed: string[] = [];
  let tokens = 0;
  for (const file of files) {
    const text = renderFileDiff(file);
    const fileTokens = estimateTokens(text);
    if (tokens + fileTokens <= WALKTHROUGH_DIFF_TOKENS) {
      blocks.push(text);
      tokens += fileTokens;
    } else {
      listed.push(`- ${file.path} (${file.changeType})`);
    }
  }
  if (listed.length) blocks.push(`Also changed (diff not shown):\n${listed.join("\n")}`);
  return blocks.join("\n\n");
}

// Issues the forge found for the change, fetched by the worker. An empty list
// means none were found; undefined means the setting is off or the lookup failed.
export interface WalkthroughIssues {
  linked?: IssueContext[];
  candidates?: IssueContext[];
}

// A diagram is kept only when it is one; anything else the model wrote there
// would render as a broken block on the forge.
function diagramSource(text: string | undefined): string | undefined {
  const source = (text ?? "")
    .trim()
    .replace(/^```(?:mermaid)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  return /^sequenceDiagram\b/.test(source) ? source.replaceAll("```", "") : undefined;
}

type ModelRequirement = NonNullable<FullWalkthroughOutput["linkedIssues"]>[number]["requirements"][number];

// The model reads a trimmed overview of the diff, so a location it gives is
// checked rather than trusted: a file must be one the change touches, and a
// line one the diff shows. Anything else is dropped, never guessed at.
function checkedRequirements(entries: ModelRequirement[] | undefined, changeSet: ChangeSet): IssueRequirement[] {
  const known = new Set(changeSet.files.map((file) => file.path));
  return (entries ?? []).flatMap((entry) => {
    const text = entry.text.trim();
    if (!text) return [];
    const file = entry.file.trim();
    const line = Math.round(entry.line);
    const fix = entry.fix.trim();
    return [
      {
        text,
        status: entry.status,
        ...(known.has(file) ? { file } : {}),
        ...(known.has(file) && line > 0 && canAnchor(file, line, changeSet) ? { line } : {}),
        ...(fix && entry.status !== "met" ? { fix } : {}),
      },
    ];
  }).slice(0, MAX_ISSUE_REQUIREMENTS);
}

export async function generateWalkthrough(
  generate: Generate,
  changeSet: ChangeSet,
  files: ChangedFile[],
  config: Config,
  issues: WalkthroughIssues = {},
  risky: RiskyArea[] = [],
): Promise<{ walkthrough: Walkthrough; usage: LlmUsage; failedUsage: LlmUsage[] }> {
  const { output: settings } = config;
  // Nothing to assess or pick from means nothing to ask for.
  const linked = settings.assessLinkedIssues && issues.linked?.length ? issues.linked : undefined;
  const candidates = settings.relatedIssues && issues.candidates?.length ? issues.candidates : undefined;
  const extras: WalkthroughExtras = {
    sequenceDiagram: settings.sequenceDiagrams,
    highLevelSummary: settings.highLevelSummary
      ? settings.highLevelSummaryInstructions.trim() || DEFAULT_HIGH_LEVEL_SUMMARY_INSTRUCTIONS
      : undefined,
    linkedIssues: linked,
    candidateIssues: candidates,
    ...(risky.length ? { riskFacts: riskFacts(risky) } : {}),
  };
  const schema = walkthroughSchemaFor({
    sequenceDiagram: extras.sequenceDiagram,
    highLevelSummary: extras.highLevelSummary !== undefined,
    linkedIssues: !!linked,
    relatedIssues: !!candidates,
  });
  const response = await generateWithFallback(generate, modelChain(config.llm, "walkthrough"), {
    system: WALKTHROUGH_SYSTEM_PROMPT,
    prompt: walkthroughUserPrompt(changeSet, overviewDiff(files), extras),
    schema,
    schemaName: "walkthrough",
    repair: repairWalkthroughOutput,
    temperature: config.llm.temperature,
    // Diagrams, summaries and issue notes need room beyond the overview, and
    // a requirement list for each linked issue more again.
    maxOutputTokens: Math.min(
      config.llm.maxTokens,
      linked ? 8000 : extras.sequenceDiagram || extras.highLevelSummary !== undefined || candidates ? 6000 : 4000,
    ),
  });
  const known = new Set(changeSet.files.map((file) => file.path));
  const output = response.object as FullWalkthroughOutput;
  const diagram = extras.sequenceDiagram ? diagramSource(output.sequenceDiagram) : undefined;
  const summary = output.highLevelSummary?.trim();
  // Only issues the forge returned are kept, so a reply cannot invent one or
  // link somewhere else.
  const linkedByRef = new Map((linked ?? []).map((issue) => [issue.ref, issue]));
  const candidateByRef = new Map((candidates ?? []).map((issue) => [issue.ref, issue]));
  const issueRef = ({ body: _body, ...ref }: IssueContext) => ref;
  return {
    walkthrough: {
      overview: output.overview.trim(),
      fileSummaries: output.fileSummaries.filter((entry) => known.has(entry.path)),
      labels: output.labels.map((label) => label.trim()).filter(Boolean).slice(0, 5),
      estimatedEffort: Math.min(5, Math.max(1, Math.round(output.estimatedEffort))),
      blastRadius: output.blastRadius,
      ...(diagram ? { sequenceDiagram: diagram } : {}),
      ...(extras.highLevelSummary !== undefined && summary ? { highLevelSummary: summary } : {}),
      ...(linked
        ? {
            linkedIssues: (output.linkedIssues ?? []).flatMap((entry) => {
              const issue = linkedByRef.get(entry.ref.trim());
              if (!issue) return [];
              linkedByRef.delete(issue.ref);
              const requirements = checkedRequirements(entry.requirements, changeSet);
              return [
                {
                  ...issueRef(issue),
                  assessment: entry.assessment,
                  note: entry.note.trim(),
                  ...(requirements.length ? { requirements } : {}),
                },
              ];
            }),
          }
        : {}),
      ...(candidates
        ? {
            relatedIssues: (output.relatedIssues ?? []).flatMap((entry) => {
              const issue = candidateByRef.get(entry.ref.trim());
              if (!issue) return [];
              candidateByRef.delete(issue.ref);
              return [{ ...issueRef(issue), reason: entry.reason.trim() }];
            }),
          }
        : {}),
    },
    usage: {
      purpose: "walkthrough",
      model: response.model,
      ...callUsage(response),
      latencyMs: response.latencyMs,
    },
    failedUsage: failedUsage(response.failedAttempts ?? [], "walkthrough"),
  };
}
