import { describe, expect, it } from "vitest"
import { scorePassword } from "./passwordScore"

describe("scorePassword", () => {
  it.each([
    ["", 0],
    ["abc", 1],
    ["abcdefgh", 2],
    ["abcdefghijkl", 3],
    ["Abcdefgh1", 3],
    ["Abcdefghijk1", 4],
  ])("scores %j as %i", (password, score) => {
    expect(scorePassword(password)).toBe(score)
  })
})
