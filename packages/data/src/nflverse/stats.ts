import { USAGE_STAT_PREFIX } from '@fantasy/core';
import { toSleeperTeam } from '../teams.js';
import type { StatLine, StatMap } from '../types.js';
import type { IdCrosswalk } from './crosswalk.js';
import { csvNumber, csvValue, parseCsvObjects, type CsvRow } from './csv.js';

/**
 * Sleeper stat key ← the nflverse `stats_player_week` columns summed to produce it. This lets the
 * scoring engine read either source through the same keys.
 */
export const NFLVERSE_TO_SLEEPER: Readonly<Record<string, readonly string[]>> = {
  // passing
  pass_cmp: ['completions'],
  pass_att: ['attempts'],
  pass_yd: ['passing_yards'],
  pass_td: ['passing_tds'],
  pass_int: ['passing_interceptions'],
  pass_sack: ['sacks_suffered'],
  pass_2pt: ['passing_2pt_conversions'],
  pass_fd: ['passing_first_downs'],
  // rushing
  rush_att: ['carries'],
  rush_yd: ['rushing_yards'],
  rush_td: ['rushing_tds'],
  rush_2pt: ['rushing_2pt_conversions'],
  rush_fd: ['rushing_first_downs'],
  // receiving
  rec: ['receptions'],
  rec_tgt: ['targets'],
  rec_yd: ['receiving_yards'],
  rec_td: ['receiving_tds'],
  rec_2pt: ['receiving_2pt_conversions'],
  rec_fd: ['receiving_first_downs'],
  // ball security
  fum: ['fumbles_total'],
  fum_lost: ['fumbles_lost_total'],
  // returns / special teams
  st_td: ['special_teams_tds'],
  pr: ['punt_returns'],
  pr_yd: ['punt_return_yards'],
  kr: ['kickoff_returns'],
  kr_yd: ['kickoff_return_yards'],
  // kicking
  fgm: ['fg_made'],
  fga: ['fg_att'],
  fgmiss: ['fg_missed'],
  fgm_0_19: ['fg_made_0_19'],
  fgm_20_29: ['fg_made_20_29'],
  fgm_30_39: ['fg_made_30_39'],
  fgm_40_49: ['fg_made_40_49'],
  fgm_50_59: ['fg_made_50_59'],
  fgm_60p: ['fg_made_60_'],
  fgm_50p: ['fg_made_50_59', 'fg_made_60_'],
  fgmiss_0_19: ['fg_missed_0_19'],
  fgmiss_20_29: ['fg_missed_20_29'],
  fgmiss_30_39: ['fg_missed_30_39'],
  fgmiss_40_49: ['fg_missed_40_49'],
  fgmiss_50p: ['fg_missed_50_59', 'fg_missed_60_'],
  fgm_yds: ['fg_made_distance'],
  xpm: ['pat_made'],
  xpa: ['pat_att'],
  xpmiss: ['pat_missed'],
  // IDP
  idp_tkl_solo: ['def_tackles_solo'],
  idp_tkl_ast: ['def_tackle_assists'],
  idp_tkl_loss: ['def_tackles_for_loss'],
  idp_sack: ['def_sacks'],
  idp_qb_hit: ['def_qb_hits'],
  idp_int: ['def_interceptions'],
  idp_pass_def: ['def_pass_defended'],
  idp_ff: ['def_fumbles_forced'],
  idp_fum_rec: ['fumble_recovery_opp'],
  idp_def_td: ['def_tds'],
  idp_safe: ['def_safeties']
};

/**
 * Usage stat key ← the nflverse column it copies: the advanced receiving, passing, and rushing
 * numbers Sleeper does not carry. Keys share `USAGE_STAT_PREFIX` (`nfv_`) so they never collide with
 * a Sleeper key and never count as a scoring change. Shares are fractions (0.25 is a quarter of the
 * team's targets); air yards can be negative (a catch behind the line).
 */
export const NFLVERSE_USAGE: Readonly<Record<string, string>> = {
  [`${USAGE_STAT_PREFIX}tgt_share`]: 'target_share',
  [`${USAGE_STAT_PREFIX}air_yd_share`]: 'air_yards_share',
  [`${USAGE_STAT_PREFIX}wopr`]: 'wopr',
  [`${USAGE_STAT_PREFIX}rec_air_yd`]: 'receiving_air_yards',
  [`${USAGE_STAT_PREFIX}rec_yac`]: 'receiving_yards_after_catch',
  [`${USAGE_STAT_PREFIX}rec_epa`]: 'receiving_epa',
  [`${USAGE_STAT_PREFIX}pass_air_yd`]: 'passing_air_yards',
  [`${USAGE_STAT_PREFIX}pass_epa`]: 'passing_epa',
  [`${USAGE_STAT_PREFIX}pass_cpoe`]: 'passing_cpoe',
  [`${USAGE_STAT_PREFIX}rush_epa`]: 'rushing_epa'
};

/**
 * The shares nflverse reports for every player row, kept even at 0: a receiver with no targets in a
 * game has a 0% target share that his average must count.
 */
const ALWAYS_KEPT = new Set([
  `${USAGE_STAT_PREFIX}tgt_share`,
  `${USAGE_STAT_PREFIX}air_yd_share`,
  `${USAGE_STAT_PREFIX}wopr`
]);

/** Columns we require so a rename upstream fails loudly instead of scoring zeros. */
export const STATS_REQUIRED_COLUMNS = [
  'player_id',
  'player_display_name',
  'position',
  'season',
  'week',
  'season_type',
  'team',
  'opponent_team',
  'completions',
  'attempts',
  'passing_yards',
  'passing_tds',
  'passing_interceptions',
  'carries',
  'rushing_yards',
  'rushing_tds',
  'receptions',
  'targets',
  'receiving_yards',
  'receiving_tds',
  'fumbles_lost_total',
  'fg_made',
  'pat_made',
  'fantasy_points',
  'fantasy_points_ppr'
] as const;

export interface NflverseStatLine extends StatLine {
  /** The usage stats (`NFLVERSE_USAGE`), apart from the scoring `stats`. */
  usage: StatMap;
  gsisId: string;
  name: string;
  position: string | null;
  seasonType: 'regular' | 'post';
  opponent: string | null;
  /** nflverse's own standard-scoring total (pass TD 4, INT -2, fumble lost -2). For validation only. */
  fantasyPoints: number;
  /** nflverse's own full-PPR total. For validation only. */
  fantasyPointsPpr: number;
}

export function mapNflverseStats(row: CsvRow): StatMap {
  const stats: StatMap = { gp: 1 };
  for (const [key, columns] of Object.entries(NFLVERSE_TO_SLEEPER)) {
    let total = 0;
    for (const column of columns) total += csvNumber(row, column) ?? 0;
    if (total !== 0) stats[key] = Math.round(total * 1000) / 1000;
  }
  return stats;
}

/**
 * A row's usage stats: the shares always (0 when missing), the rest only when reported and nonzero.
 * Rounded to 4 decimals. A file without the usage columns (an older season) yields only the shares.
 */
export function mapNflverseUsage(row: CsvRow): StatMap {
  const usage: StatMap = {};
  for (const [key, column] of Object.entries(NFLVERSE_USAGE)) {
    const value = csvNumber(row, column);
    if (ALWAYS_KEPT.has(key)) usage[key] = Math.round((value ?? 0) * 10_000) / 10_000;
    else if (value !== undefined && value !== 0) usage[key] = Math.round(value * 10_000) / 10_000;
  }
  return usage;
}

/**
 * Parses `stats_player_week_{season}.csv`. `playerId` is the Sleeper id when the crosswalk knows
 * the player, otherwise the gsis id (so nothing is dropped; `crosswalk.unmappedGsis` reports them).
 */
export function parseNflverseWeeklyStats(csv: string, crosswalk?: IdCrosswalk): NflverseStatLine[] {
  const rows = parseCsvObjects(csv, STATS_REQUIRED_COLUMNS, 'nflverse stats_player_week');
  const lines: NflverseStatLine[] = [];
  for (const row of rows) {
    const gsisId = csvValue(row, 'player_id');
    const season = csvNumber(row, 'season');
    const week = csvNumber(row, 'week');
    if (!gsisId || season === undefined || week === undefined) continue;
    const team = toSleeperTeam(csvValue(row, 'team'));
    const line: NflverseStatLine = {
      playerId: crosswalk?.toSleeper(gsisId) ?? gsisId,
      gsisId,
      name: csvValue(row, 'player_display_name') ?? gsisId,
      position: csvValue(row, 'position') ?? null,
      season,
      week,
      seasonType: csvValue(row, 'season_type') === 'REG' ? 'regular' : 'post',
      opponent: toSleeperTeam(csvValue(row, 'opponent_team')),
      stats: mapNflverseStats(row),
      usage: mapNflverseUsage(row),
      fantasyPoints: csvNumber(row, 'fantasy_points') ?? 0,
      fantasyPointsPpr: csvNumber(row, 'fantasy_points_ppr') ?? 0
    };
    if (team) line.team = team;
    lines.push(line);
  }
  return lines;
}
