import {
  nflverseReferenceScoring,
  sleeperReferenceScoring,
  validateScoring,
  type KnownDifference,
  type ScoringCase,
  type ScoringReport
} from '@fantasy/core';
import { csvNumber, csvValue, parseCsvObjects } from '../nflverse/csv.js';
import { mapNflverseStats, STATS_REQUIRED_COLUMNS } from '../nflverse/stats.js';

/**
 * The scoring validation harness (#30): runs the scoring engine over recorded stat lines and
 * compares every player's PPR, half-PPR, and standard total with the source's own precomputed one.
 *
 * - Sleeper stat files (`/v1/stats/nfl/regular/{season}/{week}`, keyed by player id) carry
 *   `pts_ppr`, `pts_half_ppr`, and `pts_std`, scored with Sleeper's default settings.
 * - nflverse `stats_player_week` rows carry `fantasy_points` (standard) and `fantasy_points_ppr`.
 *
 * Known, intended differences are explained (and listed in docs/rules.md); anything else is a bug.
 */

type SleeperStatsFile = Readonly<Record<string, Readonly<Record<string, number | null | undefined>>>>;

/** One case per player in a Sleeper stats file that has precomputed points. */
export function sleeperScoringCases(file: SleeperStatsFile, label: string): ScoringCase[] {
  const cases: ScoringCase[] = [];
  for (const [playerId, stats] of Object.entries(file)) {
    const expected: ScoringCase['expected'] = {};
    if (typeof stats.pts_ppr === 'number') expected.ppr = stats.pts_ppr;
    if (typeof stats.pts_half_ppr === 'number') expected.half_ppr = stats.pts_half_ppr;
    if (typeof stats.pts_std === 'number') expected.std = stats.pts_std;
    if (Object.keys(expected).length > 0) cases.push({ key: `${label} ${playerId}`, stats, expected });
  }
  return cases;
}

export function validateSleeperStats(file: SleeperStatsFile, label: string): ScoringReport {
  return validateScoring(sleeperScoringCases(file, label), sleeperReferenceScoring);
}

/** Offensive fumbles nflverse charges in `fantasy_points`; `fumbles_lost_total` also has returns. */
const SCRIMMAGE_FUMBLES_LOST = ['sack_fumbles_lost', 'rushing_fumbles_lost', 'receiving_fumbles_lost'];

export interface NflverseScoringCases {
  cases: ScoringCase[];
  /** Lost fumbles on kick and punt returns, by case key. */
  returnFumblesLost: ReadonlyMap<string, number>;
}

/** One case per regular-season nflverse row (half-PPR is the mean of the two published totals). */
export function nflverseScoringCases(csv: string): NflverseScoringCases {
  const cases: ScoringCase[] = [];
  const returnFumblesLost = new Map<string, number>();
  for (const row of parseCsvObjects(csv, STATS_REQUIRED_COLUMNS, 'nflverse stats_player_week')) {
    if (csvValue(row, 'season_type') !== 'REG') continue;
    const key = `${csvValue(row, 'season')} wk${csvValue(row, 'week')} ${csvValue(row, 'player_id')} (${csvValue(row, 'player_display_name')})`;
    const scrimmage = SCRIMMAGE_FUMBLES_LOST.reduce((sum, col) => sum + (csvNumber(row, col) ?? 0), 0);
    const onReturns = (csvNumber(row, 'fumbles_lost_total') ?? 0) - scrimmage;
    if (onReturns > 0) returnFumblesLost.set(key, onReturns);
    const std = csvNumber(row, 'fantasy_points') ?? 0;
    const ppr = csvNumber(row, 'fantasy_points_ppr') ?? 0;
    cases.push({ key, stats: mapNflverseStats(row), expected: { std, ppr, half_ppr: (std + ppr) / 2 } });
  }
  return { cases, returnFumblesLost };
}

/**
 * nflverse leaves fumbles lost on kick and punt returns out of `fantasy_points`; we charge every
 * lost fumble (`fum_lost`), returns included.
 */
export function returnFumbleDifference(returnFumblesLost: ReadonlyMap<string, number>): KnownDifference {
  return (c, _format, diff) => {
    const lost = returnFumblesLost.get(c.key);
    return lost !== undefined && Math.abs(diff + 2 * lost) < 1e-6
      ? `${lost} lost fumble(s) on returns: nflverse does not charge them, we do (-2 each)`
      : null;
  };
}

export function validateNflverseStats(csv: string): ScoringReport {
  const { cases, returnFumblesLost } = nflverseScoringCases(csv);
  return validateScoring(cases, nflverseReferenceScoring, [returnFumbleDifference(returnFumblesLost)]);
}
