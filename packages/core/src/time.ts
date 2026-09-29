import type { Instant } from './rules/lineup.js';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Milliseconds since the epoch for an `Instant`. Core never reads the wall clock; callers pass times in. */
export function instantMs(t: Instant): number {
  return typeof t === 'string' ? new Date(t).getTime() : t.getTime();
}

/** ISO string for an `Instant` shifted by `ms`. */
export function shiftInstant(t: Instant, ms: number): string {
  return new Date(instantMs(t) + ms).toISOString();
}

/** ISO string for an `Instant`. */
export function toIso(t: Instant): string {
  return shiftInstant(t, 0);
}

/** A wall-clock reading in a time zone. `month` is 1-12. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let format = zoneFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric'
    });
    zoneFormats.set(timeZone, format);
  }
  return format;
}

/** The wall-clock reading of `at` in an IANA time zone (e.g. `America/New_York`). Pure. */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of zoneFormat(timeZone).formatToParts(at)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year as number,
    month: parts.month as number,
    day: parts.day as number,
    hour: parts.hour as number,
    minute: parts.minute as number
  };
}

/** How far the zone's wall clock is ahead of UTC at `at`, in milliseconds (whole minutes). */
function zoneOffsetMs(at: number, timeZone: string): number {
  const p = zonedParts(new Date(at), timeZone);
  const minute = Math.floor(at / 60_000) * 60_000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - minute;
}

/**
 * The instant a wall-clock time in a time zone happens (the inverse of `zonedParts`). Days past
 * the end of a month roll over (`day: 32` is the next month's first), so callers can add days. A
 * wall-clock time a daylight-saving jump skips resolves to an instant next to the jump.
 */
export function zonedTimeToUtc(local: ZonedParts, timeZone: string): Date {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return new Date(wall - zoneOffsetMs(guess, timeZone));
}

/** The zone's calendar date of `at`, as `YYYY-MM-DD`. */
export function zonedDate(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
