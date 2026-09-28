import { LAST_NFL_WEEK } from '@fantasy/core';
import type { Logger } from '../log.js';

/**
 * Where a new league starts. The data layer's NFL state (`DataProvider.getNflState` from
 * `@fantasy/data` fits `NflStateSource` as is) is used when it is wired in; otherwise the week is
 * estimated from the clock with the NFL's usual calendar.
 */

export interface NflStateSnapshot {
  season: number;
  seasonType: 'pre' | 'regular' | 'post' | 'off';
  /** The current NFL week. */
  week: number;
}

export interface NflStateSource {
  getNflState(asOf: Date): Promise<NflStateSnapshot>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Labor Day (first Monday of September), midnight UTC. */
export function laborDay(year: number): Date {
  const first = new Date(Date.UTC(year, 8, 1));
  const offset = (8 - first.getUTCDay()) % 7;
  return new Date(Date.UTC(year, 8, 1 + offset));
}

/**
 * Estimated first kickoff of a regular-season week: the Thursday after Labor Day at 8:20 PM US
 * Eastern (00:20 UTC Friday), plus one week per week.
 */
export function estimatedWeekKickoff(season: number, week: number): Date {
  const firstFriday = laborDay(season).getTime() + 4 * DAY_MS;
  return new Date(firstFriday + 20 * 60 * 1000 + (week - 1) * WEEK_MS);
}

/** The NFL season a moment belongs to: January and February finish the previous year's season. */
export function nflSeasonAt(now: Date): number {
  return now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

export interface StartWeek {
  season: number;
  /** The first week whose games have not kicked off. `LAST_NFL_WEEK + 1` when none is left. */
  week: number;
  source: 'nfl_state' | 'clock';
}

/** The next week that has not kicked off, estimated from the clock alone. */
export function estimateNextUnlockedWeek(now: Date): StartWeek {
  const season = nflSeasonAt(now);
  return { season, week: firstUnlockedWeek(season, 1, now), source: 'clock' };
}

function firstUnlockedWeek(season: number, from: number, now: Date): number {
  let week = Math.max(1, from);
  while (week <= LAST_NFL_WEEK && estimatedWeekKickoff(season, week).getTime() <= now.getTime()) week++;
  return week;
}

/** The next unlocked week from the NFL state, falling back to the clock when there is none. */
export async function nextUnlockedWeek(
  source: NflStateSource | undefined,
  now: Date,
  log: Logger
): Promise<StartWeek> {
  if (source === undefined) return estimateNextUnlockedWeek(now);
  let state: NflStateSnapshot;
  try {
    state = await source.getNflState(now);
  } catch (error) {
    log.warn('NFL state unavailable; estimating the week from the clock', { error });
    return estimateNextUnlockedWeek(now);
  }
  switch (state.seasonType) {
    case 'pre':
    case 'off':
      return { season: state.season, week: 1, source: 'nfl_state' };
    case 'post':
      return { season: state.season, week: LAST_NFL_WEEK + 1, source: 'nfl_state' };
    case 'regular':
      // The current week is still open only until its first kickoff.
      return {
        season: state.season,
        week: firstUnlockedWeek(state.season, state.week, now),
        source: 'nfl_state'
      };
  }
}

/**
 * The first week a league scores (#85). A league whose draft completes during the season cannot
 * score weeks that already kicked off, so it starts at the later of its `schedule.startWeek` and
 * the next unlocked NFL week. An unlocked week in a later season means the league's season is
 * over (`LAST_NFL_WEEK + 1`). Pure: pass the `nextUnlockedWeek` answer in.
 */
export function firstScoringWeek(
  league: { season: number; settings: { schedule: { startWeek: number } } },
  unlocked: Pick<StartWeek, 'season' | 'week'>
): number {
  if (unlocked.season < league.season) return league.settings.schedule.startWeek;
  if (unlocked.season > league.season) return LAST_NFL_WEEK + 1;
  return Math.max(league.settings.schedule.startWeek, unlocked.week);
}

/**
 * The NFL week in progress (or about to start): the NFL state's week during the regular season,
 * week 1 before it, and the last week after it. Without NFL state, the latest week whose first game
 * has kicked off by the clock (week 1 before the season). A league that finishes its draft now
 * plays from `max(startWeek, currentNflWeek)`.
 */
export async function currentNflWeek(
  source: NflStateSource | undefined,
  now: Date,
  log: Logger
): Promise<{ season: number; week: number; source: 'nfl_state' | 'clock' }> {
  if (source !== undefined) {
    try {
      const state = await source.getNflState(now);
      const week =
        state.seasonType === 'regular'
          ? Math.min(Math.max(state.week, 1), LAST_NFL_WEEK)
          : state.seasonType === 'post'
            ? LAST_NFL_WEEK
            : 1;
      return { season: state.season, week, source: 'nfl_state' };
    } catch (error) {
      log.warn('NFL state unavailable; estimating the week from the clock', { error });
    }
  }
  const season = nflSeasonAt(now);
  return { season, week: Math.max(1, firstUnlockedWeek(season, 1, now) - 1), source: 'clock' };
}
