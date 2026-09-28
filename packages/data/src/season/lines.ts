import { LAST_NFL_WEEK, STAT_LABELS } from '@fantasy/core';
import type { DataProvider } from '../provider.js';
import type { ProjectionSource } from '../sleeper/client.js';
import { compareIds } from '../sleeper/normalize.js';
import type { PlayerSeasonLines, StatLine, StatMap } from '../types.js';

/**
 * Season research data (#136): last season's weekly stats and this season's weekly projections,
 * folded into one compact record per player so a draft board reads a whole season in one query.
 */

/**
 * Stat keys kept in season records: every key league scoring knows (`STAT_LABELS`), plus games
 * played and attempts for the player card. Sleeper's own point totals and ranks are dropped.
 */
export const SEASON_STAT_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(STAT_LABELS),
  'gp',
  'fga',
  'fgm',
  'xpa'
]);

/** Keys whose zero still scores (a shutout's points-allowed tier) or means something (no game). */
const ZERO_MATTERS: ReadonlySet<string> = new Set(['gp', 'pts_allow', 'yds_allow']);

/** Keeps the season keys, dropping zeros that score nothing. */
export function compactStats(stats: StatMap): StatMap {
  const out: StatMap = {};
  for (const [key, value] of Object.entries(stats)) {
    if (SEASON_STAT_KEYS.has(key) && (value !== 0 || ZERO_MATTERS.has(key))) out[key] = value;
  }
  return out;
}

/**
 * Groups weekly lines (any weeks, any order) into one record per player, sorted by player id.
 * Weeks that compact to nothing are dropped, and so are players left with no weeks.
 */
export function buildSeasonLines(season: number, lines: readonly StatLine[]): PlayerSeasonLines[] {
  const byPlayer = new Map<string, StatLine[]>();
  for (const line of lines) {
    if (line.season !== season) continue;
    const list = byPlayer.get(line.playerId) ?? [];
    list.push(line);
    byPlayer.set(line.playerId, list);
  }
  const out: PlayerSeasonLines[] = [];
  for (const [playerId, list] of byPlayer) {
    const sorted = [...list].sort((a, b) => a.week - b.week);
    const weeks = sorted
      .map((l) => ({ week: l.week, stats: compactStats(l.stats) }))
      .filter((w) => Object.keys(w.stats).length > 0);
    if (weeks.length === 0) continue;
    const team = [...sorted].reverse().find((l) => l.team !== undefined)?.team;
    out.push({ playerId, season, ...(team === undefined ? {} : { team }), weeks });
  }
  return out.sort((a, b) => compareIds(a.playerId, b.playerId));
}

export type SeasonLinesKind = 'stats' | 'projections';

export interface FetchedSeason {
  lines: PlayerSeasonLines[];
  /** Weeks the source had any line for. */
  weeks: number[];
  /**
   * Projections only, from a provider that reports it (`projectionSource`, #184): the weeks each
   * upstream endpoint served.
   */
  sources?: Partial<Record<ProjectionSource, number[]>>;
}

/**
 * Pulls every regular-season week (1-18) of stats or projections and folds them per player.
 * Sleeper has no reliable season-total endpoint for either, so this is 18 weekly calls (well
 * within the shared rate limit); a week the source has nothing for yet contributes nothing.
 */
export async function fetchSeasonLines(
  provider: Pick<DataProvider, 'getWeekStats' | 'getWeekProjections' | 'projectionSource'>,
  kind: SeasonLinesKind,
  season: number,
  asOf: Date
): Promise<FetchedSeason> {
  const all: StatLine[] = [];
  const weeks: number[] = [];
  const sources: Partial<Record<ProjectionSource, number[]>> = {};
  for (let week = 1; week <= LAST_NFL_WEEK; week++) {
    const lines =
      kind === 'stats'
        ? await provider.getWeekStats(season, week, asOf)
        : await provider.getWeekProjections(season, week, asOf);
    if (lines.length > 0) weeks.push(week);
    all.push(...lines);
    const source = kind === 'projections' ? provider.projectionSource?.(season, week) : undefined;
    if (source !== undefined) (sources[source] ??= []).push(week);
  }
  return {
    lines: buildSeasonLines(season, all),
    weeks,
    ...(Object.keys(sources).length > 0 && { sources })
  };
}
