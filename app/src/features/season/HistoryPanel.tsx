import { useParams } from 'react-router';
import { LoadingPage } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { SeasonRecordsView } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';

const points = (n: number) => n.toFixed(2);

function Records({ records, label }: { records: SeasonRecordsView; label: string }) {
  const rows: [string, string | null][] = [
    [
      'Highest score',
      records.highestScore &&
        `${records.highestScore.teamName}, ${points(records.highestScore.points)} (week ${records.highestScore.week})`
    ],
    [
      'Lowest score',
      records.lowestScore &&
        `${records.lowestScore.teamName}, ${points(records.lowestScore.points)} (week ${records.lowestScore.week})`
    ],
    [
      'Biggest blowout',
      records.biggestBlowout &&
        `${records.biggestBlowout.winnerName} over ${records.biggestBlowout.loserName} by ${points(records.biggestBlowout.margin)} (week ${records.biggestBlowout.week})`
    ],
    [
      'Closest game',
      records.closestGame &&
        `${records.closestGame.winnerName} over ${records.closestGame.loserName} by ${points(records.closestGame.margin)} (week ${records.closestGame.week})`
    ]
  ];
  return (
    <dl aria-label={label} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd>{value ?? '–'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** League history (#81): past seasons, records, head-to-head, achievements (#82), and trades. */
export function HistoryPanel() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getLeagueHistory(leagueId), leagueId);
  if (loaded.data === null) {
    return loaded.error ? <ApiErrorAlert error={loaded.error} /> : <LoadingPage text="Loading history…" />;
  }
  const { seasons, current, achievements, trades } = loaded.data;
  return (
    <div className="space-y-6">
      <section aria-labelledby="history-seasons" className="space-y-2">
        <h3 id="history-seasons" className="font-semibold">
          Champions
        </h3>
        {seasons.length === 0 ? (
          <p className="text-muted-foreground">No completed seasons yet.</p>
        ) : (
          <ul className="space-y-1">
            {seasons.map((s) => (
              <li key={s.season}>
                {s.season}: <strong>{s.championName ?? 'No champion'}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-records" className="space-y-2">
        <h3 id="history-records" className="font-semibold">
          {current.season} records
        </h3>
        <Records records={current.records} label={`${current.season} records`} />
      </section>

      <section aria-labelledby="history-h2h" className="space-y-2">
        <h3 id="history-h2h" className="font-semibold">
          Head to head
        </h3>
        {current.headToHead.length === 0 ? (
          <p className="text-muted-foreground">No games final yet.</p>
        ) : (
          <table className="w-full text-sm" aria-label="Head to head">
            <tbody>
              {current.headToHead.map((h) => (
                <tr key={`${h.teamId}-${h.opponentId}`}>
                  <td>
                    {h.teamName} vs {h.opponentName}
                  </td>
                  <td className="tabular-nums">
                    {h.wins}-{h.losses}
                    {h.ties > 0 ? `-${h.ties}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="history-achievements" className="space-y-2">
        <h3 id="history-achievements" className="font-semibold">
          Achievements
        </h3>
        {achievements.length === 0 ? (
          <p className="text-muted-foreground">No achievements earned yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {achievements.map((a) => (
              <li key={a.id}>
                <strong>{a.teamName}</strong>: {a.name} ({a.reason})
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-trades" className="space-y-2">
        <h3 id="history-trades" className="font-semibold">
          Trades
        </h3>
        {trades.length === 0 ? (
          <p className="text-muted-foreground">No trades yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {trades.map((t) => (
              <li key={t.id}>
                Week {t.week}: {t.teamName}
                {t.added && ` gets ${t.added.name}`}
                {t.dropped && ` sends ${t.dropped.name}`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
