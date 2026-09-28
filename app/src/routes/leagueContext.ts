import { useOutletContext } from 'react-router';

/** What the league layout shares with its sections (the viewer's team, once the state loads). */
export interface LeagueOutletContext {
  yourTeamId: string | null;
}

/** The viewer's team in the current league, or null (no seat, still loading, or outside a league). */
export function useYourTeamId(): string | null {
  return useOutletContext<LeagueOutletContext | undefined>()?.yourTeamId ?? null;
}
