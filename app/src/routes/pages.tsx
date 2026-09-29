/**
 * The league shell (#178): the frame of every league page (its name, live notices, and the teams
 * its avatars come from), and the redirects that keep section URLs from before it working.
 */

import { Link, Navigate, Outlet, useLocation, useParams } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { CreateLeagueWizard } from '../features/create/CreateLeagueWizard';
import { MyLeaguesPage } from '../features/leagues/MyLeaguesPage';
import { supportsViewTransitions } from '../motion/pageTransition';
import { PlayerCardProvider } from '../players/PlayerLink';
import { LeagueNotifications } from '../realtime/LeagueNotifications';
import { useCurrentLeague } from './currentLeague';
import type { LeagueOutletContext } from './leagueContext';
import { movedSectionTarget, MOVED_SECTIONS } from './leagueRoutes';
import { LeagueTeamsContext } from './leagueTeams';

/** My Leagues (#86). */
export const HomePage = MyLeaguesPage;

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
        {/* The draft room sizes itself to this column, not the whole screen (#173). */}
        <section aria-labelledby="league-title" className="space-y-4" data-room-bounds>
          <h1 id="league-title" className="text-2xl font-semibold">
            {data?.name ?? 'League'}
          </h1>
          <LeagueNotifications leagueId={leagueId} yourTeamId={yourTeamId} />
          {/* Browsers with view transitions cross-fade on section clicks; the rest get a quick rise-in. */}
          <div key={pathname} className={supportsViewTransitions() ? undefined : 'motion-page'}>
            <Outlet context={context} />
          </div>
        </section>
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
      action={<Link to="/">Back to My Leagues</Link>}
    />
  );
}

/** An index route that forwards to its first page, keeping the query. */
export function RedirectTo({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}
