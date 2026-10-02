import { Link, useNavigate, useParams } from 'react-router';
import { Card, CardBody, EmptyState, Select } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { DepthChartPlayer, NflDepthChart } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { InjuryBadge } from '../../draft/BestAvailableTable';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { PlayerHeadshot, TeamLogo } from '../../players/PlayerHeadshot';
import { PlayerLink } from '../../players/PlayerLink';
import { leagueTabPath, nflTeamPath } from '../../routes/leagueRoutes';

// prettier-ignore
export const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'
] as const;

/**
 * An NFL team's page, under League › Players: its depth chart at the fantasy positions, starters
 * first, each player's picture and name opening his card, and the rest of the team below. A picker
 * jumps to another team.
 */
export function NflTeamPage() {
  const { leagueId = '', team = '' } = useParams();
  const code = team.toUpperCase();
  const known = (NFL_TEAMS as readonly string[]).includes(code);
  const api = useLeagueApi();
  const navigate = useNavigate();
  const chart = useLoad<NflDepthChart | null>(
    () => (known ? api.getNflDepthChart(code) : Promise.resolve(null)),
    code
  );

  return (
    <div data-testid="nfl-team-page" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Link
          className="inline-flex min-h-11 items-center text-sm font-medium text-primary-700 hover:underline"
          to={leagueTabPath(leagueId, 'players')}
        >
          ← All players
        </Link>
        <Select
          label="NFL team"
          value={known ? code : ''}
          onChange={(e) => navigate(nflTeamPath(leagueId, e.target.value))}
          className="min-h-11"
        >
          {!known && <option value="">Pick a team</option>}
          {NFL_TEAMS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>
      {!known ? (
        <EmptyState title="Team not found" description={`"${team}" is not an NFL team.`} />
      ) : chart.data === null ? (
        chart.error ? (
          <ApiErrorAlert error={chart.error} />
        ) : (
          <LoadingSkeleton label="Loading the depth chart…" rows={6} />
        )
      ) : (
        <DepthChartView chart={chart.data} />
      )}
    </div>
  );
}

function DepthChartView({ chart }: { chart: NflDepthChart }) {
  const { team } = chart;
  return (
    <>
      <div className="flex items-center gap-3">
        <TeamLogo team={team.code} size={56} eager />
        <div>
          <h2 className="text-xl font-semibold">
            {team.city} {team.nickname}
          </h2>
          <p className="text-sm text-muted-foreground">Depth chart</p>
        </div>
      </div>
      {chart.slots.length === 0 && chart.others.length === 0 ? (
        <EmptyState title="No depth chart yet" description="It fills in when the next player sync runs." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {chart.slots.map((s) => (
            <DepthSlot key={s.slot} title={s.label} players={s.players} />
          ))}
          {chart.others.length > 0 && (
            <DepthSlot title="Not on the depth chart" players={chart.others} unranked />
          )}
        </div>
      )}
    </>
  );
}

function DepthSlot({
  title,
  players,
  unranked = false
}: {
  title: string;
  players: readonly DepthChartPlayer[];
  unranked?: boolean;
}) {
  return (
    <Card>
      <CardBody>
        <section aria-label={title} className="space-y-2">
          <h3 className="font-semibold">{title}</h3>
          <ol className="space-y-2">
            {players.map((p, i) => (
              <li
                key={p.id}
                data-testid={`depth-${p.id}`}
                className={`flex items-center gap-3 ${!unranked && i > 0 ? 'text-muted-foreground' : ''}`}
              >
                {!unranked && (
                  <span className="w-5 text-right text-sm tabular-nums" aria-label="Depth">
                    {p.depth ?? '–'}
                  </span>
                )}
                <PlayerHeadshot player={p} size={40} />
                <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                  <PlayerLink player={p} className="font-medium text-foreground" />
                  <span className="text-xs text-muted-foreground">
                    {unranked ? `${p.position} · ` : ''}
                    {p.number === null ? '' : `#${p.number}`}
                  </span>
                  <InjuryBadge status={p.injuryStatus} />
                </span>
              </li>
            ))}
          </ol>
        </section>
      </CardBody>
    </Card>
  );
}
