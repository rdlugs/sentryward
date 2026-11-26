import { useMemo, type ReactNode } from "react"
import { BookOpen, ChevronRight, CircleCheck, CircleDashed, CircleHelp, CircleX, FileCode, ShieldAlert, type LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { MermaidDiagram } from "@/components/MermaidDiagram"
import { ForgeMarkdown } from "@/features/config/ForgeMarkdown"
import { cn } from "@/lib/utils"
import type { IssueAssessment, IssueRef, IssueRequirement, ReviewResult, RiskyArea } from "../types"
import type { OverviewExpansion } from "./useOverviewExpansion"

const MAX_EFFORT = 5

const ASSESSMENT_LABEL: Record<IssueAssessment, string> = {
  addressed: "Addressed",
  partial: "Partly addressed",
  not_addressed: "Not addressed",
  unclear: "Unclear",
}

const REQUIREMENT_STATUS: Record<IssueRequirement["status"], { label: string; icon: LucideIcon; className: string }> = {
  met: { label: "Met", icon: CircleCheck, className: "text-emerald-700 dark:text-emerald-400" },
  partial: { label: "Partly met", icon: CircleDashed, className: "text-amber-600 dark:text-amber-400" },
  missing: { label: "Missing", icon: CircleX, className: "text-destructive" },
  unclear: { label: "Unclear", icon: CircleHelp, className: "text-muted-foreground" },
}

function RequirementList({ requirements }: { requirements: IssueRequirement[] }) {
  const met = requirements.filter((requirement) => requirement.status === "met").length
  return (
    <div className="flex flex-col gap-1 pt-1">
      <p className="text-xs text-muted-foreground">
        {met} of {requirements.length} requirements met
      </p>
      <ul className="flex flex-col gap-1.5" aria-label="Requirements">
        {requirements.map((requirement, index) => {
          const status = REQUIREMENT_STATUS[requirement.status]
          const Icon = status.icon
          return (
            <li key={index} className="flex gap-2">
              <Icon className={cn("mt-0.5 size-4 shrink-0", status.className)} aria-label={status.label} role="img" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span>
                  {requirement.text}
                  {requirement.file && (
                    <span className="font-mono text-xs break-all text-muted-foreground">
                      {" "}
                      {requirement.file}
                      {requirement.line ? `:${requirement.line}` : ""}
                    </span>
                  )}
                </span>
                {requirement.fix && <span className="text-muted-foreground">{requirement.fix}</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const RISK_LABEL: Record<RiskyArea["kind"], string> = {
  auth: "Authorization",
  database: "Database",
  api: "API route",
}

function IssueLink({ issue }: { issue: IssueRef }) {
  const label = (
    <>
      <span className="font-mono text-xs">{issue.ref}</span> {issue.title}
    </>
  )
  return issue.url && /^https?:\/\//.test(issue.url) ? (
    <a href={issue.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
      {label}
    </a>
  ) : (
    <span>{label}</span>
  )
}

function EffortMeter({ effort }: { effort: number }) {
  const value = Math.min(MAX_EFFORT, Math.max(0, Math.round(effort)))
  return (
    <div
      role="img"
      aria-label={`Review effort ${value} of ${MAX_EFFORT}`}
      title={`Estimated review effort: ${value} of ${MAX_EFFORT}`}
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      Effort
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: MAX_EFFORT }, (_, i) => (
          <span key={i} className={cn("h-2 w-3 rounded-sm", i < value ? "bg-primary" : "bg-muted")} />
        ))}
      </span>
      <span className="tabular-nums">
        {value}/{MAX_EFFORT}
      </span>
    </div>
  )
}

function WalkthroughSection({
  title,
  count,
  expansion,
  children,
}: {
  title: string
  count?: number
  expansion: OverviewExpansion
  children: ReactNode
}) {
  const key = `walkthrough:${title}`
  const open = expansion.isExpanded(key)
  return (
    <Collapsible asChild open={open} onOpenChange={(expanded) => expansion.setExpanded([key], expanded)}>
      <section aria-label={title} className="flex flex-col border-t pt-2">
        <h3 className="text-sm font-medium">
          <CollapsibleTrigger className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <ChevronRight
              aria-hidden
              className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            />
            {title}
            {count !== undefined && <span className="font-normal text-muted-foreground">({count})</span>}
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="pt-2 pb-2">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  )
}

export function WalkthroughCard({
  walkthrough,
  provider,
  files,
  expansion,
}: {
  walkthrough: NonNullable<ReviewResult["walkthrough"]>
  provider: ReviewResult["change"]["provider"]
  files: ReviewResult["files"]
  expansion: OverviewExpansion
}) {
  const fileStats = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])
  const { fileSummaries, labels, linkedIssues, relatedIssues, riskyAreas } = walkthrough

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="size-4 text-muted-foreground" aria-hidden />
          Walkthrough
        </CardTitle>
        <CardAction>
          <EffortMeter effort={walkthrough.estimatedEffort} />
        </CardAction>
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {labels.map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <p className="pb-2 leading-relaxed whitespace-pre-wrap">{walkthrough.overview}</p>
        {riskyAreas && riskyAreas.length > 0 && (
          <WalkthroughSection title="Risky areas" count={riskyAreas.length} expansion={expansion}>
            <ul className="flex flex-col gap-2">
              {riskyAreas.map((area) => (
                <li key={`${area.kind}:${area.path}`} className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <ShieldAlert
                      className={cn("size-4 shrink-0", area.removesCheck ? "text-destructive" : "text-muted-foreground")}
                      aria-hidden
                    />
                    <Badge variant="outline">{RISK_LABEL[area.kind]}</Badge>
                    <span className="font-mono text-xs break-all">{area.path}</span>
                  </div>
                  <p className="pl-6 text-muted-foreground">
                    {area.reason}
                    {area.via && <span className="font-mono text-xs"> ({area.via})</span>}
                  </p>
                </li>
              ))}
            </ul>
          </WalkthroughSection>
        )}
        {fileSummaries.length > 0 && (
          <WalkthroughSection
            title="Changed files"
            count={fileSummaries.length}
            expansion={expansion}
          >
            <ul className="divide-y rounded-md border">
              {fileSummaries.map((entry) => {
                const file = fileStats.get(entry.path)
                return (
                  <li key={entry.path} className="flex flex-col gap-1 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <FileCode className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="font-mono text-xs break-all">{entry.path}</span>
                      {file && (
                        <span className="text-xs text-muted-foreground">
                          {file.changeType} ·{" "}
                          <span className="text-emerald-700 dark:text-emerald-400">+{file.additions}</span>{" "}
                          <span className="text-destructive">-{file.deletions}</span>
                        </span>
                      )}
                    </div>
                    <p className="pl-6">{entry.summary}</p>
                  </li>
                )
              })}
            </ul>
          </WalkthroughSection>
        )}
        {walkthrough.highLevelSummary && (
          <WalkthroughSection title="High-level summary" expansion={expansion}>
            <ForgeMarkdown provider={provider}>{walkthrough.highLevelSummary}</ForgeMarkdown>
          </WalkthroughSection>
        )}
        {walkthrough.sequenceDiagram && (
          <WalkthroughSection title="Sequence diagram" expansion={expansion}>
            <MermaidDiagram source={walkthrough.sequenceDiagram} />
          </WalkthroughSection>
        )}
        {linkedIssues && linkedIssues.length > 0 && (
          <WalkthroughSection title="Linked issues" count={linkedIssues.length} expansion={expansion}>
            <ul className="flex flex-col gap-2">
              {linkedIssues.map((issue) => (
                <li key={issue.ref} className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <IssueLink issue={issue} />
                    <Badge variant="outline">{ASSESSMENT_LABEL[issue.assessment]}</Badge>
                  </div>
                  {issue.note && <p className="text-muted-foreground">{issue.note}</p>}
                  {issue.requirements && issue.requirements.length > 0 && (
                    <RequirementList requirements={issue.requirements} />
                  )}
                </li>
              ))}
            </ul>
          </WalkthroughSection>
        )}
        {relatedIssues && relatedIssues.length > 0 && (
          <WalkthroughSection title="Possibly related issues" count={relatedIssues.length} expansion={expansion}>
            <ul className="flex flex-col gap-1">
              {relatedIssues.map((issue) => (
                <li key={issue.ref}>
                  <IssueLink issue={issue} />
                  {issue.reason && <span className="text-muted-foreground">: {issue.reason}</span>}
                </li>
              ))}
            </ul>
          </WalkthroughSection>
        )}
      </CardContent>
    </Card>
  )
}
