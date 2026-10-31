const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
]

const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

export function timeAgo(iso: string, now = Date.now()) {
  const diff = new Date(iso).getTime() - now
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return format.format(Math.round(diff / ms), unit)
  }
  return "just now"
}

// A calendar date in the viewer's locale, e.g. "Oct 31, 2026".
export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" })
}

// Short elapsed time, e.g. "42s", "3m 05s", "1h 02m", "2d 04h".
export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`
}
