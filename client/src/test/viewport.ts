import { vi } from "vitest"

// Answers `(max-width: Npx)` queries as a viewport `width` px wide would, so
// components switch to their phone layouts. setup.ts restores matchMedia after
// each test.
export function setViewportWidth(width: number) {
  vi.spyOn(window, "matchMedia").mockImplementation((media: string) => {
    const max = /max-width:\s*(\d+)px/.exec(media)
    return {
      matches: max ? width <= Number(max[1]) : false,
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList
  })
}
