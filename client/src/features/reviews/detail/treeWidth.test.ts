import { act, renderHook } from "@testing-library/react"
import type { KeyboardEvent } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  TREE_DEFAULT_PX, TREE_MAX_PX, TREE_MIN_PX, TREE_STORAGE_KEY,
  clampTreeWidth, draggedTreeWidth, maxTreeWidth, readTreeWidth, saveTreeWidth, stepTreeWidth,
} from "./treeWidth"
import { useTreeWidth } from "./useTreeWidth"

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("tree width bounds", () => {
  it("clamps to 12rem and to 40% of a narrow viewport", () => {
    expect(clampTreeWidth(80, 1600)).toBe(TREE_MIN_PX)
    expect(clampTreeWidth(240, 1600)).toBe(240)
    expect(clampTreeWidth(900, 1600)).toBe(TREE_MAX_PX)
    expect(maxTreeWidth(800)).toBe(320)
    expect(clampTreeWidth(900, 800)).toBe(320)
  })

  it("falls back to the default for unusable values", () => {
    expect(clampTreeWidth(Number.NaN, 1200)).toBe(TREE_DEFAULT_PX)
    expect(maxTreeWidth(Number.NaN)).toBe(TREE_MAX_PX)
  })

  it("never inverts the bounds on a tiny viewport", () => {
    expect(maxTreeWidth(300)).toBe(TREE_MIN_PX)
    expect(clampTreeWidth(500, 300)).toBe(TREE_MIN_PX)
  })
})

describe("dragging and keys", () => {
  it("applies the pointer delta and clamps it", () => {
    expect(draggedTreeWidth(240, 500, 560, 1600)).toBe(300)
    expect(draggedTreeWidth(240, 500, 100, 1600)).toBe(TREE_MIN_PX)
    expect(draggedTreeWidth(240, 500, 1400, 1600)).toBe(TREE_MAX_PX)
  })

  it("steps by 16px, or 64px with the large step", () => {
    expect(stepTreeWidth(240, 1, 1600)).toBe(256)
    expect(stepTreeWidth(240, -1, 1600)).toBe(224)
    expect(stepTreeWidth(240, 1, 1600, true)).toBe(304)
    expect(stepTreeWidth(TREE_MIN_PX, -1, 1600)).toBe(TREE_MIN_PX)
  })
})

describe("persistence", () => {
  it("round-trips and reads a stale value clamped to the current window", () => {
    saveTreeWidth(340)
    expect(localStorage.getItem(TREE_STORAGE_KEY)).toBe("340")
    expect(readTreeWidth()).toBe(340)

    saveTreeWidth(5000)
    expect(readTreeWidth()).toBe(maxTreeWidth(window.innerWidth))
  })

  it("falls back to the default on garbage", () => {
    localStorage.setItem(TREE_STORAGE_KEY, "wide")
    expect(readTreeWidth()).toBe(TREE_DEFAULT_PX)
  })
})

describe("useTreeWidth", () => {
  const key = (k: string) => ({ key: k, preventDefault() {} }) as KeyboardEvent<HTMLElement>

  it("starts from the saved width and persists only what the user chose", () => {
    saveTreeWidth(300)
    const { result } = renderHook(() => useTreeWidth())

    expect(result.current.width).toBe(300)
    act(() => result.current.onKeyDown(key("ArrowLeft")))
    expect(result.current.width).toBe(284)
    expect(localStorage.getItem(TREE_STORAGE_KEY)).toBe("284")

    act(() => result.current.reset())
    expect(result.current.width).toBe(TREE_DEFAULT_PX)
    expect(localStorage.getItem(TREE_STORAGE_KEY)).toBe(String(TREE_DEFAULT_PX))
  })

  it("writes nothing just by mounting", () => {
    const { result } = renderHook(() => useTreeWidth())
    expect(result.current.width).toBe(TREE_DEFAULT_PX)
    expect(localStorage.getItem(TREE_STORAGE_KEY)).toBeNull()
  })

  it("handles Home and End", () => {
    const { result } = renderHook(() => useTreeWidth())
    act(() => result.current.onKeyDown(key("End")))
    expect(result.current.width).toBe(maxTreeWidth(window.innerWidth))
    act(() => result.current.onKeyDown(key("Home")))
    expect(result.current.width).toBe(TREE_MIN_PX)
  })

  it("clamps to a narrower window without overwriting the saved preference", () => {
    const original = window.innerWidth
    try {
      saveTreeWidth(480)
      window.innerWidth = 1600
      const { result } = renderHook(() => useTreeWidth())
      expect(result.current.width).toBe(480)
      expect(result.current.max).toBe(TREE_MAX_PX)

      act(() => {
        window.innerWidth = 800
        window.dispatchEvent(new Event("resize"))
      })
      expect(result.current.width).toBe(320)
      expect(result.current.max).toBe(320)
      expect(localStorage.getItem(TREE_STORAGE_KEY)).toBe("480")
    } finally {
      window.innerWidth = original
    }
  })
})
