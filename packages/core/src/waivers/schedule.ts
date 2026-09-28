import type { Instant } from '../rules/lineup.js';
import { DAY_MS, HOUR_MS, instantMs } from '../time.js';

/**
 * When pending waiver claims are processed. Claims run once a day at `WAIVER_RUN_HOUR_UTC` (3 AM
 * US Central in daylight time, 2 AM in standard time), the Yahoo overnight slot. The scheduled job
 * in infra/template.yaml runs at the same hour; keep them in step.
 */
export const WAIVER_RUN_HOUR_UTC = 8;

/** The first waiver run at or after `t`. */
export function waiverRunAtOrAfter(t: Instant, hourUtc: number = WAIVER_RUN_HOUR_UTC): string {
  const ms = instantMs(t);
  const dayStart = Math.floor(ms / DAY_MS) * DAY_MS;
  const today = dayStart + hourUtc * HOUR_MS;
  return new Date(today >= ms ? today : today + DAY_MS).toISOString();
}

/** The first waiver run strictly after `t` (the close of the window that is open at `t`). */
export function nextWaiverRun(t: Instant, hourUtc: number = WAIVER_RUN_HOUR_UTC): string {
  return waiverRunAtOrAfter(new Date(instantMs(t) + 1), hourUtc);
}

/** The run a processing job at `t` belongs to, as `YYYY-MM-DD` (UTC): one window per day. */
export function waiverRunId(t: Instant): string {
  return new Date(instantMs(t)).toISOString().slice(0, 10);
}
