import { useMemo } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { useSearchParams } from "react-router"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useBenchmarks } from "@/features/benchmarks/api"
import { BenchmarkCards } from "@/features/benchmarks/BenchmarkCards"
import {
  BEST_PAGINATION,
  BreakdownTable,
  MODELS_PAGINATION,
  ModelTable,
  REPOS_PAGINATION,
  RepositoryTable,
} from "@/features/benchmarks/BenchmarkTables"
import { useRepos } from "@/features/forge/api"
import { Segmented } from "@/features/usage/Segmented"
import { USAGE_PERIODS, type UsagePeriod } from "@/features/usage/types"
import { paginationKeys } from "@/hooks/use-pagination"
import { ALL } from "@/lib/filters"

const PERIOD_OPTIONS: { value: UsagePeriod; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "all", label: "All" },
]

export function BenchmarksPage() {
  const [params, setParams] = useSearchParams()
  const requested = params.get("period")
  // Findings need time to be resolved or dismissed, so a month is the default.
  const period = USAGE_PERIODS.includes(requested as UsagePeriod) ? (requested as UsagePeriod) : "30d"
  const repoId = params.get("repo") ?? undefined
  const { data, isPending, isError, isPlaceholderData } = useBenchmarks(period, repoId)

  const repos = useRepos()
  const repoOptions = useMemo(
    () => (repos.data?.repos ?? []).map((r) => ({ value: r.id, label: r.fullPath })).sort((a, b) => a.label.localeCompare(b.label)),
    [repos.data],
  )

  function update(key: "period" | "repo", value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current)
      if (key === "repo" && value === ALL) next.delete("repo")
      else next.set(key, value)
      // Another period or repository is other rows, so every table starts over at page 1.
      for (const prefix of [MODELS_PAGINATION, BEST_PAGINATION, REPOS_PAGINATION]) next.delete(paginationKeys(prefix).page)
      return next
    })
  }

  return (
    <PageShell>
      <PageHeader
        title="Benchmarks"
        description="Compare models on cost, speed and how their findings turned out."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isPlaceholderData && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />}
            <Select value={repoId ?? ALL} onValueChange={(value) => update("repo", value)}>
              <SelectTrigger aria-label="Repository" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All repositories</SelectItem>
                {repoOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Segmented label="Period" options={PERIOD_OPTIONS} value={period} onChange={(value) => update("period", value)} />
          </div>
        }
      />
      {isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load benchmarks.</AlertTitle>
        </Alert>
      ) : (
        <>
          <BenchmarkCards totals={data.totals} />
          <ModelTable report={data} />
          <BreakdownTable report={data} />
          <RepositoryTable report={data} />
        </>
      )}
    </PageShell>
  )
}
