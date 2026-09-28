/**
 * Route placeholders. Each page is filled in by its own feature issue; the
 * shell only fixes the URLs so links and deep links are stable from day one.
 */

import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../api/league';
import { useLoad } from '../lib/useLoad';
import { CreateLeagueWizard } from '../features/create/CreateLeagueWizard';
import { LeagueHomePage } from '../features/home/LeagueDashboard';
import { MyLeaguesPage } from '../features/leagues/MyLeaguesPage';
import { MatchupPage } from '../features/season/MatchupPage';
import { RosterPage } from '../features/season/RosterPage';
import { StandingsPage } from '../features/season/StandingsPage';
import { PlayersPage } from '../features/players/PlayersPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { TradesPage } from '../trades/TradesPage';
import { supportsViewTransitions, transitionClick } from '../motion/pageTransition';
import { LeagueNotifications } from '../realtime/LeagueNotifications';
import { TradesBadge } from '../notifications/TradesBadge';
import type { LeagueOutletContext } from './leagueContext';

export const LEAGUE_SECTIONS = [
  { path: 'home', label: 'Home' },
  { path: 'draft', label: 'Draft' },
  { path: 'roster', label: 'Roster' },
  { path: 'matchup', label: 'Matchup' },
  { path: 'standings', label: 'Standings' },
  { path: 'players', label: 'Players' },
  { path: 'trades', label: 'Trades' },
  { path: 'chat', label: 'Chat' },
  { path: 'settings', label: 'Settings' }
] as const;

export type LeagueSectionPath = (typeof LEAGUE_SECTIONS)[number]['path'];

/** My Leagues (#86). */
export const HomePage = MyLeaguesPage;

/** The create-league wizard (#86). */
export const CreateLeaguePage = CreateLeagueWizard;

export function LeagueLayout() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The name only; each section loads (and reports errors for) its own data.
  const state = useLoad(() => api.getLeagueState(leagueId), leagueId);
  const yourTeamId = state.data?.yourTeam?.id ?? null;
  // Keep the current section in view when the row scrolls (a deep link to Settings on a phone).
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);
  return (
    <section aria-labelledby="league-title" className="space-y-4">
      <h1 id="league-title" className="text-2xl font-semibold">
        {state.data?.name ?? 'League'}
      </h1>
      {/* On a phone the sections scroll sideways in one row, fading at the edges; wider, they wrap. */}
      <nav
        ref={nav}
        aria-label="League sections"
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 pb-2 [mask-image:linear-gradient(to_right,transparent,#000_1rem,#000_calc(100%-1rem),transparent)] [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:gap-2 sm:overflow-visible sm:px-0 sm:[mask-image:none]"
      >
        {LEAGUE_SECTIONS.map((section) => (
          <NavLink
            key={section.path}
            to={section.path}
            onClick={transitionClick(() => navigate(section.path))}
            className={({ isActive }) =>
              `inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'bg-primary-100 text-primary-800' : 'text-muted-foreground hover:text-foreground'
              }`
            }
          >
            {section.label}
            {section.path === 'trades' ? <TradesBadge leagueId={leagueId} /> : null}
          </NavLink>
        ))}
      </nav>
      <LeagueNotifications leagueId={leagueId} yourTeamId={yourTeamId} />
      {/* Browsers with view transitions cross-fade on section clicks; the rest get a quick rise-in. */}
      <div key={pathname} className={supportsViewTransitions() ? undefined : 'motion-page'}>
        <Outlet context={{ yourTeamId } satisfies LeagueOutletContext} />
      </div>
    </section>
  );
}

export function LeagueSectionPage({ section }: { section: LeagueSectionPath }) {
  if (section === 'home') return <LeagueHomePage />;
  if (section === 'settings') return <SettingsPage />;
  if (section === 'roster') return <RosterPage />;
  if (section === 'matchup') return <MatchupPage />;
  if (section === 'standings') return <StandingsPage />;
  if (section === 'players') return <PlayersPage />;
  if (section === 'trades') return <TradesPage />;
  const label = LEAGUE_SECTIONS.find((s) => s.path === section)?.label ?? section;
  return (
    <div data-testid={`league-section-${section}`}>
      <h2 className="text-xl font-semibold">{label}</h2>
      <p className="text-muted-foreground">Coming soon.</p>
    </div>
  );
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
