import type { ScheduledGame } from '@fantasy/data';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Kickoff → final, matching `HistoricalDataProvider`'s default game duration. */
export const GAME_DURATION_MS = 4 * HOUR_MS;

/**
 * The fixed offsets that place a week's simulated moments relative to real kickoffs. They are shared by
 * the archive builder (which stamps capture times) and the timeline (which schedules events), so the two
 * can never disagree.
 */
export const MOMENT_OFFSETS = {
  /**
   * Projections and the player snapshot for week W: 6h after week W-1's last kickoff (early Tuesday
   * UTC, once Monday night is final), so they are known before that day's waiver run (08:00 UTC).
   */
  projectionsAfterPreviousLastKickoffMs: 6 * HOUR_MS,
  /** Week 1 (no previous week): three days before the first kickoff. */
  projectionsBeforeFirstKickoffMs: 3 * DAY_MS,
  /** Waivers for week W run 30h after week W-1's last kickoff (early Wednesday morning ET). */
  waiversAfterPreviousLastKickoffMs: 30 * HOUR_MS,
  /** Week 1 waivers (post-draft) run one day before the first kickoff. */
  waiversBeforeFirstKickoffMs: DAY_MS,
  /** The draft starts two hours after the start week's projections are published. */
  draftAfterProjectionsMs: 2 * HOUR_MS,
  /** Injury designations become visible two hours before the week's first kickoff. */
  injuriesBeforeFirstKickoffMs: 2 * HOUR_MS,
  /** Stat corrections are final 60h after the week's last kickoff (Thursday morning ET). */
  correctionsAfterLastKickoffMs: 60 * HOUR_MS
} as const;

export interface WeekKickoffs {
  week: number;
  /** Distinct kickoff instants (ms), ascending: one lineup-lock window each. */
  windows: number[];
  firstKickoff: number;
  lastKickoff: number;
}

/** Regular-season kickoff windows for every week in the schedule, ascending by week. */
export function regularSeasonWeeks(schedule: readonly ScheduledGame[]): WeekKickoffs[] {
  const byWeek = new Map<number, Set<number>>();
  for (const g of schedule) {
    if (g.seasonType !== 'regular') continue;
    const set = byWeek.get(g.week) ?? new Set<number>();
    set.add(Date.parse(g.kickoff));
    byWeek.set(g.week, set);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, set]) => {
      const windows = [...set].sort((a, b) => a - b);
      return {
        week,
        windows,
        firstKickoff: windows[0] as number,
        lastKickoff: windows[windows.length - 1] as number
      };
    });
}

export interface WeekMoments extends WeekKickoffs {
  /** When the week's projections, trending, and player snapshot are captured. */
  projectionsAt: number;
  /** When injury designations for the week become visible. */
  injuriesAt: number;
  /** When waivers for the week are processed (before any of its games). */
  waiversAt: number;
  /** When the last game is final (Monday night final). */
  lastFinalAt: number;
  /** When the week's stats are official (the Thursday stat-correction run). */
  correctionsAt: number;
}

/** Computes the simulated moments of every regular-season week in the schedule. */
export function weekMoments(schedule: readonly ScheduledGame[]): Map<number, WeekMoments> {
  const weeks = regularSeasonWeeks(schedule);
  const out = new Map<number, WeekMoments>();
  const o = MOMENT_OFFSETS;
  weeks.forEach((w, i) => {
    const prev = i > 0 ? weeks[i - 1] : undefined;
    const projectionsAt = prev
      ? prev.lastKickoff + o.projectionsAfterPreviousLastKickoffMs
      : w.firstKickoff - o.projectionsBeforeFirstKickoffMs;
    const waiversAt = prev
      ? prev.lastKickoff + o.waiversAfterPreviousLastKickoffMs
      : w.firstKickoff - o.waiversBeforeFirstKickoffMs;
    out.set(w.week, {
      ...w,
      projectionsAt,
      injuriesAt: w.firstKickoff - o.injuriesBeforeFirstKickoffMs,
      waiversAt,
      lastFinalAt: w.lastKickoff + GAME_DURATION_MS,
      correctionsAt: w.lastKickoff + o.correctionsAfterLastKickoffMs
    });
  });
  return out;
}

/** When the draft of a league starting in `startWeek` happens. */
export function draftMoment(moments: WeekMoments): number {
  return moments.projectionsAt + MOMENT_OFFSETS.draftAfterProjectionsMs;
}

export const iso = (ms: number): string => new Date(ms).toISOString();
