import {
  csvNumber,
  csvValue,
  parseCsvObjects,
  toSleeperTeam,
  type ScheduledGame,
  type StatMap
} from '@fantasy/data';

/**
 * Team names for DEF players (Sleeper's DEF player id is the team code, and its name is the franchise).
 */
export const TEAM_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  ARI: ['Arizona', 'Cardinals'],
  ATL: ['Atlanta', 'Falcons'],
  BAL: ['Baltimore', 'Ravens'],
  BUF: ['Buffalo', 'Bills'],
  CAR: ['Carolina', 'Panthers'],
  CHI: ['Chicago', 'Bears'],
  CIN: ['Cincinnati', 'Bengals'],
  CLE: ['Cleveland', 'Browns'],
  DAL: ['Dallas', 'Cowboys'],
  DEN: ['Denver', 'Broncos'],
  DET: ['Detroit', 'Lions'],
  GB: ['Green Bay', 'Packers'],
  HOU: ['Houston', 'Texans'],
  IND: ['Indianapolis', 'Colts'],
  JAX: ['Jacksonville', 'Jaguars'],
  KC: ['Kansas City', 'Chiefs'],
  LAC: ['Los Angeles', 'Chargers'],
  LAR: ['Los Angeles', 'Rams'],
  LV: ['Las Vegas', 'Raiders'],
  MIA: ['Miami', 'Dolphins'],
  MIN: ['Minnesota', 'Vikings'],
  NE: ['New England', 'Patriots'],
  NO: ['New Orleans', 'Saints'],
  NYG: ['New York', 'Giants'],
  NYJ: ['New York', 'Jets'],
  PHI: ['Philadelphia', 'Eagles'],
  PIT: ['Pittsburgh', 'Steelers'],
  SEA: ['Seattle', 'Seahawks'],
  SF: ['San Francisco', '49ers'],
  TB: ['Tampa Bay', 'Buccaneers'],
  TEN: ['Tennessee', 'Titans'],
  WAS: ['Washington', 'Commanders']
};

/** Columns of nflverse `stats_team_week_{season}.csv` that the DEF derivation reads. */
export const TEAM_STATS_REQUIRED_COLUMNS = [
  'season',
  'week',
  'team',
  'season_type',
  'opponent_team',
  'def_sacks',
  'def_interceptions',
  'fumble_recovery_opp',
  'def_tds',
  'special_teams_tds',
  'def_safeties',
  'passing_yards',
  'rushing_yards'
] as const;

/**
 * How DEF stat lines are derived. Recorded in each archive's manifest.
 */
export const DEFENSE_METHOD =
  'DEF lines: pts_allow = the opponent final score from the nflverse schedule. With nflverse ' +
  'stats_team_week (release "stats_team"): sack = def_sacks, int = def_interceptions, fum_rec = ' +
  'fumble_recovery_opp, def_td = def_tds, def_st_td = special_teams_tds, safe = def_safeties, blk_kick = ' +
  "def_punt_blocks + def_fg_blocks + def_pat_blocks, def_2pt = def_2pt_made, yds_allow = the opponent's " +
  'passing_yards + sack_yards_lost + rushing_yards. Without that file only pts_allow is set.';

type TeamWeekKey = `${number}:${string}`;

/** Team → week → the team's own stat row (Sleeper team codes). */
function indexTeamRows(csv: string, season: number): Map<TeamWeekKey, Record<string, string>> {
  const rows = parseCsvObjects(csv, TEAM_STATS_REQUIRED_COLUMNS, 'nflverse stats_team_week');
  const out = new Map<TeamWeekKey, Record<string, string>>();
  for (const row of rows) {
    if (csvNumber(row, 'season') !== season || csvValue(row, 'season_type') !== 'REG') continue;
    const team = toSleeperTeam(csvValue(row, 'team'));
    const week = csvNumber(row, 'week');
    if (team && week !== undefined) out.set(`${week}:${team}`, row);
  }
  return out;
}

const num = (row: Record<string, string> | undefined, column: string): number =>
  row ? (csvNumber(row, column) ?? 0) : 0;

/**
 * Derives each team defense's weekly stat line (Sleeper keys) for the regular season: points allowed from
 * the schedule's final scores, plus sacks, takeaways, touchdowns, safeties, blocks, and yards allowed from
 * nflverse team stats when they are supplied. Only final games produce a line. `pts_allow` is always
 * present (even at 0) so the points-allowed tier applies.
 */
export function deriveDefenseLines(
  schedule: readonly ScheduledGame[],
  season: number,
  teamStatsCsv?: string
): Map<number, Map<string, StatMap>> {
  const rows = teamStatsCsv ? indexTeamRows(teamStatsCsv, season) : undefined;
  const out = new Map<number, Map<string, StatMap>>();
  for (const game of schedule) {
    if (game.season !== season || game.seasonType !== 'regular' || game.status !== 'final') continue;
    const week = out.get(game.week) ?? new Map<string, StatMap>();
    out.set(game.week, week);
    for (const [team, opponent, allowed] of [
      [game.homeTeam, game.awayTeam, game.awayScore ?? 0],
      [game.awayTeam, game.homeTeam, game.homeScore ?? 0]
    ] as const) {
      const line: StatMap = { gp: 1, pts_allow: allowed };
      if (rows) {
        const own = rows.get(`${game.week}:${team}`);
        const opp = rows.get(`${game.week}:${opponent}`);
        const set = (key: string, value: number): void => {
          if (value !== 0) line[key] = Math.round(value * 1000) / 1000;
        };
        set('sack', num(own, 'def_sacks'));
        set('int', num(own, 'def_interceptions'));
        set('fum_rec', num(own, 'fumble_recovery_opp'));
        set('def_td', num(own, 'def_tds'));
        set('def_st_td', num(own, 'special_teams_tds'));
        set('safe', num(own, 'def_safeties'));
        set('blk_kick', num(own, 'def_punt_blocks') + num(own, 'def_fg_blocks') + num(own, 'def_pat_blocks'));
        set('def_2pt', num(own, 'def_2pt_made'));
        if (opp) {
          line.yds_allow =
            num(opp, 'passing_yards') + num(opp, 'sack_yards_lost') + num(opp, 'rushing_yards');
        }
      }
      week.set(team, line);
    }
  }
  return out;
}
