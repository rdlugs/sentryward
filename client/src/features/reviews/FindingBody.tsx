import { Bot, Copy, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { copyToClipboard } from "@/lib/clipboard"
import { findingPrompt } from "./agentPrompt"
import { findingLines, forgeFileUrl } from "./links"
import type { Finding, ReviewResult, Verification } from "./types"
import { NO_FILE_LABEL } from "./findingLocation"

const VERIFICATION: Record<Verification, { label: string; title: string; variant: "secondary" | "outline" }> = {
  verified: { label: "Verified", title: "Confirmed by a second, independent model check", variant: "secondary" },
  uncertain: { label: "Uncertain", title: "A second model check could not confirm or rule it out", variant: "outline" },
  not_checked: { label: "Not verified", title: "No second model check ran for this finding", variant: "outline" },
}

// A finding's full text, shared by the review page's cards and the findings sheet.
export function FindingBody({ finding, change }: { finding: Finding; change: ReviewResult["change"] }) {
  const lines = findingLines(finding)
  const verification = finding.verification ?? "not_checked"
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{finding.category}</Badge>
        {finding.kind !== "potential_issue" && <Badge variant="outline">{finding.kind.replace(/_/g, " ")}</Badge>}
        {finding.source === "rule" && finding.ruleId && <Badge variant="secondary">Rule {finding.ruleId}</Badge>}
        {finding.reviewerName ? (
          <Badge variant="secondary" title="Found by a custom reviewer this team defined">
            Reviewer: {finding.reviewerName}
          </Badge>
        ) : (
          finding.reviewer && (
            <Badge variant="secondary" title="Found by a deep review specialist">
              Deep: {finding.reviewer}
            </Badge>
          )
        )}
        {/* An analyzer's result, or a rule's pattern match (no model behind it), has no confidence of its own. */}
        {finding.source === "tool" ? (
          <Badge variant="secondary">via {finding.tool ?? "static analysis"}</Badge>
        ) : finding.source === "rule" && !finding.model ? null : (
          <>
            <Badge variant={VERIFICATION[verification].variant} title={VERIFICATION[verification].title}>
              {VERIFICATION[verification].label}
            </Badge>
            {/* Self-reported and uncalibrated: labelled so it never reads as a probability. */}
            <span className="text-xs text-muted-foreground" title="The model's own estimate, not a calibrated probability">
              Self-reported confidence {Math.round(finding.confidence * 100)}% · {finding.effort.replace(/_/g, " ")}
            </span>
          </>
        )}
        {finding.file ? (
          <a
            href={forgeFileUrl(change, finding.file, finding.startLine, finding.endLine)}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:underline"
          >
            {finding.file}:{lines}
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <span className="ml-auto text-xs text-muted-foreground">{NO_FILE_LABEL}</span>
        )}
      </div>
      {/* Model text is shown as plain text; it is never rendered as HTML. */}
      <p className="text-sm whitespace-pre-wrap">{finding.body}</p>
      {finding.impact && (
        <p className="text-sm">
          <span className="font-medium">Impact:</span> {finding.impact}
        </p>
      )}
      {finding.evidenceNote && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Evidence ({finding.evidence.replace(/_/g, " ")}):</span>{" "}
          {finding.evidenceNote}
        </p>
      )}
      {finding.suggestion && (
        <div className="relative">
          <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-10 text-xs">
            <code>{finding.suggestion}</code>
          </pre>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-1 right-1 size-7"
            aria-label="Copy suggestion"
            onClick={() => copyToClipboard(finding.suggestion!, "Suggestion")}
          >
            <Copy />
          </Button>
        </div>
      )}
      {finding.fixRationale && (
        <p className="text-sm">
          <span className="font-medium">Why this fix works:</span> {finding.fixRationale}
        </p>
      )}
      <div>
        <Button variant="outline" size="sm" onClick={() => copyToClipboard(findingPrompt(finding), "Agent prompt")}>
          <Bot />
          Copy agent prompt
        </Button>
      </div>
    </>
  )
}
