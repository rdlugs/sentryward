import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { saveBarClass } from "./saveBarClass"

// The settings forms are long, so while there are unsaved edits the save bar
// pins to the bottom of the viewport and Save is reachable from any field.
export function SaveBar(props: { dirty: boolean; onDiscard: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <div className={saveBarClass(props.dirty)}>
      {props.children}
      {props.dirty && (
        <>
          <Button type="button" variant="ghost" onClick={props.onDiscard} disabled={props.disabled}>
            Discard
          </Button>
          <span className="text-sm text-muted-foreground">Unsaved changes</span>
        </>
      )}
    </div>
  )
}
