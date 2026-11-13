import { Fragment, useMemo, useState } from "react"
import { ExternalLink, FileX, MapPin } from "lucide-react"
import { cn } from "@/lib/utils"
import { FindingCard } from "../FindingCard"
import { forgeFileUrl } from "../links"
import { SEVERITY_BORDER } from "../severity"
import { SEVERITIES, type ChangedFile, type Finding, type ReviewResult, type Severity } from "../types"
import { parsePatch, type DiffRow } from "./parsePatch"

const OMITTED_TEXT: Record<NonNullable<ChangedFile["patchOmitted"]>, string> = {
  binary: "Binary file, no text diff to show.",
  unavailable: "The forge did not provide a diff for this file.",
  too_large: "This diff is too large to keep with the review.",
}

const ROW_CLASS: Record<DiffRow["kind"], string> = {
  hunk: "bg-sky-500/10 text-muted-foreground",
  add: "bg-emerald-500/10",
  del: "bg-destructive/10",
  ctx: "",
}

const SIGN: Record<DiffRow["kind"], string> = { hunk: "", add: "+", del: "-", ctx: " " }

function newLineOf(row: DiffRow) {
  return row.kind === "add" || row.kind === "ctx" ? row.newLine : undefined
}

function oldLineOf(row: DiffRow) {
  return row.kind === "del" || row.kind === "ctx" ? row.oldLine : undefined
}

// Each finding sits under the last diff row of its range, as a forge shows a
// comment; one whose lines the diff does not show is listed above it.
function placeFindings(rows: DiffRow[], findings: Finding[]) {
  const after = new Map<number, Finding[]>()
  const outside: Finding[] = []
  const marks = new Map<number, Severity>()
  for (const finding of findings) {
    let anchor = -1
    rows.forEach((row, index) => {
      const line = newLineOf(row)
      if (line === undefined || line < finding.startLine || line > finding.endLine) return
      anchor = index
      const worst = marks.get(index)
      if (!worst || SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(worst)) marks.set(index, finding.severity)
    })
    if (anchor === -1) outside.push(finding)
    else after.set(anchor, [...(after.get(anchor) ?? []), finding])
  }
  return { after, outside, marks }
}

export function FileDiff({
  file,
  findings,
  change,
}: {
  file: ChangedFile
  findings: Finding[]
  change: ReviewResult["change"]
}) {
  const rows = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch])
  const placed = useMemo(() => placeFindings(rows, findings), [rows, findings])
  // Open by default: on its own lines a finding is what the reader came for.
  const [closed, setClosed] = useState<Set<string>>(() => new Set())

  function card(finding: Finding) {
    return (
      <FindingCard
        key={finding.fingerprint}
        finding={finding}
        change={change}
        open={!closed.has(finding.fingerprint)}
        onOpenChange={(open) =>
          setClosed((prev) => {
            const next = new Set(prev)
            if (open) next.delete(finding.fingerprint)
            else next.add(finding.fingerprint)
            return next
          })
        }
      />
    )
  }

  return (
    <section aria-label={`Diff of ${file.path}`} className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="min-w-0 font-mono text-sm break-all">
          {file.previousPath && file.previousPath !== file.path && (
            <span className="text-muted-foreground">{file.previousPath} → </span>
          )}
          {file.path}
        </h2>
        <span className="text-xs text-muted-foreground">
          {file.changeType} · <span className="text-emerald-700 dark:text-emerald-400">+{file.additions}</span>{" "}
          <span className="text-destructive">-{file.deletions}</span>
        </span>
        {file.changeType !== "deleted" && (
          <a
            href={forgeFileUrl(change, file.path, 1, 1)}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
          >
            View file
            <ExternalLink className="size-3" />
          </a>
        )}
      </header>

      {placed.outside.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <MapPin aria-hidden className="size-4 text-muted-foreground" />
            Outside the diff
          </h3>
          {placed.outside.map(card)}
        </div>
      )}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {rows.map((row, index) => {
                const mark = placed.marks.get(index)
                const inline = placed.after.get(index)
                return (
                  <Fragment key={index}>
                    <tr data-kind={row.kind} className={ROW_CLASS[row.kind]}>
                      {row.kind === "hunk" ? (
                        <td colSpan={4} className="px-3 py-1 whitespace-pre">
                          {row.text}
                        </td>
                      ) : (
                        <>
                          <td
                            className={cn(
                              "w-px border-l-4 border-l-transparent px-2 text-right text-muted-foreground select-none",
                              mark && SEVERITY_BORDER[mark],
                            )}
                          >
                            {oldLineOf(row)}
                          </td>
                          <td className="w-px px-2 text-right text-muted-foreground select-none">{newLineOf(row)}</td>
                          <td className="w-px pl-1 text-muted-foreground select-none">{SIGN[row.kind]}</td>
                          <td className="pr-3 whitespace-pre">{row.text}</td>
                        </>
                      )}
                    </tr>
                    {inline && (
                      <tr>
                        <td colSpan={4} className="border-y bg-background px-3 py-2 font-sans">
                          <div className="flex max-w-3xl flex-col gap-2">{inline.map(card)}</div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          <FileX aria-hidden className="size-5" />
          {file.patchOmitted
            ? OMITTED_TEXT[file.patchOmitted]
            : file.patch === undefined
              ? "No diff available for this file."
              : "No line changes in this file."}
        </div>
      )}
    </section>
  )
}
