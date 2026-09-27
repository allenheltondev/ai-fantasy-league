/** The 32 current team codes as Sleeper writes them. */
export const SLEEPER_TEAMS = [
  'ARI',
  'ATL',
  'BAL',
  'BUF',
  'CAR',
  'CHI',
  'CIN',
  'CLE',
  'DAL',
  'DEN',
  'DET',
  'GB',
  'HOU',
  'IND',
  'JAX',
  'KC',
  'LAC',
  'LAR',
  'LV',
  'MIA',
  'MIN',
  'NE',
  'NO',
  'NYG',
  'NYJ',
  'PHI',
  'PIT',
  'SEA',
  'SF',
  'TB',
  'TEN',
  'WAS'
] as const;

const ALIASES: Record<string, string> = {
  // nflverse
  LA: 'LAR',
  STL: 'LAR',
  SD: 'LAC',
  OAK: 'LV',
  // dynastyprocess / PFR style
  KCC: 'KC',
  GBP: 'GB',
  NOS: 'NO',
  NEP: 'NE',
  SFO: 'SF',
  TBB: 'TB',
  LVR: 'LV',
  JAC: 'JAX',
  SDC: 'LAC',
  RAM: 'LAR',
  WSH: 'WAS'
};

/**
 * Maps any source's team code to Sleeper's. Free agents (`FA`, `FA*`, empty) map to null.
 * Relocated franchises map to their current code, since fantasy rosters care about the franchise.
 */
export function toSleeperTeam(code: string | null | undefined): string | null {
  const c = code?.trim().toUpperCase();
  if (!c || c === 'NA' || c.startsWith('FA')) return null;
  return ALIASES[c] ?? c;
}
