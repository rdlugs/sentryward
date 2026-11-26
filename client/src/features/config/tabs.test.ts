import { describe, expect, it } from "vitest"
import { NUMBERS } from "./settingsForm"
import { TAB_ERRORS } from "./tabs"

describe("TAB_ERRORS", () => {
  // An invalid number disables save; without a tab to flag it, the user is
  // left hunting for the field across tabs.
  it("gives every validated number field a tab", () => {
    const flagged = new Set(Object.values(TAB_ERRORS).flat())
    expect(NUMBERS.map((spec) => spec.name).filter((name) => !flagged.has(name))).toEqual([])
  })
})
