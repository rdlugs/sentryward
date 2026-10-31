import { useSearchParams } from "react-router"
import { CircleDollarSign, KeyRound } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useApiKeys, useApiKeyStatuses } from "@/features/llm-connections/api"
import { isCheckable, summarize } from "@/features/llm-connections/health"
import { LlmConnectionsGrid } from "@/features/llm-connections/LlmConnectionsGrid"
import { ModelPricesCard } from "@/features/model-prices/ModelPricesCard"

const TAB_ITEMS = [
  { value: "connections", label: "Connections", icon: KeyRound },
  { value: "prices", label: "Model prices", icon: CircleDollarSign },
] as const
type Tab = (typeof TAB_ITEMS)[number]["value"]
const TABS: readonly string[] = TAB_ITEMS.map((item) => item.value)

const EMPTY: never[] = []

// Reads the cards' status checks from the cache without starting any, like
// the sidebar's warning dot, so the header and the cards always agree.
function useHealthSummary() {
  const keys = useApiKeys().data?.keys ?? EMPTY
  const statuses = useApiKeyStatuses(keys.filter(isCheckable), { live: false })
  if (!keys.length) return null
  const { connected, total, attention } = summarize(keys, statuses)
  const summary = `${connected} of ${total} providers connected`
  return attention ? `${summary} · ${attention} ${attention === 1 ? "needs" : "need"} attention` : summary
}

export function LlmConnectionsPage() {
  const summary = useHealthSummary()

  // ?tab= keeps the open tab linkable, e.g. /llm-connections?tab=prices.
  const [params, setParams] = useSearchParams()
  const requested = params.get("tab")
  const tab = requested && TABS.includes(requested) ? (requested as Tab) : "connections"

  return (
    <PageShell>
      <PageHeader
        title="LLM Connections"
        description={summary ?? "Provider credentials, custom API hosts and model prices that reviews run with."}
      />
      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList>
          {TAB_ITEMS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              <item.icon />
              <span>{item.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="connections">
          <LlmConnectionsGrid />
        </TabsContent>
        <TabsContent value="prices">
          <ModelPricesCard />
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
