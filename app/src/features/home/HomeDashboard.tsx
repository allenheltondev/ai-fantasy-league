import { useState } from 'react';
import { Link } from 'react-router';
import type { MyLeague, Phase } from '../../api/types';
import { LeagueDashboard } from './LeagueDashboard';

/** The league the home page last showed, per browser. */
export const HOME_LEAGUE_KEY = 'fantasy:home-league';

/** In-season leagues first, then drafting, then the rest (setup and complete). */
const PHASE_ORDER: Record<Phase, number> = {
  regular_season: 0,
  playoffs: 0,
  drafting: 1,
  setup: 2,
  complete: 3
};

/** The league to show: the one picked last time if it is still yours, else the liveliest. */
export function pickLeague(leagues: readonly MyLeague[], remembered: string | null): MyLeague | null {
  const kept = leagues.find((l) => l.id === remembered);
  if (kept !== undefined) return kept;
  return [...leagues].sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase])[0] ?? null;
}

function readRemembered(): string | null {
  try {
    return localStorage.getItem(HOME_LEAGUE_KEY);
  } catch {
    return null;
  }
}

/**
 * The site home page's dashboard (#166): one league's dashboard, with a league picker when you are
 * in several. The choice is remembered in this browser.
 */
export function HomeDashboard({ leagues }: { leagues: readonly MyLeague[] }) {
  const [chosen, setChosen] = useState(readRemembered);
  // The home page only shows this with at least one league.
  const league = pickLeague(leagues, chosen) as MyLeague;
  const choose = (id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(HOME_LEAGUE_KEY, id);
    } catch {
      // Blocked storage only means the pick is not remembered.
    }
  };
  return (
    <section aria-labelledby="dashboard-title" className="space-y-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 id="dashboard-title" className="min-w-0 break-words text-xl font-semibold">
          <Link to={`/leagues/${encodeURIComponent(league.id)}`} className="hover:underline">
            {league.name}
          </Link>
        </h2>
        {leagues.length > 1 && (
          <div
            role="tablist"
            aria-label="Choose a league"
            className="flex max-w-full gap-1 overflow-x-auto [scrollbar-width:none]"
          >
            {leagues.map((l) => (
              <button
                key={l.id}
                type="button"
                role="tab"
                aria-selected={l.id === league.id}
                aria-controls="home-dashboard"
                onClick={() => choose(l.id)}
                className={`min-h-11 shrink-0 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors ${
                  l.id === league.id
                    ? 'bg-primary-100 text-primary-800'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div id="home-dashboard" role={leagues.length > 1 ? 'tabpanel' : undefined} aria-label={league.name}>
        <LeagueDashboard key={league.id} leagueId={league.id} />
      </div>
    </section>
  );
}
