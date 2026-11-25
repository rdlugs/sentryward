// Width of the file-tree column on the review page. Kept as plain functions so
// the bounds and persistence can be tested without a DOM event.

export const TREE_MIN_PX = 192 // 12rem: still fits a nested path
export const TREE_MAX_PX = 512 // 32rem
export const TREE_DEFAULT_PX = 240 // 15rem, the previous fixed column
export const TREE_STEP_PX = 16
export const TREE_STORAGE_KEY = "sentryward.reviewTreeWidth"

/** The widest the tree may get: 32rem, or 40% of the viewport when narrower. */
export function maxTreeWidth(viewportWidth: number): number {
  const limit = Number.isFinite(viewportWidth) && viewportWidth > 0 ? Math.round(viewportWidth * 0.4) : TREE_MAX_PX
  return Math.max(TREE_MIN_PX, Math.min(TREE_MAX_PX, limit))
}

/** Clamp a width to the tree's bounds; anything unusable falls back to the default. */
export function clampTreeWidth(value: number, viewportWidth: number): number {
  if (!Number.isFinite(value)) return TREE_DEFAULT_PX
  return Math.min(Math.max(Math.round(value), TREE_MIN_PX), maxTreeWidth(viewportWidth))
}

/** The width a drag from `startX` to `currentX` would produce. */
export function draggedTreeWidth(startWidth: number, startX: number, currentX: number, viewportWidth: number): number {
  return clampTreeWidth(startWidth + (currentX - startX), viewportWidth)
}

export function stepTreeWidth(width: number, direction: -1 | 1, viewportWidth: number, large = false): number {
  return clampTreeWidth(width + direction * (large ? TREE_STEP_PX * 4 : TREE_STEP_PX), viewportWidth)
}

export function readTreeWidth(): number {
  try {
    const raw = localStorage.getItem(TREE_STORAGE_KEY)
    if (raw === null) return TREE_DEFAULT_PX
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampTreeWidth(parsed, window.innerWidth) : TREE_DEFAULT_PX
  } catch {
    return TREE_DEFAULT_PX
  }
}

export function saveTreeWidth(width: number): void {
  try {
    localStorage.setItem(TREE_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // A blocked storage still keeps the width for this page.
  }
}
