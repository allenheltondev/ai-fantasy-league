import { NFL_TEAMS, type Player, type PlayerStatus, type Position } from './model.js';

/**
 * A small fixed player universe for tests and local dev until the Sleeper sync
 * (`@fantasy/data`) fills the `PLAYER#` partition. Teams and ranks are fixture
 * values, not current NFL facts. It deliberately includes shared last names,
 * suffixes, punctuation, nicknames, and team defenses to exercise name resolution.
 */

type Row = [
  id: string,
  first: string,
  last: string,
  team: string | null,
  position: Position,
  rank: number | null,
  aliases?: string[],
  status?: PlayerStatus
];

// prettier-ignore
const ROWS: Row[] = [
  ['fx-cmc', 'Christian', 'McCaffrey', 'SF', 'RB', 3, ['CMC']],
  ['fx-jallen', 'Josh', 'Allen', 'BUF', 'QB', 20],
  ['fx-mahomes', 'Patrick', 'Mahomes', 'KC', 'QB', 30],
  ['fx-jjefferson', 'Justin', 'Jefferson', 'MIN', 'WR', 2, ['JJ', 'Jets']],
  ['fx-chase', "Ja'Marr", 'Chase', 'CIN', 'WR', 1],
  ['fx-arsb', 'Amon-Ra', 'St. Brown', 'DET', 'WR', 6, ['ARSB', 'Sun God']],
  ['fx-ajbrown', 'A.J.', 'Brown', 'PHI', 'WR', 12, ['AJB']],
  ['fx-lamb', 'CeeDee', 'Lamb', 'DAL', 'WR', 4],
  ['fx-bijan', 'Bijan', 'Robinson', 'ATL', 'RB', 5],
  ['fx-bhall', 'Breece', 'Hall', 'NYJ', 'RB', 15],
  ['fx-kwalker', 'Kenneth', 'Walker III', 'SEA', 'RB', 40, ['K9']],
  ['fx-mhj', 'Marvin', 'Harrison Jr.', 'ARI', 'WR', 25, ['MHJ']],
  ['fx-kelce', 'Travis', 'Kelce', 'KC', 'TE', 45],
  ['fx-laporta', 'Sam', 'LaPorta', 'DET', 'TE', 50],
  ['fx-kyrenw', 'Kyren', 'Williams', 'LAR', 'RB', 18],
  ['fx-javontew', 'Javonte', 'Williams', 'DAL', 'RB', 60],
  ['fx-jamesonw', 'Jameson', 'Williams', 'DET', 'WR', 55],
  ['fx-mikew', 'Mike', 'Williams', 'PIT', 'WR', 150],
  ['fx-jtaylor', 'Jonathan', 'Taylor', 'IND', 'RB', 10, ['JT']],
  ['fx-swift', "D'Andre", 'Swift', 'CHI', 'RB', 70],
  ['fx-metcalf', 'DK', 'Metcalf', 'PIT', 'WR', 35, ['D.K. Metcalf']],
  ['fx-jjacobs', 'Josh', 'Jacobs', 'GB', 'RB', 14],
  ['fx-tyhill', 'Tyreek', 'Hill', 'MIA', 'WR', 28, ['Cheetah']],
  ['fx-taysom', 'Taysom', 'Hill', 'NO', 'TE', 210],
  ['fx-lamar', 'Lamar', 'Jackson', 'BAL', 'QB', 16],
  ['fx-hurts', 'Jalen', 'Hurts', 'PHI', 'QB', 22],
  ['fx-butker', 'Harrison', 'Butker', 'KC', 'K', 150],
  ['fx-tucker', 'Justin', 'Tucker', null, 'K', null, [], 'inactive'],
  ['fx-def-sf', 'San Francisco', '49ers', 'SF', 'DEF', 120, ['SF', 'Niners', '49ers', 'San Francisco D/ST']],
  ['fx-def-buf', 'Buffalo', 'Bills', 'BUF', 'DEF', 125, ['BUF', 'Bills', 'Buffalo D/ST']]
];

export const FIXTURE_UPDATED_AT = '2026-09-01T00:00:00.000Z';

export const fixturePlayers: readonly Player[] = ROWS.map(
  ([id, firstName, lastName, team, position, rank, aliases = [], status = 'active']) => ({
    id,
    name: `${firstName} ${lastName}`,
    firstName,
    lastName,
    team,
    position,
    status,
    injuryStatus: null,
    aliases,
    rank,
    updatedAt: FIXTURE_UPDATED_AT
  })
);

/** Depth players per position, so a full 12-team draft never runs dry. */
const DEPTH: readonly [Position, number][] = [
  ['QB', 24],
  ['RB', 50],
  ['WR', 60],
  ['TE', 24],
  ['K', 20]
];

/**
 * `fixturePlayers` plus generated depth ("Reserve RB12") and a defense for every NFL team: a pool
 * deep enough for mock drafts in tests, local dev, and e2e. Ranks put depth players after the named
 * fixtures, interleaved by position.
 */
export const fixtureDraftPool: readonly Player[] = [
  ...fixturePlayers,
  ...DEPTH.flatMap(([position, count], p) =>
    Array.from({ length: count }, (_, i): Player => ({
      id: `fx-${position.toLowerCase()}-${i + 1}`,
      name: `Reserve ${position}${i + 1}`,
      firstName: 'Reserve',
      lastName: `${position}${i + 1}`,
      team: NFL_TEAMS[(i + p * 7) % NFL_TEAMS.length] as string,
      position,
      status: 'active',
      injuryStatus: null,
      aliases: [],
      rank: 200 + i * DEPTH.length + p,
      updatedAt: FIXTURE_UPDATED_AT
    }))
  ),
  ...NFL_TEAMS.filter((team) => team !== 'SF' && team !== 'BUF').map((team, i): Player => ({
    id: `fx-def-${team.toLowerCase()}`,
    name: `${team} Defense`,
    firstName: team,
    lastName: 'Defense',
    team,
    position: 'DEF',
    status: 'active',
    injuryStatus: null,
    aliases: [],
    rank: 130 + i,
    updatedAt: FIXTURE_UPDATED_AT
  }))
];
