import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// Shown when leaving a form would drop its edits. Closing the dialog any other
// way (Escape, the overlay) keeps editing, the safe choice.
export function UnsavedChangesDialog(props: { open: boolean; onKeep: () => void; onDiscard: () => void }) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onKeep()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>Your edits on this page have not been saved and will be lost.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onKeep}>
            Keep editing
          </Button>
          <Button type="button" variant="destructive" onClick={props.onDiscard}>
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
