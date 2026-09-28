/**
 * Route placeholders. Each page is filled in by its own feature issue; the
 * shell only fixes the URLs so links and deep links are stable from day one.
 */

import { Link, NavLink, Outlet, useParams } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { CreateLeagueWizard } from '../features/create/CreateLeagueWizard';
import { MyLeaguesPage } from '../features/leagues/MyLeaguesPage';
import { MatchupPage } from '../features/season/MatchupPage';
import { RosterPage } from '../features/season/RosterPage';
import { StandingsPage } from '../features/season/StandingsPage';
import { PlayersPage } from '../features/players/PlayersPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { TradesPage } from '../trades/TradesPage';

export const LEAGUE_SECTIONS = [
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
  return (
    <section aria-labelledby="league-title" className="space-y-4">
      <h1 id="league-title" className="text-2xl font-semibold">
        League <span className="font-mono text-base text-muted-foreground">{leagueId}</span>
      </h1>
      <nav aria-label="League sections" className="flex flex-wrap gap-2 border-b border-border pb-2">
        {LEAGUE_SECTIONS.map((section) => (
          <NavLink
            key={section.path}
            to={section.path}
            className={({ isActive }) =>
              `rounded-md px-3 py-2 text-sm font-medium ${
                isActive ? 'bg-primary-100 text-primary-800' : 'text-muted-foreground hover:text-foreground'
              }`
            }
          >
            {section.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </section>
  );
}

export function LeagueSectionPage({ section }: { section: LeagueSectionPath }) {
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
