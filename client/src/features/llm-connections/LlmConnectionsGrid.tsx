import { useState } from "react"
import { toast } from "sonner"
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useAuth } from "@/features/auth/useAuth"
import { SortableGrid } from "@/features/forge/SortableGrid"
import { useApiKeys, useReorderApiKeys, type ApiKey, type LlmProvider } from "./api"
import { DetailsSheet } from "./DetailsSheet"
import { KeySheet } from "./KeySheet"
import { ProviderCard } from "./ProviderCard"
import { RemoveKeyDialog } from "./RemoveKeyDialog"

// Every provider gets a card, connected or not: there are only a few, and a
// missing one is as useful to see as a broken one.
export function LlmConnectionsGrid() {
  const { data, isPending, refetch, isRefetching } = useApiKeys()
  const reorder = useReorderApiKeys()
  // The order is the workspace's, so only those who manage it can change it.
  // There is always a card per provider and nothing filters them.
  const { workspace } = useAuth()
  const reorderable = workspace?.role === "owner" || workspace?.role === "admin"
  // Each overlay's subject is kept after it closes so the closing animation
  // still shows the same content (a save flips the key sheet from "Connect"
  // to stored); only the open flag clears. The key sheet's is replaced on the
  // next open, which remounts it by key.
  const [editing, setEditing] = useState<ApiKey | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  // By provider, so the sheet follows a key that is replaced while it is open.
  const [inspecting, setInspecting] = useState<LlmProvider | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [removing, setRemoving] = useState<ApiKey | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)

  const inspected = data?.keys.find((key) => key.provider === inspecting) ?? null
  // A key removed while its details are open (say from another tab) closes
  // them for good, rather than leaving them to reopen once it is reconnected.
  if (detailsOpen && data && !inspected?.stored) setDetailsOpen(false)

  if (isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-48 rounded-xl" />
        ))}
      </div>
    )
  }

  // Only when there is nothing to show: a failed background refetch keeps the
  // last list, and the overlays open on it.
  if (!data) {
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

  function openDetails(key: ApiKey) {
    setInspecting(key.provider)
    setDetailsOpen(true)
  }

  function openRemove(key: ApiKey) {
    setRemoving(key)
    setRemoveOpen(true)
  }

  function onReorder(providers: string[]) {
    reorder.mutate(providers as LlmProvider[], {
      onError: () => toast.error("Could not save the new order"),
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {!data.keys.some((key) => key.stored) && (
        <p className="text-sm text-muted-foreground">
          Add a provider credential to review with your own account or API host. Only verified connections are used.
        </p>
      )}
      {reorderable && <p className="text-sm text-muted-foreground">Drag cards by their handle to reorder them.</p>}
      <SortableGrid ids={data.keys.map((key) => key.provider)} label="LLM providers" onReorder={onReorder}>
        {data.keys.map((key) => (
          <ProviderCard
            key={key.provider}
            apiKey={key}
            reorderable={reorderable}
            onDetails={() => openDetails(key)}
            onConnect={() => openKeySheet(key)}
            onRemove={() => openRemove(key)}
          />
        ))}
      </SortableGrid>
      <KeySheet key={editing?.provider ?? "none"} credential={editing} open={sheetOpen} onOpenChange={setSheetOpen} />
      <DetailsSheet apiKey={inspected} open={detailsOpen} onOpenChange={setDetailsOpen} />
      <RemoveKeyDialog apiKey={removing} open={removeOpen} onOpenChange={setRemoveOpen} />
    </div>
  )
}
