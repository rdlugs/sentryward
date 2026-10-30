import { describe, expect, it } from "vitest"
import { waveCentre, waveLuminance } from "./waveform"

describe("waveLuminance", () => {
  it("stays within 0..1", () => {
    for (let u = 0; u <= 1; u += 0.1) {
      for (let v = 0; v <= 1; v += 0.05) {
        const lum = waveLuminance(u, v, 12.3)
        expect(lum).toBeGreaterThanOrEqual(0)
        expect(lum).toBeLessThanOrEqual(1)
      }
    }
  })

  it("is brightest on the centre line and dark at the panel's edges", () => {
    expect(waveLuminance(0.3, waveCentre(0.3, 4), 4)).toBeCloseTo(1)
    expect(waveLuminance(0.3, 0, 4)).toBe(0)
    expect(waveLuminance(0.3, 1, 4)).toBe(0)
  })

  it("is fuller on the right, beside the text column, than on the left", () => {
    const nearCentre = (u: number) => {
      let total = 0
      for (let t = 0; t < 20; t += 0.5) total += waveLuminance(u, waveCentre(u, t) - 0.06, t)
      return total
    }
    expect(nearCentre(0.9)).toBeGreaterThan(nearCentre(0.1))
  })

  it("moves over time", () => {
    expect(waveCentre(0.5, 0)).not.toBeCloseTo(waveCentre(0.5, 3))
  })
})
