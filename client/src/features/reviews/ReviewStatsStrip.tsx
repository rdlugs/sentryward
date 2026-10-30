import type { ReactNode } from "react"
import { Link } from "react-router"
import { CircleX, Coins, GitPullRequest, ShieldX, Timer, type LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDuration } from "@/lib/time"
import { USAGE_PERIODS, type UsagePeriod } from "@/features/usage/types"
import { useReviewStats } from "./api"
import { costUnknown, formatCost, formatTokens } from "./cost"

// With `to`, the whole tile links to the page that breaks the figure down;
// `linkLabel` names that page for screen readers.
export function Stat({
  label,
  icon: Icon,
  to,
  linkLabel = "open usage",
  children,
}: {
  label: string
  icon?: LucideIcon
  to?: string
  linkLabel?: string
  children: ReactNode
}) {
  const card = (
    <Card size="sm" className={to ? "h-full transition-colors hover:bg-muted/50" : undefined}>
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
          {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
        </div>
        <div className="text-2xl font-semibold tabular-nums">{children}</div>
      </CardContent>
    </Card>
  )
  return to ? (
    <Link to={to} aria-label={`${label}: ${linkLabel}`} className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      {card}
    </Link>
  ) : (
    card
  )
}

// A glance at the last few days; stays out of the way if it cannot load.
export function ReviewStatsStrip() {
  const { data, isPending, isError } = useReviewStats()
  if (isError) return null
  if (isPending) return <Skeleton className="h-24 w-full" />

  const finished = data.blocked + data.passed
  const blockedRate = finished ? Math.round((data.blocked / finished) * 100) : 0
  const period = `last ${data.days} days`
  const { median, max } = data.duration
  const { tokens, cost } = data
  // The Usage page opens on the same window when it offers one.
  const usagePeriod = `${data.days}d`
  const usageLink = USAGE_PERIODS.includes(usagePeriod as UsagePeriod) ? `/usage?period=${usagePeriod}` : "/usage"

  return (
    <section aria-label="Review stats" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <Stat label={`Reviews, ${period}`} icon={GitPullRequest}>
        {data.runs}
      </Stat>
      <Stat label="Blocked" icon={ShieldX}>
        {finished ? `${blockedRate}%` : "-"}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {data.blocked} of {finished}
        </span>
      </Stat>
      <Stat label="Failed" icon={CircleX}>
        {data.failed}
      </Stat>
      <Stat label="Median review time" icon={Timer}>
        {median === null ? "-" : formatDuration(median)}
        {max !== null && (
          <span className="ml-2 text-xs font-normal text-muted-foreground">slowest {formatDuration(max)}</span>
        )}
      </Stat>
      <Stat label={`Tokens, ${period}`} icon={Coins} to={usageLink}>
        {formatTokens(tokens.inputTokens + tokens.outputTokens)}
        <span className="ml-2 text-xs font-normal text-muted-foreground">{formatCost(costUnknown(tokens) ? null : cost.usd)}</span>
      </Stat>
    </section>
  )
}
