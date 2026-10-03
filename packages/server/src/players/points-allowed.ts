import type { StatsRepository } from '../repos/reference.js';
import { NFL_TEAMS, POSITIONS, type Position } from './model.js';

/**
 * Fantasy points allowed by position: how many points each NFL defense gives up to opposing
 * quarterbacks, running backs, receivers, tight ends, kickers, and team defenses, per game. Sleeper
 * puts these on each team defense's weekly stat line (`fan_pts_allow_qb`, ...) in its PPR scoring,
 * and the stat jobs store those lines whole, so this reads 32 defenses' lines back and averages
 * them over the completed weeks. Rank 1 allows the most points: the easiest matchup.
 */

/** Sleeper's stat key for the PPR points a defense allowed to each position. */
export const POINTS_ALLOWED_KEYS: Readonly<Record<Position, string>> = {
  QB: 'fan_pts_allow_qb',
  RB: 'fan_pts_allow_rb',
  WR: 'fan_pts_allow_wr',
  TE: 'fan_pts_allow_te',
  K: 'fan_pts_allow_k',
  DEF: 'fan_pts_allow_def'
};

/** Sleeper's total of the per-position keys; a line without any of them has no points-allowed data. */
const TOTAL_KEY = 'fan_pts_allow';

export interface PositionAllowed {
  /** PPR points allowed to the position per game. */
  perGame: number;
  /** 1 allows the most (the easiest matchup) through `of` (the toughest); ties share a rank. */
  rank: number;
  /** How many defenses are ranked. */
  of: number;
}

export interface TeamPointsAllowed {
  team: string;
  /** Games counted. */
  games: number;
  positions: Record<Position, PositionAllowed>;
}

export interface PointsAllowedTable {
  season: number;
  /** The last week counted: weeks before the current one, which are complete. */
  throughWeek: number;
  /** Every defense with at least one counted game, in team order. */
  teams: TeamPointsAllowed[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function hasPointsAllowed(stats: Readonly<Record<string, number>>): boolean {
  return (
    stats[TOTAL_KEY] !== undefined || Object.values(POINTS_ALLOWED_KEYS).some((k) => stats[k] !== undefined)
  );
}

/**
 * The points-allowed table for `season`, counting regular-season weeks before `currentWeek` (the
 * week being played is never complete). Sleeper leaves a zero out of a line, so a missing
 * per-position key in a counted game is 0. Null when no defense has a counted game yet.
 */
export async function loadPointsAllowed(
  stats: Pick<StatsRepository, 'getPlayerHistory'>,
  season: number,
  currentWeek: number
): Promise<PointsAllowedTable | null> {
  const throughWeek = currentWeek - 1;
  if (throughWeek < 1) return null;
  const histories = await Promise.all(NFL_TEAMS.map((team) => stats.getPlayerHistory(team, season)));
  const totals: { team: string; games: number; sums: Record<Position, number> }[] = [];
  NFL_TEAMS.forEach((team, i) => {
    const sums = Object.fromEntries(POSITIONS.map((p) => [p, 0])) as Record<Position, number>;
    let games = 0;
    for (const line of histories[i] ?? []) {
      if (line.season !== season || line.week < 1 || line.week > throughWeek) continue;
      if (!(Number(line.stats.gp) > 0) || !hasPointsAllowed(line.stats)) continue;
      games++;
      for (const p of POSITIONS) sums[p] += line.stats[POINTS_ALLOWED_KEYS[p]] ?? 0;
    }
    if (games > 0) totals.push({ team, games, sums });
  });
  if (totals.length === 0) return null;
  const perGame = totals.map((t) => ({
    ...t,
    avg: Object.fromEntries(POSITIONS.map((p) => [p, round1(t.sums[p] / t.games)])) as Record<
      Position,
      number
    >
  }));
  const of = perGame.length;
  return {
    season,
    throughWeek,
    teams: perGame.map((t) => ({
      team: t.team,
      games: t.games,
      positions: Object.fromEntries(
        POSITIONS.map((p) => [
          p,
          { perGame: t.avg[p], rank: 1 + perGame.filter((o) => o.avg[p] > t.avg[p]).length, of }
        ])
      ) as Record<Position, PositionAllowed>
    }))
  };
}
