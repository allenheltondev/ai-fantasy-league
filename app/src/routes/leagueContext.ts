import { useOutletContext } from 'react-router';
import type { LeagueState, Phase } from '../api/types';

/** What the league layout shares with its sections, once the league's state loads. */
export interface LeagueOutletContext {
  /** The viewer's team, or null (no seat, or still loading). */
  yourTeamId: string | null;
  phase: Phase | null;
  state: LeagueState | null;
  /** Read the league again: after a change the layout shows (a team's name or avatar). */
  reloadLeague: () => void;
}

/** The viewer's team in the current league, or null (no seat, still loading, or outside a league). */
export function useYourTeamId(): string | null {
  return useOutletContext<LeagueOutletContext | undefined>()?.yourTeamId ?? null;
}

/** The league layout's context, or null outside a league (a page rendered on its own in a test). */
export function useLeagueOutlet(): LeagueOutletContext | null {
  return useOutletContext<LeagueOutletContext | undefined>() ?? null;
}
