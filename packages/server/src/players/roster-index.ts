import { listInSeason } from '../season/lineups.js';
import type { League, Repos, Team } from '../repos/types.js';

/**
 * Who rosters whom, across every in-season league: the same lookup the agent router's player
 * rules use (`leagueRosterIndex`: two GSI2 phase queries plus one team query per league). The
 * game-day injury job reads it to scope ESPN's report to rostered players, and the notification
 * consumer to find the managers a player's news reaches (#200).
 */
export interface RosterIndexEntry {
  league: League;
  teams: Team[];
}

/** Every in-season league with its teams. */
export async function inSeasonRosters(repos: Pick<Repos, 'leagues' | 'teams'>): Promise<RosterIndexEntry[]> {
  const leagues = await listInSeason(repos);
  return Promise.all(leagues.map(async (league) => ({ league, teams: await repos.teams.list(league.id) })));
}

/** Every player on some in-season roster. */
export function rosteredPlayerIds(index: readonly RosterIndexEntry[]): Set<string> {
  return new Set(index.flatMap((entry) => entry.teams.flatMap((team) => team.roster)));
}

/** The teams rostering `playerId`, with their leagues. */
export function teamsRostering(
  index: readonly RosterIndexEntry[],
  playerId: string
): { league: League; team: Team }[] {
  return index.flatMap(({ league, teams }) =>
    teams.filter((team) => team.roster.includes(playerId)).map((team) => ({ league, team }))
  );
}
