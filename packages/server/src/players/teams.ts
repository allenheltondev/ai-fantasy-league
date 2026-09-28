import type { NFL_TEAMS } from './model.js';

type TeamCode = (typeof NFL_TEAMS)[number];

export interface TeamName {
  city: string;
  nickname: string;
  aliases?: string[];
}

/**
 * Team names for tagging news. The nickname alone is unambiguous ("Chiefs"); cities are not
 * ("New York", "Los Angeles"), so a city only counts together with the nickname.
 */
export const TEAM_NAMES: Readonly<Record<TeamCode, TeamName>> = {
  ARI: { city: 'Arizona', nickname: 'Cardinals' },
  ATL: { city: 'Atlanta', nickname: 'Falcons' },
  BAL: { city: 'Baltimore', nickname: 'Ravens' },
  BUF: { city: 'Buffalo', nickname: 'Bills' },
  CAR: { city: 'Carolina', nickname: 'Panthers' },
  CHI: { city: 'Chicago', nickname: 'Bears' },
  CIN: { city: 'Cincinnati', nickname: 'Bengals' },
  CLE: { city: 'Cleveland', nickname: 'Browns' },
  DAL: { city: 'Dallas', nickname: 'Cowboys' },
  DEN: { city: 'Denver', nickname: 'Broncos' },
  DET: { city: 'Detroit', nickname: 'Lions' },
  GB: { city: 'Green Bay', nickname: 'Packers' },
  HOU: { city: 'Houston', nickname: 'Texans' },
  IND: { city: 'Indianapolis', nickname: 'Colts' },
  JAX: { city: 'Jacksonville', nickname: 'Jaguars', aliases: ['Jags'] },
  KC: { city: 'Kansas City', nickname: 'Chiefs' },
  LAC: { city: 'Los Angeles', nickname: 'Chargers' },
  LAR: { city: 'Los Angeles', nickname: 'Rams' },
  LV: { city: 'Las Vegas', nickname: 'Raiders' },
  MIA: { city: 'Miami', nickname: 'Dolphins' },
  MIN: { city: 'Minnesota', nickname: 'Vikings' },
  NE: { city: 'New England', nickname: 'Patriots', aliases: ['Pats'] },
  NO: { city: 'New Orleans', nickname: 'Saints' },
  NYG: { city: 'New York', nickname: 'Giants' },
  NYJ: { city: 'New York', nickname: 'Jets' },
  PHI: { city: 'Philadelphia', nickname: 'Eagles' },
  PIT: { city: 'Pittsburgh', nickname: 'Steelers' },
  SEA: { city: 'Seattle', nickname: 'Seahawks' },
  SF: { city: 'San Francisco', nickname: '49ers', aliases: ['Niners'] },
  TB: { city: 'Tampa Bay', nickname: 'Buccaneers', aliases: ['Bucs'] },
  TEN: { city: 'Tennessee', nickname: 'Titans' },
  WAS: { city: 'Washington', nickname: 'Commanders' }
};

/** Names for a team code, or undefined for a code that is not a current team. */
export function teamName(code: string): TeamName | undefined {
  return (TEAM_NAMES as Readonly<Record<string, TeamName>>)[code];
}
