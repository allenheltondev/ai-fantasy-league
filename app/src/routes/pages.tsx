/**
 * The league shell (#178): the frame of every league page (its heading, live notices, and the teams
 * its avatars come from), and the redirects that keep section URLs from before it working.
 */

import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useParams } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../api/league';
import { CreateLeagueWizard } from '../features/create/CreateLeagueWizard';
import { MyLeaguesPage } from '../features/leagues/MyLeaguesPage';
import { pageName } from '../layout/pageTitle';
import { useLoad } from '../lib/useLoad';
import { LoadingSkeleton } from '../motion/decor';
import { supportsViewTransitions } from '../motion/pageTransition';
import { PlayerCardProvider } from '../players/PlayerLink';
import { LeagueNotifications } from '../realtime/LeagueNotifications';
import { useCurrentLeague } from './currentLeague';
import type { LeagueOutletContext } from './leagueContext';
import { forgetLastLeague, readLastLeague, rememberLastLeague } from './lastLeague';
import { leaguePath, movedSectionTarget, MOVED_SECTIONS } from './leagueRoutes';
import { LeagueTeamsContext } from './leagueTeams';

/** My Leagues (#86), at `/leagues`: always the list, never a jump into a league. */
export const HomePage = MyLeaguesPage;

/**
 * `/` (#212): straight back into the league you last opened, if you are still in it; otherwise
 * (none remembered, or it is gone or you left it, which forgets it) My Leagues.
 */
export function RootPage() {
  const api = useLeagueApi();
  const [last] = useState(readLastLeague);
  const leagues = useLoad(() => (last === null ? Promise.resolve(null) : api.listMyLeagues()), last ?? '');
  const member = leagues.data?.some((league) => league.id === last) ?? null;
  useEffect(() => {
    if (member === false) forgetLastLeague();
  }, [member]);
  if (last === null) return <MyLeaguesPage />;
  if (member === true) return <Navigate to={leaguePath(last, 'home')} replace />;
  // A list that failed to load says nothing about the league: My Leagues shows that error.
  if (member === null && leagues.error === null) return <LoadingSkeleton label="Opening your league…" />;
  return <MyLeaguesPage />;
}

/** The create-league wizard (#86). */
export const CreateLeaguePage = CreateLeagueWizard;

export function LeagueLayout() {
  const { leagueId = '' } = useParams();
  const { pathname } = useLocation();
  // The shell reads the league (its name, phase, your team, and every team's avatar) once, for
  // the side nav too; each section loads (and reports errors for) its own data.
  const current = useCurrentLeague();
  const state = current?.state ?? null;
  const data = state?.data ?? null;
  const yourTeamId = data?.yourTeam?.id ?? null;
  const opened = data !== null;
  // A league that loaded is one you can open: `/` comes back to it (#212).
  useEffect(() => {
    if (opened) rememberLastLeague(leagueId);
  }, [leagueId, opened]);
  // The top bar names the league and the side nav the page, so the page's one h1 is for screen
  // readers only (#212): named after the page, as its tab is.
  const heading = pageName(pathname, {
    commissioner: data?.youAreCommissioner === true,
    teams: data?.teams
  }).heading;
  const context: LeagueOutletContext = {
    yourTeamId,
    phase: data?.phase ?? null,
    state: data,
    reloadLeague: state?.reload ?? (() => undefined)
  };
  return (
    <LeagueTeamsContext.Provider value={data?.teams ?? []}>
      {/* Any player name in the league opens his card (PlayerLink). */}
      <PlayerCardProvider leagueId={leagueId}>
        <h1 className="sr-only">{heading}</h1>
        <LeagueNotifications leagueId={leagueId} yourTeamId={yourTeamId} />
        {/* The draft room sizes itself to this column, not the whole screen (#173). Browsers with
            view transitions cross-fade on section clicks; the rest get a quick rise-in. */}
        <div
          key={pathname}
          data-room-bounds
          className={supportsViewTransitions() ? undefined : 'motion-page'}
        >
          <Outlet context={context} />
        </div>
      </PlayerCardProvider>
    </LeagueTeamsContext.Provider>
  );
}

/** A section URL from before #178 (a bookmark, a sent notification): on to where it lives now. */
export function MovedSection({ section }: { section: keyof typeof MOVED_SECTIONS }) {
  const { search } = useLocation();
  return <Navigate to={`../${movedSectionTarget(section, search)}`} replace />;
}

export function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      description="That page does not exist."
      action={<Link to="/leagues">Back to My Leagues</Link>}
    />
  );
}

/** An index route that forwards to its first page, keeping the query. */
export function RedirectTo({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}
