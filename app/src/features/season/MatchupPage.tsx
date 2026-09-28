import { useParams } from 'react-router';
import { EmptyState, LoadingPage, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { MatchupLineup, MatchupSide } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { isStarter } from './slots';

/** How often live scores refresh. The server recomputes them from the latest stats on every read. */
export const MATCHUP_POLL_MS = 30_000;

const STATUS_LABEL = { scheduled: 'Upcoming', in_progress: 'Live', final: 'Final' } as const;

/** The Matchup section (#58): both lineups side by side with live scores. */
export function MatchupPage() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getMatchup(leagueId), leagueId, MATCHUP_POLL_MS);

  let body;
  if (loaded.data === null) {
    body = loaded.error ? (
      <ApiErrorAlert error={loaded.error} />
    ) : (
      <LoadingPage text="Loading your matchup…" />
    );
  } else if (loaded.data.matchup === null || loaded.data.lineups === null) {
    body = (
      <EmptyState
        title={`No matchup in week ${loaded.data.week}`}
        description="Check back once the schedule is set."
      />
    );
  } else {
    const { matchup, lineups } = loaded.data;
    body = (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-muted-foreground">
          Week {loaded.data.week}
          <StatusBadge tone={matchup.status === 'in_progress' ? 'success' : 'neutral'}>
            {STATUS_LABEL[matchup.status]}
          </StatusBadge>
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Side side={matchup.home} lineup={lineups.home} />
          <Side side={matchup.away} lineup={lineups.away} />
        </div>
      </div>
    );
  }
  return (
    <div data-testid="league-section-matchup" className="space-y-4">
      <h2 className="text-xl font-semibold">Matchup</h2>
      {body}
    </div>
  );
}

function Side({ side, lineup }: { side: MatchupSide; lineup: MatchupLineup }) {
  return (
    <section aria-label={side.teamName} className="rounded-lg border border-border p-4">
      <h3 className="flex items-baseline justify-between font-semibold">
        <span>{side.teamName}</span>
        <span className="text-2xl" data-testid={`score-${side.teamId}`}>
          {(side.score ?? 0).toFixed(2)}
        </span>
      </h3>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {lineup.players
            .filter((p) => isStarter(p.slot))
            .map((p) => (
              <tr key={p.player.id}>
                <td className="w-16 font-mono">{p.slot}</td>
                <td>
                  {p.player.name} <span className="text-muted-foreground">{p.player.team ?? 'FA'}</span>
                </td>
                <td className="text-right text-muted-foreground">{p.projectedPoints ?? '–'}</td>
                <td className="w-16 text-right">{p.points ?? '–'}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}
