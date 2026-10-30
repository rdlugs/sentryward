import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { waveLuminance } from "./waveform"
import { usePanelMotion } from "./usePanelMotion"

const CELL = 14 // CSS px per grid cell
const LEVELS = 8 // bar widths above "no bar", as in the reference dither
const FRAME_MS = 1000 / 30

// Dithered waveform for the auth brand panel: each grid cell draws a vertical
// bar whose width follows the field's brightness, so the moving ribbon reads as
// an equalizer. Canvas 2D is enough for a flat field, so no WebGL.
// It is drawn in the brand blue (matching the panel's glow) and masked out
// under the text column on the left, so it never competes with the copy.
export function WaveformBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { wide, reduced } = usePanelMotion()
  // The bar colour is read from the theme when drawing starts, so a theme
  // switch restarts it to pick up the other theme's blue.
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    const canvas = canvasRef.current
    // Below `lg` the panel is hidden, so there is nothing to draw.
    if (!canvas || !wide) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    let frame = 0
    let cols = 0
    let rows = 0
    let colour = ""

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const { width, height } = canvas.getBoundingClientRect()
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      cols = Math.ceil(width / CELL)
      rows = Math.ceil(height / CELL)
      colour = getComputedStyle(canvas).color
    }

    const draw = (seconds: number) => {
      ctx.clearRect(0, 0, cols * CELL, rows * CELL)
      ctx.fillStyle = colour
      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols
        for (let y = 0; y < rows; y++) {
          const level = Math.min(Math.floor(waveLuminance(u, (y + 0.5) / rows, seconds) * (LEVELS + 1)), LEVELS)
          if (level === 0) continue
          const w = (level / LEVELS) * CELL * 0.8
          ctx.fillRect(x * CELL + (CELL - w) / 2, y * CELL, w, CELL - 1)
        }
      }
    }

    const observer = new ResizeObserver(() => {
      resize()
      draw(reduced ? 0 : performance.now() / 1000)
    })
    observer.observe(canvas)
    resize()

    if (reduced) {
      draw(0)
    } else {
      let last = 0
      const tick = (now: number) => {
        frame = requestAnimationFrame(tick)
        if (now - last < FRAME_MS) return
        last = now
        draw(now / 1000)
      }
      frame = requestAnimationFrame(tick)
    }
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [wide, reduced, resolvedTheme])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full text-chart-1 opacity-40 [mask-composite:intersect] [mask-image:linear-gradient(to_right,transparent_25%,#000_70%),linear-gradient(to_bottom,transparent,#000_30%,#000_85%,transparent)]"
    />
  )
}
