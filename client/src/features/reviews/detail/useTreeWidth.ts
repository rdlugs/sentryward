import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { TREE_DEFAULT_PX, clampTreeWidth, draggedTreeWidth, maxTreeWidth, readTreeWidth, saveTreeWidth, stepTreeWidth } from "./treeWidth"

/**
 * Width of the review file tree: starts from the saved value, follows a drag or
 * an arrow key, and persists what the user chose. Nothing here depends on the
 * width being visible, so the hook is inert below `lg`.
 */
export function useTreeWidth() {
  const [width, setWidthState] = useState(readTreeWidth)
  const [max, setMax] = useState(() => maxTreeWidth(window.innerWidth))
  // The latest width for event handlers (a drag's end, key steps), kept in
  // step with every change rather than read back from render.
  const widthRef = useRef(width)
  const setWidth = useCallback((next: number) => {
    widthRef.current = next
    setWidthState(next)
  }, [])
  // Ends a drag still in progress, so an unmount mid-drag leaves no listeners behind.
  const endDrag = useRef<(() => void) | null>(null)

  // Saved only on user intent: a drag saves once when it ends rather than on
  // every pointermove, and merely mounting writes nothing.
  const commit = useCallback((next: number) => {
    setWidth(next)
    saveTreeWidth(next)
  }, [setWidth])

  // A viewport that shrinks below the saved maximum must not leave the tree
  // wider than its bound. The clamp is not saved, so the preference returns
  // once the window is wide again.
  useEffect(() => {
    const onResize = () => {
      setMax(maxTreeWidth(window.innerWidth))
      setWidth(clampTreeWidth(widthRef.current, window.innerWidth))
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [setWidth])

  useEffect(() => () => endDrag.current?.(), [])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    endDrag.current?.()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = widthRef.current
    handle.setPointerCapture?.(pointerId)
    const move = (moveEvent: PointerEvent) => setWidth(draggedTreeWidth(startWidth, startX, moveEvent.clientX, window.innerWidth))
    const detach = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", stop)
      handle.removeEventListener("pointercancel", stop)
      handle.removeEventListener("lostpointercapture", stop)
      endDrag.current = null
    }
    // The browser can drop capture on its own (alt-tab, element hidden), which
    // ends the drag just like a pointerup.
    const stop = () => {
      detach()
      handle.releasePointerCapture?.(pointerId)
      saveTreeWidth(widthRef.current)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", stop)
    handle.addEventListener("pointercancel", stop)
    handle.addEventListener("lostpointercapture", stop)
    endDrag.current = detach
  }, [setWidth])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault()
      const direction = event.key === "ArrowLeft" ? -1 : 1
      commit(stepTreeWidth(widthRef.current, direction, window.innerWidth, event.shiftKey))
    } else if (event.key === "Home") {
      event.preventDefault()
      commit(clampTreeWidth(0, window.innerWidth))
    } else if (event.key === "End") {
      event.preventDefault()
      commit(maxTreeWidth(window.innerWidth))
    }
  }, [commit])

  const reset = useCallback(() => commit(TREE_DEFAULT_PX), [commit])

  return { width, max, startDrag, onKeyDown, reset }
}
