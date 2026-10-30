import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useIsBelowSm, useIsMobile } from "./use-mobile"

function stubMatchMedia(initial: boolean) {
  const state = { matches: initial }
  const listeners = new Set<() => void>()
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        get matches() {
          return state.matches
        },
        media,
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) =>
          listeners.delete(cb),
      }) as unknown as MediaQueryList,
  )
  return {
    listeners,
    set(matches: boolean) {
      state.matches = matches
      listeners.forEach((cb) => cb())
    },
  }
}

describe("useIsMobile", () => {
  it("returns the media query value on the first render", () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it("updates when the media query changes", () => {
    const mql = stubMatchMedia(false)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)

    act(() => mql.set(true))
    expect(result.current).toBe(true)

    act(() => mql.set(false))
    expect(result.current).toBe(false)
  })

  it("unsubscribes on unmount", () => {
    const mql = stubMatchMedia(false)
    const { unmount } = renderHook(() => useIsMobile())
    expect(mql.listeners.size).toBe(1)
    unmount()
    expect(mql.listeners.size).toBe(0)
  })
})

describe("useIsBelowSm", () => {
  it("follows the sm breakpoint query", () => {
    const mql = stubMatchMedia(false)
    const { result } = renderHook(() => useIsBelowSm())
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 639px)")
    expect(result.current).toBe(false)

    act(() => mql.set(true))
    expect(result.current).toBe(true)
  })
})
