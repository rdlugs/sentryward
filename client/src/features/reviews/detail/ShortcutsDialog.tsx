import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

// Each entry is a list of alternative combos; each combo is the keys pressed together.
const SHORTCUTS: { combos: string[][]; label: string }[] = [
  { combos: [["Ctrl", "J"]], label: "Next finding" },
  { combos: [["Ctrl", "K"]], label: "Previous finding" },
  { combos: [["Ctrl", "O"], ["Enter"]], label: "Expand or collapse the focused finding" },
  { combos: [["Ctrl", "C"]], label: "Copy the agent prompt for the focused finding" },
  { combos: [["Ctrl", "?"]], label: "Show these shortcuts" },
]

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts are off while typing in a field. Ctrl+C copies selected text when there is a selection.
          </DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-2 text-sm">
          {SHORTCUTS.map(({ combos, label }) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <dt>{label}</dt>
              <dd className="flex shrink-0 items-center gap-1.5">
                {combos.map((keys, i) => (
                  <span key={keys.join("+")} className="flex items-center gap-1">
                    {i > 0 && <span className="text-xs text-muted-foreground">or</span>}
                    {keys.map((key) => (
                      <kbd key={key} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {key}
                      </kbd>
                    ))}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
