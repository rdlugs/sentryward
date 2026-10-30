import type { ReactNode } from "react"
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
} from "@dnd-kit/core"
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable"
import { GripVertical } from "lucide-react"

// The card grid shared by connections and repositories. `ids` is the whole
// saved order, so a drop always reports every id, while `children` may render
// only the first `shown` of them (the repository grid grows a page at a time).
export function SortableGrid({
  ids,
  shown = ids.length,
  label,
  onReorder,
  children,
}: {
  ids: string[]
  shown?: number
  label: string
  onReorder: (ids: string[]) => void
  children: ReactNode
}) {
  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so clicking the handle stays a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids.slice(0, shown)} strategy={rectSortingStrategy}>
        <ul aria-label={label} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {children}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

export function DragHandle({
  label,
  handleRef,
  attributes,
  listeners,
}: {
  label: string
  handleRef: (element: HTMLElement | null) => void
  attributes: DraggableAttributes
  listeners: DraggableSyntheticListeners
}) {
  return (
    <button
      ref={handleRef}
      type="button"
      className="-ml-1 flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
      {...attributes}
      {...listeners}
      aria-label={label}
    >
      <GripVertical className="size-4" />
    </button>
  )
}
