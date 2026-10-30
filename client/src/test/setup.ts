import "@testing-library/jest-dom/vitest"
import { afterEach, vi } from "vitest"
import { cleanup, configure } from "@testing-library/react"

// Pages are lazy (App.tsx); the first render of a route waits while vitest
// transforms that page's module, which can outlast the 1s default.
configure({ asyncUtilTimeout: 3000 })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // The selected workspace is remembered there; each test starts fresh.
  localStorage.clear()
})

// jsdom lacks matchMedia, used by the shadcn sidebar's mobile hook
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
})

// jsdom lacks the pointer capture and scrolling APIs Radix Select calls when it
// opens, and that sonner calls when a toast's button is pressed
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

// jsdom lacks ResizeObserver, which cmdk (SearchableSelect) uses to size its list
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
