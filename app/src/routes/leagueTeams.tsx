import { createContext, useContext } from 'react';
import type { LeagueTeam } from '../api/types';

/**
 * The league's teams as the league layout last read them (get_league_state), for the pieces that
 * draw a team without loading it themselves: the avatar a person picked for their team (#178).
 */
export const LeagueTeamsContext = createContext<readonly LeagueTeam[]>([]);

export function useLeagueTeams(): readonly LeagueTeam[] {
  return useContext(LeagueTeamsContext);
}

/** The avatar seed a person picked for `teamId`, or null (an AI's team, none picked, or unknown). */
export function useTeamAvatarSeed(teamId: string | null | undefined): string | null {
  const teams = useLeagueTeams();
  if (teamId === null || teamId === undefined) return null;
  return teams.find((t) => t.id === teamId)?.avatarSeed ?? null;
}

/** A team's picture: its AI manager's avatar, else the one its person picked, else null. */
export function teamAvatarSeed(team: Pick<LeagueTeam, 'avatarSeed' | 'manager'>): string | null {
  return team.manager?.avatarSeed ?? team.avatarSeed ?? null;
}

/** A fresh avatar seed for the reroll button: 10 characters the server's seed rules accept. */
export function rollTeamAvatarSeed(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let seed = '';
  for (let i = 0; i < 10; i++) seed += alphabet[Math.floor(random() * alphabet.length)];
  return seed;
}
