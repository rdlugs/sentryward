import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { App } from "@/App"
import { TREE_DEFAULT_PX, TREE_MIN_PX, TREE_STORAGE_KEY } from "@/features/reviews/detail/treeWidth"
import { mockApi } from "@/test/apiRoutes"
import { detail } from "@/test/fixtures"
import { renderWithProviders } from "@/test/renderWithProviders"

vi.mock("@/components/MermaidDiagram", () => ({
  MermaidDiagram: () => <div>Sequence diagram content</div>,
}))

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

async function openReview() {
  mockApi({ [`GET /api/reviews/${detail.id}`]: { review: detail } })
  renderWithProviders(<App />, { route: `/reviews/${detail.id}` })
  return screen.findByRole("separator", { name: "Resize the file tree" })
}

describe("resizable file tree", () => {
  it("exposes an accessible vertical separator and drives the grid column", async () => {
    const handle = await openReview()

    expect(handle).toHaveAttribute("aria-orientation", "vertical")
    expect(handle).toHaveAttribute("aria-valuenow", String(TREE_DEFAULT_PX))
    expect(handle).toHaveAttribute("aria-valuemin", String(TREE_MIN_PX))
    expect(handle).toHaveAttribute("aria-valuemax")
    expect(handle).toHaveAttribute("tabindex", "0")
    expect(document.querySelector<HTMLElement>("[style*='--tree-w']")?.style.getPropertyValue("--tree-w")).toBe(`${TREE_DEFAULT_PX}px`)
  })

  it("resizes with the arrow keys and saves the width", async () => {
    const handle = await openReview()

    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(handle).toHaveAttribute("aria-valuenow", "256")
    expect(localStorage.getItem(TREE_STORAGE_KEY)).toBe("256")
  })

  it("follows a drag and saves once when it ends", async () => {
    const handle = await openReview()
    const setItem = vi.spyOn(Storage.prototype, "setItem")

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 530 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 560 })
    expect(handle).toHaveAttribute("aria-valuenow", "300")
    expect(setItem).not.toHaveBeenCalledWith(TREE_STORAGE_KEY, expect.anything())

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 560 })
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(TREE_STORAGE_KEY)).toBe("300")

    // Released: further moves no longer resize.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 })
    expect(handle).toHaveAttribute("aria-valuenow", "300")
    setItem.mockRestore()
  })

  it("resets to the default width on double-click", async () => {
    localStorage.setItem(TREE_STORAGE_KEY, "400")
    const handle = await openReview()
    expect(handle).toHaveAttribute("aria-valuenow", "400")

    fireEvent.doubleClick(handle)
    expect(handle).toHaveAttribute("aria-valuenow", String(TREE_DEFAULT_PX))
    expect(localStorage.getItem(TREE_STORAGE_KEY)).toBe(String(TREE_DEFAULT_PX))
  })
})
