import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import type { LeagueOutletContext } from '../../routes/leagueContext';
import { leagueTabs } from '../../routes/leagueRoutes';
import { MatchupsCard } from '../home/DashboardCards';
import { MAX_MOVES, MORE_MOVES, MOVES_PAGE, MoveBoard } from '../home/MoveBoard';
import { Transactions } from '../players/Transactions';
import { HistoryPanel } from '../season/HistoryPanel';
import { PlayoffsPanel } from '../season/PlayoffsPanel';

/** Tab-row link: a 44px target, the current page tinted. */
const TAB = ({ isActive }: { isActive: boolean }) =>
  `inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-primary-100 text-primary-800' : 'text-muted-foreground hover:text-foreground'
  }`;

/**
 * League (#178): everything about the league as a whole, one tab per page. On a phone the tabs are
 * one row that scrolls sideways, fading at the edges; the current tab scrolls into view.
 */
export function LeagueSectionLayout() {
  const context = useOutletContext<LeagueOutletContext | undefined>();
  const { pathname } = useLocation();
  const row = useRef<HTMLElement>(null);
  useEffect(() => {
    row.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);
  return (
    <div data-testid="league-section-league" className="space-y-4">
      <h2 className="text-xl font-semibold">League</h2>
      <nav
        ref={row}
        aria-label="League pages"
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 pb-2 [mask-image:linear-gradient(to_right,transparent,#000_1rem,#000_calc(100%-1rem),transparent)] [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:[mask-image:none]"
      >
        {leagueTabs(context?.phase ?? null).map((tab) => (
          <NavLink key={tab.path} to={tab.path} className={TAB}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet context={context} />
    </div>
  );
}

/** League › Scoreboard: every matchup this week. */
export function ScoreboardPage() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getLeagueDashboard(leagueId), leagueId, 30_000);
  let body;
  if (loaded.data === null) {
    body = loaded.error ? (
      <ApiErrorAlert error={loaded.error} />
    ) : (
      <LoadingSkeleton label="Loading this week's matchups…" rows={4} />
    );
  } else if (loaded.data.draft !== null || loaded.data.matchups.length === 0) {
    body = <EmptyState title="No matchups yet" description="Matchups start once the draft is done." />;
  } else {
    body = (
      <MatchupsCard
        leagueId={leagueId}
        week={loaded.data.week}
        matchups={loaded.data.matchups}
        yourTeamId={loaded.data.yourTeamId}
      />
    );
  }
  return <div data-testid="league-page-scoreboard">{body}</div>;
}

/** League › Playoffs. */
export function PlayoffsPage() {
  return (
    <div data-testid="league-page-playoffs">
      <PlayoffsPanel />
    </div>
  );
}

/** League › History. */
export function HistoryPage() {
  return (
    <div data-testid="league-page-history">
      <HistoryPanel />
    </div>
  );
}

/** League › Transactions: the move board (trades included), then every roster move, page by page. */
export function TransactionsPage() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const [moves, setMoves] = useState(MOVES_PAGE);
  const loaded = useLoad(() => api.getLeagueDashboard(leagueId, { moves }), `${leagueId}:${moves}`);
  const data = loaded.data;
  return (
    <div data-testid="league-page-transactions" className="space-y-4">
      {data === null ? (
        loaded.error ? (
          <ApiErrorAlert error={loaded.error} />
        ) : (
          <LoadingSkeleton label="Loading the move board…" rows={4} />
        )
      ) : (
        <MoveBoard
          leagueId={leagueId}
          moves={data.moves}
          hasMore={data.hasMoreMoves && data.moves.length < MAX_MOVES}
          yourTeamId={data.yourTeamId}
          loadingMore={loaded.loading && data.moves.length < moves}
          onShowMore={() => setMoves((n) => Math.min(n + MORE_MOVES, MAX_MOVES))}
        />
      )}
      <Transactions leagueId={leagueId} refreshKey={0} />
    </div>
  );
}
