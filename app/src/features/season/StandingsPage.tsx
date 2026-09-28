import { useParams, useSearchParams } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { STACKED_BLOCK, STACKED_HEAD, STACKED_LABEL, STACKED_ROW } from '../../lib/stackedTable';
import { LoadingSkeleton, stagger } from '../../motion/decor';
import { HistoryPanel } from './HistoryPanel';
import { ModelLeaderboardPanel } from './ModelLeaderboardPanel';
import { PlayoffsPanel } from './PlayoffsPanel';

/** A standings row as a card below `sm`: rank | team | record, then PF | PA | streak. */
const ROW = `${STACKED_ROW} max-sm:grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_auto]`;

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
            className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
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
    body = loaded.error ? (
      <ApiErrorAlert error={loaded.error} />
    ) : (
      <LoadingSkeleton label="Loading standings…" rows={6} />
    );
  } else if (loaded.data.standings.length === 0) {
    body = <EmptyState title="No standings yet" description="Standings start once the season does." />;
  } else {
    body = (
      // Below `sm` each team is a card: rank, name and record, then PF, PA and streak.
      <table className={`w-full text-sm ${STACKED_BLOCK}`} aria-label="Standings">
        <caption className="text-left text-muted-foreground max-sm:block">
          {loaded.data.throughWeek === null
            ? 'No games final yet'
            : `Through week ${loaded.data.throughWeek}`}
        </caption>
        <thead className={STACKED_HEAD}>
          <tr className="text-left text-muted-foreground">
            <th scope="col">#</th>
            <th scope="col">Team</th>
            <th scope="col">Record</th>
            <th scope="col">PF</th>
            <th scope="col">PA</th>
            <th scope="col">Streak</th>
          </tr>
        </thead>
        <tbody className={STACKED_BLOCK}>
          {loaded.data.standings.map((row, index) => (
            <tr
              key={row.teamId}
              className={`motion-row ${stagger(index).className} ${ROW}`}
              style={stagger(index).style}
            >
              <td className="max-sm:row-span-2 max-sm:self-start max-sm:font-semibold">{row.rank}</td>
              <td className="break-words max-sm:col-span-2 max-sm:font-medium">{row.teamName}</td>
              <td className="max-sm:text-right">{row.record}</td>
              <td data-label="PF" className={`max-sm:col-start-2 ${STACKED_LABEL}`}>
                {row.pointsFor.toFixed(2)}
              </td>
              <td data-label="PA" className={STACKED_LABEL}>
                {row.pointsAgainst.toFixed(2)}
              </td>
              <td data-label="Streak" className={`max-sm:text-right ${STACKED_LABEL}`}>
                {row.streak ?? '–'}
              </td>
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
