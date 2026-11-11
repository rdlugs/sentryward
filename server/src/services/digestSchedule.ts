import type { NotificationDeliveryMode } from "../generated/prisma/client.ts";

// Digest times are wall-clock hours in a target's own timezone, so a team in
// Berlin and one in Manila can both get theirs at 9:00. Worked out with Intl
// rather than a date library: only "the next hour:00 on these days" is needed.

let zones: Set<string> | null = null;

export function isValidTimeZone(timeZone: string): boolean {
  zones ??= new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  if (zones.has(timeZone)) return true;
  // Aliases (e.g. "Etc/GMT") are not always listed but are still understood.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(instant: Date, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

// The zone's offset from UTC at an instant, in milliseconds.
function offsetMs(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// The instant a wall-clock hour:00 on a local date happens. A time skipped by a
// DST change (02:00 on a spring-forward night) comes out as the instant the
// clocks jumped to, the next valid one; a time repeated when clocks go back
// comes out as one of its two instants, never both.
function instantAt(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour);
  // Two passes settle on the right offset either side of a transition.
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  if (second === first) return new Date(first);
  // A gap: neither offset maps back to hour:00. The earlier candidate is the
  // later wall-clock reading, i.e. just after the jump.
  return new Date(Math.max(first, second));
}

export interface DigestSchedule {
  deliveryMode: NotificationDeliveryMode;
  digestHour: number | null;
  digestWeekday: number | null;
  digestTimeZone: string | null;
}

// When the next digest is due, strictly after `after`; null for a target that
// sends each review on its own.
export function nextDigestAt(schedule: DigestSchedule, after: Date): Date | null {
  const { deliveryMode, digestHour: hour, digestWeekday: weekday, digestTimeZone: stored } = schedule;
  if (deliveryMode === "each" || hour === null || !stored) return null;
  // A zone this runtime no longer knows (after an ICU update) would make
  // Intl throw and stall the target; UTC keeps its digests coming.
  const timeZone = isValidTimeZone(stored) ? stored : "UTC";
  if (deliveryMode === "weekly" && weekday === null) return null;
  const today = wallClock(after, timeZone);
  // Walk local calendar days from today; a week and a day always reaches the
  // next match, whatever DST does.
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (deliveryMode === "weekly" && date.getUTCDay() !== weekday) continue;
    const due = instantAt(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, timeZone);
    if (due.getTime() > after.getTime()) return due;
  }
  return null;
}

// "Nov 10, 2026, 9:00 AM" in the target's timezone, for digest messages.
export function formatDigestTime(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(instant);
  } catch {
    // A zone this runtime no longer knows still gets a readable time.
    return `${instant.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}
