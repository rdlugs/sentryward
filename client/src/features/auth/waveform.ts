// The field behind the auth brand panel's dithered bars: a ribbon traced by a
// few slow sine waves, plus a fainter echo below it. Coordinates are 0..1 across
// and down the panel, time is in seconds; the result is a brightness in 0..1.

const waves = [
  { amp: 0.08, freq: 0.9, speed: 0.35, phase: 0 },
  { amp: 0.05, freq: 1.7, speed: -0.5, phase: 1.3 },
  { amp: 0.03, freq: 3.1, speed: 0.8, phase: 2.6 },
]

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

export function waveCentre(u: number, t: number) {
  let c = 0.5
  for (const w of waves) c += w.amp * Math.sin(2 * Math.PI * w.freq * u + w.speed * t + w.phase)
  return c
}

function waveThickness(u: number, t: number) {
  return 0.1 + 0.06 * Math.sin(2 * Math.PI * 0.7 * u - 0.6 * t)
}

export function waveLuminance(u: number, v: number, t: number) {
  const centre = waveCentre(u, t)
  // Thin on the left, where the panel's text column is, swelling to the right
  // so the ribbon's weight sits in the free space beside the copy.
  const h = waveThickness(u, t) * (0.6 + 0.6 * u)
  const main = 1 - smoothstep(0, h, Math.abs(v - centre))
  // The echo trails behind the main band in phase, so the two never lock together.
  const echoCentre = waveCentre(u, t - 1.5) + 0.12
  const echo = 0.4 * (1 - smoothstep(0, h * 0.7, Math.abs(v - echoCentre)))
  return Math.max(main, echo)
}
