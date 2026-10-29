import { useMemo, useState } from "react"
import { useSearchParams } from "react-router"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { selectedLabel } from "@/lib/filters"
import { useRepos } from "@/features/forge/api"
import type { FindingQuery } from "@/features/findings/api"
import { FindingDetailsSheet } from "@/features/findings/FindingDetailsSheet"
import { ConfidenceCalibration } from "@/features/findings/ConfidenceCalibration"
import { FalsePositiveBreakdown } from "@/features/findings/FalsePositiveBreakdown"
import { FindingList } from "@/features/findings/FindingList"
import { FindingStatsStrip } from "@/features/findings/FindingStatsStrip"
import { useFindingFilters } from "@/features/findings/useFindingFilters"
import type { FindingRow } from "@/features/findings/types"

type Tab = "findings" | "false-positives"
const TABS: readonly string[] = ["findings", "false-positives"] satisfies Tab[]

const FALSE_POSITIVES: Partial<FindingQuery> = { state: "ignored", ignoreReason: "false_positive" }

export function FindingsPage() {
  // ?tab= keeps the open tab linkable, e.g. /findings?tab=false-positives.
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get("tab")
  const tab = requested && TABS.includes(requested) ? (requested as Tab) : "findings"
  const [opened, setOpened] = useState<FindingRow | null>(null)

  const repos = useRepos()
  const repoOptions = useMemo(
    () =>
      (repos.data?.repos ?? [])
        .map((r) => ({ value: r.id, label: r.fullPath }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [repos.data],
  )

  const findings = useFindingFilters(repoOptions)
  // Its own paging params, so a page on one tab never carries over to the other.
  const falsePositives = useFindingFilters(repoOptions, "fp")

  return (
    <PageShell>
      <PageHeader
        title="Findings"
        description="Issues raised across your reviews, tracked until they are resolved or ignored."
      />
      {/* The cards sit above the tabs, so both share them. Each tab has its own
          filters, held here rather than in the tabs so they survive switching. */}
      <FindingStatsStrip />
      {/* Keeps the other params: each tab's filters live there too. */}
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setSearchParams(
            (current) => {
              const updated = new URLSearchParams(current)
              updated.set("tab", value)
              return updated
            },
            { replace: true },
          )
        }
      >
        <TabsList>
          <TabsTrigger value="findings">Findings</TabsTrigger>
          <TabsTrigger value="false-positives">False positives</TabsTrigger>
        </TabsList>
        <TabsContent value="findings" className="flex flex-col gap-6 compact:gap-4 spacious:gap-8">
          <FindingList
            filters={findings}
            repoOptions={repoOptions}
            id="finding"
            showState
            searchLabel="Search findings"
            emptyMessage={{
              none: "No findings yet. Findings from your reviews will show up here.",
              noMatch: "No findings match your filters.",
            }}
            onOpen={setOpened}
          />
        </TabsContent>
        <TabsContent value="false-positives" className="flex flex-col gap-6 compact:gap-4 spacious:gap-8">
          {/* The list leads, so its toolbar tops the tab: the repository filter
              there scopes the breakdown below as well. */}
          <FindingList
            filters={falsePositives}
            repoOptions={repoOptions}
            id="false-positive"
            scope={FALSE_POSITIVES}
            searchLabel="Search false positives"
            emptyMessage={{
              none: "No false positives yet. Findings you dismiss as false positives will show up here.",
              noMatch: "No false positives match your filters.",
            }}
            onOpen={setOpened}
          />
          <FalsePositiveBreakdown
            repoId={falsePositives.params.repoId}
            repoName={selectedLabel(falsePositives.values.repo, repoOptions)}
          />
          <ConfidenceCalibration
            repoId={falsePositives.params.repoId}
            repoName={selectedLabel(falsePositives.values.repo, repoOptions)}
          />
        </TabsContent>
      </Tabs>
      <FindingDetailsSheet row={opened} onOpenChange={(open) => !open && setOpened(null)} />
    </PageShell>
  )
}
