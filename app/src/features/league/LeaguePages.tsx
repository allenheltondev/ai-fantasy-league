import { HelpBar, PlayoffsHelp } from '../help/PageHelp';
import { useState } from 'react';
import { useParams } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { MatchupsCard } from '../home/DashboardCards';
import { MAX_MOVES, MORE_MOVES, MOVES_PAGE, MoveBoard } from '../home/MoveBoard';
import { Transactions } from '../players/Transactions';
import { PlayoffsPanel } from '../season/PlayoffsPanel';

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
    <div data-testid="league-page-playoffs" className="space-y-4">
      <HelpBar>
        <PlayoffsHelp />
      </HelpBar>
      <PlayoffsPanel />
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
