import { Card, CardBody } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { ModelLeaderboardModel } from '../../api/types';
import { useLoad } from '../../lib/useLoad';

export function formatUsd(value: number | null): string {
  if (value === null) return '–';
  return value < 0.01 && value > 0 ? '<$0.01' : `$${value.toFixed(2)}`;
}

function record(m: ModelLeaderboardModel): string {
  return m.ties > 0 ? `${m.wins}-${m.losses}-${m.ties}` : `${m.wins}-${m.losses}`;
}

/**
 * "Which model wins the league?" (#76): standings rolled up by the model that plays each team, with
 * people grouped as Human. Shown under the standings; hidden when the league has no agents.
 */
export function ModelLeaderboardPanel({ leagueId }: { leagueId: string }) {
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getModelLeaderboard(leagueId), leagueId);

  if (loaded.data === null) {
    return loaded.error ? null : <p className="text-sm text-muted-foreground">Loading model rankings…</p>;
  }
  const { models, throughWeek } = loaded.data;
  if (!models.some((m) => m.modelKey !== 'human')) return null;

  return (
    <section aria-labelledby="model-leaderboard-title" className="space-y-2" data-testid="model-leaderboard">
      <h3 id="model-leaderboard-title" className="text-lg font-semibold">
        Which model wins the league?
      </h3>
      <Card>
        <CardBody>
          <table className="w-full text-sm" aria-label="Model power rankings">
            <caption className="text-left text-muted-foreground">
              {throughWeek === null ? 'No games final yet' : `Through week ${throughWeek}`} · costs are
              estimates
            </caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col">#</th>
                <th scope="col">Model</th>
                <th scope="col">Teams</th>
                <th scope="col">Record</th>
                <th scope="col">Win %</th>
                <th scope="col">PF / team</th>
                <th scope="col">Cost</th>
                <th scope="col">Cost / win</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m, i) => (
                <tr key={m.modelKey}>
                  <td>{i + 1}</td>
                  <td>{m.modelName}</td>
                  <td>{m.teams}</td>
                  <td>{record(m)}</td>
                  <td>{m.winRate === null ? '–' : `${(m.winRate * 100).toFixed(0)}%`}</td>
                  <td>{m.pointsForPerTeam.toFixed(1)}</td>
                  <td>{m.modelKey === 'human' ? '–' : formatUsd(m.costUsd)}</td>
                  <td>{formatUsd(m.costPerWinUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </section>
  );
}
