import { useParams, useSearchParams } from 'react-router';
import { EmptyState, LoadingPage } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { HistoryPanel } from './HistoryPanel';
import { ModelLeaderboardPanel } from './ModelLeaderboardPanel';
import { PlayoffsPanel } from './PlayoffsPanel';

const VIEWS = [
  { id: 'standings', label: 'Standings' },
  { id: 'playoffs', label: 'Playoffs' },
  { id: 'history', label: 'History' }
] as const;
type View = (typeof VIEWS)[number]['id'];

/** The Standings section (#58), with the playoff bracket (#78) and league history (#81) as tabs (`?view=`). */
export function StandingsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('view');
  const view: View = VIEWS.find((v) => v.id === requested)?.id ?? 'standings';
  return (
    <div data-testid="league-section-standings" className="space-y-4">
      <h2 className="text-xl font-semibold">Standings</h2>
      <div role="tablist" aria-label="Standings views" className="flex gap-2">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            className={`rounded-md px-3 py-1 text-sm font-medium ${
              view === v.id
                ? 'bg-primary-100 text-primary-800'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setParams(v.id === 'standings' ? {} : { view: v.id })}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={VIEWS.find((v) => v.id === view)?.label}>
        {view === 'playoffs' ? <PlayoffsPanel /> : view === 'history' ? <HistoryPanel /> : <StandingsTable />}
      </div>
    </div>
  );
}

function StandingsTable() {
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
    <div className="space-y-6">
      {body}
      <ModelLeaderboardPanel leagueId={leagueId} />
    </div>
  );
}
