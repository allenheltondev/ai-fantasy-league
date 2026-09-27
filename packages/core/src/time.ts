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
