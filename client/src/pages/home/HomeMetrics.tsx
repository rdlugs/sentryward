import { CircleX, Coins, GitPullRequest, ShieldAlert } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { useFindingStats } from "@/features/findings/api"
import { useReviewStats } from "@/features/reviews/api"
import { costUnknown, formatCost } from "@/features/reviews/cost"
import { Stat } from "@/features/reviews/ReviewStatsStrip"
import { useUsage } from "@/features/usage/api"

const detail = "ml-2 text-xs font-normal text-muted-foreground"
const tileSkeleton = <Skeleton className="h-24 w-full rounded-xl" />

// The figures worth coming back to Home for, each linking to the list behind
// it. Every tile loads on its own, so one failing endpoint only blanks its own
// figure.
export function HomeMetrics() {
  const findings = useFindingStats()
  const reviews = useReviewStats()
  const usage = useUsage("30d")

  // The server's default window; only needed before the stats arrive.
  const period = `last ${reviews.data?.days ?? 7} days`
  const open = findings.data?.openBySeverity

  return (
    <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {findings.isPending ? (
        tileSkeleton
      ) : (
        // The severity filter takes one value, so the list is sorted worst first instead.
        <Stat label="Open critical/major" icon={ShieldAlert} to="/findings?state=open&sort=severity&dir=desc" linkLabel="open findings">
          {open ? open.critical + open.major : "-"}
          {open && (
            <span className={detail}>
              {open.critical} critical, {open.major} major
            </span>
          )}
        </Stat>
      )}
      {reviews.isPending ? (
        tileSkeleton
      ) : (
        // The Reviews list has no date filter, so these open the whole list of runs.
        <Stat label={`Reviews, ${period}`} icon={GitPullRequest} to="/reviews?view=runs" linkLabel="open reviews">
          {reviews.data?.runs ?? "-"}
        </Stat>
      )}
      {reviews.isPending ? (
        tileSkeleton
      ) : (
        <Stat label={`Failed, ${period}`} icon={CircleX} to="/reviews?view=runs&status=failed" linkLabel="open failed reviews">
          {reviews.data?.failed ?? "-"}
        </Stat>
      )}
      {usage.isPending ? (
        tileSkeleton
      ) : (
        <Stat label="Spend, last 30 days" icon={Coins} to="/usage?period=30d">
          {usage.data ? formatCost(costUnknown(usage.data.totals) ? null : usage.data.totals.cost.usd) : "-"}
        </Stat>
      )}
    </section>
  )
}
