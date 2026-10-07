import { useParams } from 'react-router';
import { EmptyState } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ManagerTag } from '../../components/AgentAvatar';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { STACKED_BLOCK, STACKED_HEAD, STACKED_LABEL, STACKED_ROW } from '../../lib/stackedTable';
import { LoadingSkeleton, stagger } from '../../motion/decor';
import { ModelLeaderboardPanel } from './ModelLeaderboardPanel';
import { StandingsHelp } from '../help/PageHelp';

/** A standings row as a card below `sm`: rank | team | record, then PF | PA | streak. */
const ROW = `${STACKED_ROW} max-sm:grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_auto]`;

/** League › Standings (#58, #178): the table, then the models playing the league (#76). */
export function StandingsPage() {
  return (
    <div data-testid="league-section-standings" className="space-y-4">
      <StandingsTable />
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
          <StandingsHelp />
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
              <td className="break-words max-sm:col-span-2 max-sm:font-medium">
                <span className="flex min-w-0 flex-col">
                  <span>{row.teamName}</span>
                  <ManagerTag manager={row.manager} teamId={row.teamId} size={16} />
                </span>
              </td>
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
