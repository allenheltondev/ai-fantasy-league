import { useParams } from 'react-router';
import { EmptyState, LoadingPage } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { ModelLeaderboardPanel } from './ModelLeaderboardPanel';

/** The Standings section (#58). */
export function StandingsPage() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getStandings(leagueId), leagueId);

  let body;
  if (loaded.data === null) {
    body = loaded.error ? <ApiErrorAlert error={loaded.error} /> : <LoadingPage text="Loading standings…" />;
  } else if (loaded.data.standings.length === 0) {
    body = <EmptyState title="No standings yet" description="Standings start once the season does." />;
  } else {
    body = (
      <table className="w-full text-sm" aria-label="Standings">
        <caption className="text-left text-muted-foreground">
          {loaded.data.throughWeek === null
            ? 'No games final yet'
            : `Through week ${loaded.data.throughWeek}`}
        </caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col">#</th>
            <th scope="col">Team</th>
            <th scope="col">Record</th>
            <th scope="col">PF</th>
            <th scope="col">PA</th>
            <th scope="col">Streak</th>
          </tr>
        </thead>
        <tbody>
          {loaded.data.standings.map((row) => (
            <tr key={row.teamId}>
              <td>{row.rank}</td>
              <td>{row.teamName}</td>
              <td>{row.record}</td>
              <td>{row.pointsFor.toFixed(2)}</td>
              <td>{row.pointsAgainst.toFixed(2)}</td>
              <td>{row.streak ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <div data-testid="league-section-standings" className="space-y-4">
      <h2 className="text-xl font-semibold">Standings</h2>
      {body}
      <ModelLeaderboardPanel leagueId={leagueId} />
    </div>
  );
}
