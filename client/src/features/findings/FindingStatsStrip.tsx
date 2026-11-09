import { CircleCheck, CircleDot, ThumbsDown, Timer } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { SeverityBadge } from "@/features/reviews/badges"
import { Stat } from "@/features/reviews/ReviewStatsStrip"
import { SEVERITIES } from "@/features/reviews/types"
import { plural } from "@/lib/plural"
import { formatDuration } from "@/lib/time"
import { useFindingStats } from "./api"

const detail = "text-xs font-normal text-muted-foreground"

// What is still waiting on someone, whether findings get acted on, and how
// often they were wrong. Stays out of the way if it cannot load.
export function FindingStatsStrip() {
  const { data, isPending, isError } = useFindingStats()
  if (isError) return null
  if (isPending) return <Skeleton className="h-24 w-full" />

  const period = `last ${plural(data.days, "day")}`

  return (
    <section aria-label="Finding stats" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Open findings" icon={CircleDot}>
        {data.open}
        <div className="flex flex-wrap gap-2 pt-1 text-xs font-normal">
          {SEVERITIES.map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <SeverityBadge severity={s} />
              <span className="tabular-nums">{data.openBySeverity[s]}</span>
            </span>
          ))}
        </div>
        {data.staleOpen > 0 && (
          <div className={`pt-1 ${detail}`}>
            {data.staleOpen} older than {plural(data.days, "day")}
          </div>
        )}
      </Stat>
      <Stat label={`Resolved, ${period}`} icon={CircleCheck}>
        {data.resolutionRate === null ? "-" : `${data.resolutionRate}%`}
        <span className={`ml-2 ${detail}`}>
          {data.resolved} of {data.total}
        </span>
      </Stat>
      <Stat label="Median time to resolve" icon={Timer}>
        {data.medianTimeToResolve === null ? "-" : formatDuration(data.medianTimeToResolve)}
      </Stat>
      <Stat label={`False positives, ${period}`} icon={ThumbsDown}>
        {data.falsePositiveRate === null ? "-" : `${data.falsePositiveRate}%`}
        <span className={`ml-2 ${detail}`}>
          {data.falsePositives} of {data.found}
        </span>
      </Stat>
    </section>
  )
}
