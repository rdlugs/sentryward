import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useDeleteApiKey, type ApiKey } from "./api"
import { LLM_PROVIDERS } from "./providers"

// Rendered once beside the grid rather than inside a card's menu, which
// unmounts its items (and any dialog in them) as soon as it closes.
export function RemoveKeyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKey | null
  onOpenChange: (open: boolean) => void
}) {
  const remove = useDeleteApiKey()
  const label = apiKey ? LLM_PROVIDERS[apiKey.provider].label : ""

  async function onRemove() {
    if (!apiKey) return
    try {
      await remove.mutateAsync(apiKey.provider)
      onOpenChange(false)
      toast.success(`${label} key removed`)
    } catch {
      toast.error("Could not remove the key")
    }
  }

  return (
    <Dialog open={apiKey !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {apiKey && (
          <>
            <DialogHeader>
              <DialogTitle>Remove {label} connection?</DialogTitle>
              <DialogDescription>
                The stored key and API host are deleted. You can add a new {label} connection at any time.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button variant="destructive" onClick={onRemove} disabled={remove.isPending}>
                {remove.isPending && <Loader2 className="animate-spin" />}
                Remove connection
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
