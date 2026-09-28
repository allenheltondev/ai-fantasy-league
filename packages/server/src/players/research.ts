import { seasonPoints, sumStatLines, type ScoringSettings, type WeekPoints } from '@fantasy/core';
import type { ByeWeeks, NflState, PlayerSeasonLines } from '@fantasy/data';
import type { Ctx } from '../context.js';
import type { Position } from './model.js';

/**
 * Draft research (#136): last season's fantasy points and this season's projection, scored at
 * read time under the caller's league scoring from the stored weekly lines (`SEASON#…`), plus
 * bye weeks. Scoring a season is a few hundred multiplications per player, so it is cheaper to
 * redo per read than to cache per scoring hash, and it can never be stale.
 */

/**
 * The seasons draft research covers: the season being drafted for (Sleeper moves `league_season`
 * to the next year in the offseason, before `season`) and the one before it.
 */
export function researchSeasons(state: Pick<NflState, 'season' | 'leagueSeason' | 'previousSeason'>): {
  season: number;
  lastSeason: number;
} {
  const season = Math.max(state.season, state.leagueSeason);
  return { season, lastSeason: season === state.season ? state.previousSeason : state.season };
}

export interface LastSeason {
  season: number;
  points: number;
  ppg: number;
  games: number;
  weekly: WeekPoints[];
  lines: PlayerSeasonLines;
}

export interface SeasonProjection {
  season: number;
  points: number;
  lines: PlayerSeasonLines;
}

export interface Research {
  season: number | null;
  lastSeasonYear: number | null;
  lastSeason(playerId: string): LastSeason | null;
  projection(playerId: string): SeasonProjection | null;
  bye(team: string | null): number | null;
}

/** Above this many players, one partition query beats batched point reads. */
const POINT_READ_LIMIT = 100;

const EMPTY: Research = {
  season: null,
  lastSeasonYear: null,
  lastSeason: () => null,
  projection: () => null,
  bye: () => null
};

/** Loads research for `playerIds`, scored with `scoring`. */
export async function loadResearch(
  ctx: Pick<Ctx, 'data'>,
  scoring: ScoringSettings,
  playerIds: readonly string[]
): Promise<Research> {
  const reference = ctx.data.reference;
  const state = await reference.nflState.get();
  if (state === null) return EMPTY;
  const { season, lastSeason } = researchSeasons(state);
  const ids = playerIds.length > POINT_READ_LIMIT ? undefined : playerIds;
  if (ids !== undefined && ids.length === 0) return { ...EMPTY, season, lastSeasonYear: lastSeason };
  const [stats, projections, schedule] = await Promise.all([
    reference.seasons.get('stats', lastSeason, ids),
    reference.seasons.get('projections', season, ids),
    reference.schedule.getSeason(season)
  ]);
  const byes: ByeWeeks = schedule?.byes ?? {};
  const statsBy = new Map(stats.map((l) => [l.playerId, l]));
  const projBy = new Map(projections.map((l) => [l.playerId, l]));
  const lastCache = new Map<string, LastSeason | null>();
  const projCache = new Map<string, SeasonProjection | null>();
  return {
    season,
    lastSeasonYear: lastSeason,
    lastSeason(playerId) {
      if (!lastCache.has(playerId)) {
        const lines = statsBy.get(playerId);
        lastCache.set(
          playerId,
          lines === undefined ? null : { season: lastSeason, ...seasonPoints(scoring, lines.weeks), lines }
        );
      }
      return lastCache.get(playerId) ?? null;
    },
    projection(playerId) {
      if (!projCache.has(playerId)) {
        const lines = projBy.get(playerId);
        projCache.set(
          playerId,
          lines === undefined ? null : { season, points: seasonPoints(scoring, lines.weeks).points, lines }
        );
      }
      return projCache.get(playerId) ?? null;
    },
    bye: (team) => (team === null ? null : (byes[team] ?? null))
  };
}

/** The season totals a player card shows, by position. */
export const CARD_STATS: Readonly<Record<Position, readonly string[]>> = {
  QB: [
    'pass_att',
    'pass_cmp',
    'pass_yd',
    'pass_td',
    'pass_int',
    'rush_att',
    'rush_yd',
    'rush_td',
    'fum_lost'
  ],
  RB: ['rush_att', 'rush_yd', 'rush_td', 'rec_tgt', 'rec', 'rec_yd', 'rec_td', 'fum_lost'],
  WR: ['rec_tgt', 'rec', 'rec_yd', 'rec_td', 'rush_att', 'rush_yd', 'rush_td', 'fum_lost'],
  TE: ['rec_tgt', 'rec', 'rec_yd', 'rec_td', 'fum_lost'],
  K: ['fgm', 'fga', 'fgm_50p', 'xpm', 'xpa'],
  DEF: ['sack', 'int', 'fum_rec', 'def_td', 'safe', 'pts_allow', 'yds_allow']
};

/** Season totals of the card stats for the position (0 when never recorded), rounded to 1 decimal. */
export function cardTotals(lines: PlayerSeasonLines, position: Position): Record<string, number> {
  const totals = sumStatLines(lines.weeks.map((w) => w.stats));
  return Object.fromEntries(
    CARD_STATS[position].map((key) => [key, Math.round((totals[key] ?? 0) * 10) / 10])
  );
}
