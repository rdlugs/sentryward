import { describe, expect, it } from "vitest"
import { plural } from "./plural"

describe("plural", () => {
  it("uses the singular for one", () => {
    expect(plural(1, "day")).toBe("1 day")
  })

  it("uses the plural for zero and many", () => {
    expect(plural(0, "day")).toBe("0 days")
    expect(plural(30, "day")).toBe("30 days")
  })

  it("takes an irregular plural", () => {
    expect(plural(1, "repository", "repositories")).toBe("1 repository")
    expect(plural(2, "repository", "repositories")).toBe("2 repositories")
  })
})
