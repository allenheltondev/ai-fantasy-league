import { zonedDate, zonedParts, zonedTimeToUtc } from '../time.js';

/**
 * Manager check-ins (#195): real managers look at their team a few times a day, so the agents do
 * too, whether or not anything happened in the league. Three times a day, at fixed wall-clock
 * times in the league's home time zone, every agent gets a `check_in` task: one pass over its
 * lineup, the waiver wire, and the trade market, where doing nothing is a fine answer.
 *
 * Pure: callers pass `now`.
 */

export const CHECK_IN_SLOTS = ['morning', 'afternoon', 'evening'] as const;
export type CheckInSlot = (typeof CHECK_IN_SLOTS)[number];

/** Check-in times are wall-clock times here (US Eastern, where the NFL keeps its clock). */
export const CHECK_IN_TIME_ZONE = 'America/New_York';

/** The local hour of each check-in. */
export const CHECK_IN_HOURS: Readonly<Record<CheckInSlot, number>> = {
  morning: 9,
  afternoon: 14,
  evening: 20
};

/** Check-ins per week (three a day). */
export const CHECK_INS_PER_WEEK = 7 * CHECK_IN_SLOTS.length;

export interface CheckInMoment {
  slot: CheckInSlot;
  /** The local calendar date of the check-in (`YYYY-MM-DD`); with `slot`, its once-only key. */
  date: string;
  /** When the check-in was scheduled. */
  at: Date;
  /** When the next one is. */
  nextAt: Date;
}

/** The scheduled check-ins from the day before `now`'s local date to the day after, oldest first. */
function checkInsAround(now: Date): { slot: CheckInSlot; at: Date }[] {
  const today = zonedParts(now, CHECK_IN_TIME_ZONE);
  const out: { slot: CheckInSlot; at: Date }[] = [];
  for (const offset of [-1, 0, 1]) {
    for (const slot of CHECK_IN_SLOTS) {
      const at = zonedTimeToUtc(
        { ...today, day: today.day + offset, hour: CHECK_IN_HOURS[slot], minute: 0 },
        CHECK_IN_TIME_ZONE
      );
      out.push({ slot, at });
    }
  }
  return out;
}

/**
 * The check-in `now` belongs to: the latest scheduled one at or before `now` (a job that runs a
 * little late, or is retried, still counts as that check-in), and when the next one is.
 */
export function checkInMoment(now: Date): CheckInMoment {
  const around = checkInsAround(now);
  const t = now.getTime();
  const index = around.findLastIndex((c) => c.at.getTime() <= t);
  // Yesterday's morning is always at or before now, and tomorrow's evening always after it.
  const current = around[index] as { slot: CheckInSlot; at: Date };
  const next = around[index + 1] as { at: Date };
  return {
    slot: current.slot,
    date: zonedDate(current.at, CHECK_IN_TIME_ZONE),
    at: current.at,
    nextAt: next.at
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/**
 * The chance a check-in takes a look at the trade market, by the archetype's trade frequency:
 * half the square of it, so a trade addict (0.9) shops at about two check-ins in five and a waiver
 * hawk (0.2) about once in fifty. How many offers go out is capped separately
 * (`tradeAppetite(config).proposalsPerWeek`).
 */
export function checkInTradeChance(tradeFrequency: number): number {
  const f = clamp01(tradeFrequency);
  return Math.round(f * f * 50) / 100;
}
