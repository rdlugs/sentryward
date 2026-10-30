import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { ReviewDemo } from "./ReviewDemo"

// The panel is on screen (wide) and motion is allowed.
function panelVisible() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        matches: media.includes("min-width"),
        media,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

// Small steps, each in its own act, so every timer the component sets after a
// re-render is registered before time moves on.
function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) {
    act(() => {
      vi.advanceTimersByTime(25)
    })
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("ReviewDemo", () => {
  it("shows the first example finished when the panel can't animate", () => {
    render(<ReviewDemo />)

    expect(screen.getByText("src/api/users.ts")).toBeInTheDocument()
    expect(screen.getByText("SQL built from user input")).toBeInTheDocument()
    expect(screen.getByText("critical")).toBeInTheDocument()
    expect(screen.getByText("Suggested change")).toBeInTheDocument()
    expect(screen.getByText("Blocked")).toBeInTheDocument()
  })

  it("plays the review out and moves on to the next example", () => {
    vi.useFakeTimers()
    panelVisible()
    render(<ReviewDemo />)

    expect(screen.getByText("Queued")).toBeInTheDocument()
    expect(screen.queryByText("critical")).not.toBeInTheDocument()

    advance(500)
    expect(screen.getByText("Reviewing…")).toBeInTheDocument()

    advance(1200)
    expect(screen.getByText("critical")).toBeInTheDocument()
    expect(screen.queryByText("Blocked")).not.toBeInTheDocument()

    advance(2200)
    expect(screen.getByText("SQL built from user input")).toBeInTheDocument()
    expect(screen.getByText("Blocked")).toBeInTheDocument()

    advance(3600)
    expect(screen.getByText("src/jobs/sync.ts")).toBeInTheDocument()
  })
})
