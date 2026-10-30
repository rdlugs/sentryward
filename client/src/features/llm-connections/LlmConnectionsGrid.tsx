import { useState } from "react"
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useApiKeys, type ApiKey, type LlmProvider } from "./api"
import { DetailsSheet } from "./DetailsSheet"
import { KeySheet } from "./KeySheet"
import { ProviderCard } from "./ProviderCard"
import { RemoveKeyDialog } from "./RemoveKeyDialog"

// Every provider gets a card, connected or not: there are only a few, and a
// missing one is as useful to see as a broken one.
export function LlmConnectionsGrid() {
  const { data, isPending, error, refetch, isRefetching } = useApiKeys()
  // Kept after the sheet closes so its closing animation still shows the same
  // provider (a save flips it from "Connect" to stored); replaced on the next
  // open, which remounts the sheet by key.
  const [editing, setEditing] = useState<ApiKey | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  // By provider, so the sheet follows a key that is replaced while it is open.
  const [inspecting, setInspecting] = useState<LlmProvider | null>(null)
  const [removing, setRemoving] = useState<ApiKey | null>(null)

  if (isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-44 rounded-xl" />
        ))}
      </div>
    )
  }

  if (error || !data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Could not load your connections.</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isRefetching}>
            Try again
          </Button>
        </AlertAction>
      </Alert>
    )
  }

  function openKeySheet(key: ApiKey) {
    setEditing(key)
    setSheetOpen(true)
  }

  const inspected = data.keys.find((key) => key.provider === inspecting && key.stored) ?? null

  return (
    <div className="flex flex-col gap-4">
      {!data.keys.some((key) => key.stored) && (
        <p className="text-sm text-muted-foreground">
          Add a provider credential to review with your own account or API host. Only verified connections are used.
        </p>
      )}
      <ul className="grid gap-4 sm:grid-cols-2" aria-label="LLM providers">
        {data.keys.map((key) => (
          <ProviderCard
            key={key.provider}
            apiKey={key}
            onDetails={() => setInspecting(key.provider)}
            onConnect={() => openKeySheet(key)}
            onRemove={() => setRemoving(key)}
          />
        ))}
      </ul>
      <KeySheet key={editing?.provider ?? "none"} credential={editing} open={sheetOpen} onOpenChange={setSheetOpen} />
      <DetailsSheet apiKey={inspected} onOpenChange={(open) => !open && setInspecting(null)} />
      <RemoveKeyDialog apiKey={removing} onOpenChange={(open) => !open && setRemoving(null)} />
    </div>
  )
}
