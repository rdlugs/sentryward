import { AlertTriangle, Loader2 } from "lucide-react"
import { useSearchParams } from "react-router"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { useUsage } from "@/features/usage/api"
import { BreakdownChart } from "@/features/usage/BreakdownChart"
import { OverviewCards } from "@/features/usage/OverviewCards"
import { RECENT_PAGINATION, RecentReviews } from "@/features/usage/RecentReviews"
import { Segmented } from "@/features/usage/Segmented"
import { USAGE_PERIODS, type UsagePeriod } from "@/features/usage/types"
import { UsageChart } from "@/features/usage/UsageChart"
import { USAGE_PAGINATION, UsageTable } from "@/features/usage/UsageTable"
import { resetPages } from "@/hooks/use-pagination"

const PERIOD_OPTIONS: { value: UsagePeriod; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "all", label: "All" },
]

export function UsagePage() {
  const [params, setParams] = useSearchParams()
  const requested = params.get("period")
  const period = USAGE_PERIODS.includes(requested as UsagePeriod) ? (requested as UsagePeriod) : "7d"
  const { data, isPending, isError, isPlaceholderData } = useUsage(period)

  function onPeriod(next: UsagePeriod) {
    setParams((current) => {
      const updated = new URLSearchParams(current)
      updated.set("period", next)
      // Another period lists other rows, so both lists start over at page 1.
      resetPages(updated, [RECENT_PAGINATION, USAGE_PAGINATION])
      return updated
    })
  }

  return (
    <PageShell>
      <PageHeader
        title="Usage"
        description="Model calls, tokens and estimated cost of reviews in this workspace."
        actions={
          <div className="flex items-center gap-2">
            {isPlaceholderData && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />}
            <Segmented label="Period" options={PERIOD_OPTIONS} value={period} onChange={onPeriod} />
          </div>
        }
      />
      {isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load usage.</AlertTitle>
        </Alert>
      ) : (
        <>
          <OverviewCards totals={data.totals} />
          <UsageChart report={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownChart
              title="By provider"
              layout="columns"
              empty="No provider usage yet"
              rows={data.byProvider.map((row) => ({ name: row.provider, tokens: row.tokens, calls: row.calls }))}
            />
            <BreakdownChart
              title="Top models"
              layout="rows"
              empty="No model usage yet"
              limit={5}
              rows={data.byModel.map((row) => ({
                name: row.model,
                tokens: row.inputTokens + row.outputTokens,
                calls: row.calls,
              }))}
            />
          </div>
          <RecentReviews period={period} />
          <UsageTable report={data} />
        </>
      )}
    </PageShell>
  )
}
