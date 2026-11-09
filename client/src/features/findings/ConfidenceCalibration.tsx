import { useState } from "react"
import { AlertTriangle } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { plural } from "@/lib/plural"
import { useFindingCalibration } from "./api"
import { CATEGORY_LABEL } from "./options"
import type { CalibrationBucket, CalibrationGroupBy, FindingCategory } from "./types"

// Rows with fewer decided findings (fixed or dismissed as false positives, not
// everything found) are muted: a rate over so few is mostly noise.
const MIN_DECIDED = 5

const GROUP_LABEL: Record<CalibrationGroupBy, string> = {
  none: "All findings",
  model: "By model",
  category: "By category",
}

function groupName(groupBy: CalibrationGroupBy, key: string | null) {
  if (groupBy === "model") return key ?? "Unrecorded model"
  if (groupBy === "category") return key === "other" || key === null ? "Other" : CATEGORY_LABEL[key as FindingCategory] ?? key
  return null
}

function rate(value: number | null) {
  return value === null ? "-" : `${value}%`
}

function BucketTable({ label, buckets }: { label: string; buckets: CalibrationBucket[] }) {
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>Reported confidence</TableHead>
          <TableHead className="text-right">Found</TableHead>
          <TableHead className="text-right">Not re-reported</TableHead>
          <TableHead className="text-right">False positives</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {buckets.map((bucket) => (
          <TableRow key={bucket.min} className={bucket.decided < MIN_DECIDED ? "text-muted-foreground" : undefined}>
            <TableCell className="tabular-nums">
              {Math.round(bucket.min * 100)}-{Math.round(bucket.max * 100)}%
            </TableCell>
            <TableCell className="text-right tabular-nums">{bucket.found}</TableCell>
            <TableCell className="text-right tabular-nums">{rate(bucket.confirmedRate)}</TableCell>
            <TableCell className="text-right tabular-nums">{rate(bucket.falsePositiveRate)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// How the confidence models report has matched what happened to their
// findings. Confidence is the model's own number, so this is the only place it
// is set against outcomes; nothing here presents it as a probability.
export function ConfidenceCalibration({ repoId, repoName }: { repoId?: string; repoName?: string | null }) {
  const [groupBy, setGroupBy] = useState<CalibrationGroupBy>("none")
  const { data, isPending, isError } = useFindingCalibration(repoId, groupBy)

  return (
    <Card aria-label="Confidence calibration" role="region">
      <CardHeader>
        <CardTitle>How self-reported confidence holds up</CardTitle>
        <CardDescription>
          Confidence is self-reported by the model; this table shows how it has matched outcomes for findings first
          seen in the last {plural(data?.days ?? 30, "day")}{repoName ? ` in ${repoName}` : ""}. Not re-reported means a later run
          that read the file stopped reporting it, so it is an upper bound on how many were real. Rates are over findings
          that were not re-reported or dismissed as false positives; muted rows have fewer than {MIN_DECIDED} of those.
        </CardDescription>
        <CardAction>
          <Select value={groupBy} onValueChange={(value) => setGroupBy(value as CalibrationGroupBy)}>
            <SelectTrigger size="sm" aria-label="Group calibration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {(Object.keys(GROUP_LABEL) as CalibrationGroupBy[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {GROUP_LABEL[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Could not load confidence calibration.</AlertTitle>
          </Alert>
        ) : data.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No model findings with a reported confidence yet.</p>
        ) : (
          data.groups.map((group) => {
            // The grouping the data was fetched with: while a new one loads, the previous table stays up.
            const name = groupName(data.groupBy, group.key)
            return (
              <div key={String(group.key)} className="flex flex-col gap-2">
                {name && <h3 className="text-sm font-medium">{name}</h3>}
                <BucketTable label={name ? `Calibration for ${name}` : "Calibration"} buckets={group.buckets} />
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
