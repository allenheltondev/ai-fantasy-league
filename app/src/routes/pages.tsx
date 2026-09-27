/**
 * Route placeholders. Each page is filled in by its own feature issue; the
 * shell only fixes the URLs so links and deep links are stable from day one.
 */

import { Link, NavLink, Outlet, useParams } from 'react-router';
import { Button, EmptyState } from '@readysetcloud/ui';

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

export function HomePage() {
  return (
    <section aria-labelledby="home-title" className="space-y-6">
      <h1 id="home-title" className="text-2xl font-semibold">
        My Leagues
      </h1>
      <EmptyState
        title="No leagues yet"
        description="Create a league, invite friends, and fill the other seats with AI managers."
        action={
          <Link to="/leagues/new">
            <Button variant="primary">Create a league</Button>
          </Link>
        }
      />
    </section>
  );
}

export function CreateLeaguePage() {
  return (
    <section aria-labelledby="create-title" className="space-y-4">
      <h1 id="create-title" className="text-2xl font-semibold">
        Create League
      </h1>
      <p className="text-muted-foreground">League setup is coming soon.</p>
    </section>
  );
}

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
