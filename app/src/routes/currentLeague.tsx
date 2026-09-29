import { createContext, useContext, type ReactNode } from 'react';
import { useLeagueApi } from '../api/league';
import type { LeagueState } from '../api/types';
import { useLoad, type Loaded } from '../lib/useLoad';

/**
 * The league the URL is in, read once for the whole shell (#178): the side nav needs its phase,
 * the header its name, and the league layout its teams and your seat.
 */
export interface CurrentLeague {
  leagueId: string;
  state: Loaded<LeagueState>;
}

const CurrentLeagueContext = createContext<CurrentLeague | null>(null);

export function CurrentLeagueProvider({
  leagueId,
  children
}: {
  leagueId: string | null;
  children: ReactNode;
}) {
  const api = useLeagueApi();
  // Tagged with the league it was read for, so a switch never shows the last league's state.
  const state = useLoad<{ leagueId: string; state: LeagueState } | null>(
    () =>
      leagueId === null
        ? Promise.resolve(null)
        : api.getLeagueState(leagueId).then((read) => ({ leagueId, state: read })),
    leagueId ?? ''
  );
  const value =
    leagueId === null
      ? null
      : {
          leagueId,
          // Switching leagues shows nothing of the last one while the next loads.
          state: { ...state, data: state.data?.leagueId === leagueId ? state.data.state : null }
        };
  return <CurrentLeagueContext.Provider value={value}>{children}</CurrentLeagueContext.Provider>;
}

/** The league in the URL and its state, or null outside a league. */
export function useCurrentLeague(): CurrentLeague | null {
  return useContext(CurrentLeagueContext);
}
