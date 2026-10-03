import { Link, useNavigate, useParams } from 'react-router';
import { Card, CardBody, EmptyState, Select, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { DepthChartPlayer, NflDepthChart, PointsAllowedData } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { InjuryBadge } from '../../draft/BestAvailableTable';
import { ordinal } from '../../draft/DraftResults';
import { fmt } from '../../draft/research';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { MATCHUP_LABEL, MATCHUP_TONE, matchupStrength } from '../../players/matchup';
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
 * first, each player's picture and name opening his card, and the rest of the team below, then the
 * fantasy points its defense allows by position. A picker jumps to another team.
 */
export function NflTeamPage() {
  const { leagueId = '', team = '' } = useParams();
  const code = team.toUpperCase();
  const known = (NFL_TEAMS as readonly string[]).includes(code);
  const api = useLeagueApi();
  const navigate = useNavigate();
  // `useLoad` keeps the last team's result on screen while the next loads, so each result carries
  // its team (a failure too) and only the current team's counts: a failed switch shows its error,
  // never the team before it.
  const loaded = useLoad<TeamLoad | null>(
    () =>
      known
        ? api.getNflDepthChart(code).then(
            (chart) => ({ code, chart, error: null }),
            (error: unknown) => ({ code, chart: null, error })
          )
        : Promise.resolve(null),
    code
  );
  const current = loaded.data?.code === code ? loaded.data : null;
  // Points allowed load on their own: the depth chart shows whether or not they come back.
  const allowed = useLoad<AllowedLoad | null>(
    () =>
      known
        ? api.getPointsAllowed({ team: code }).then(
            (table) => ({ code, table }),
            () => ({ code, table: null })
          )
        : Promise.resolve(null),
    code
  );
  const allowedNow = allowed.data?.code === code ? allowed.data : null;

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
      ) : current === null ? (
        <LoadingSkeleton label="Loading the depth chart…" rows={6} />
      ) : current.chart === null ? (
        <ApiErrorAlert error={current.error} />
      ) : (
        <>
          <DepthChartView chart={current.chart} />
          {allowedNow !== null && <PointsAllowedCard team={code} table={allowedNow.table} />}
        </>
      )}
    </div>
  );
}

/** One team's load: its chart, or why it failed. */
interface TeamLoad {
  code: string;
  chart: NflDepthChart | null;
  error: unknown;
}

/** One team's points-allowed load: its table, or null when it failed. */
interface AllowedLoad {
  code: string;
  table: PointsAllowedData | null;
}

const ALLOWED_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const;
const ALLOWED_LABELS: Readonly<Record<string, string>> = { DEF: 'Team defense' };

/**
 * How the team's defense fares against each fantasy position this season: PPR points allowed per
 * game and its rank (1st allows the most: the easiest matchup for an opposing player).
 */
function PointsAllowedCard({ team, table }: { team: string; table: PointsAllowedData | null }) {
  const row = table?.teams.find((t) => t.team === team);
  return (
    <Card>
      <CardBody>
        <section aria-label="Points allowed by position" className="space-y-2">
          <h3 className="font-semibold">Points allowed by position</h3>
          {table === null ? (
            <p className="text-sm text-muted-foreground">Points allowed are not available right now.</p>
          ) : row === undefined || table.throughWeek === null ? (
            <p className="text-sm text-muted-foreground">No completed games yet this season.</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                PPR points per game the {team} defense allows to opposing players, through week{' '}
                {table.throughWeek} ({row.games} {row.games === 1 ? 'game' : 'games'}). 1st allows the most.
              </p>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {ALLOWED_POSITIONS.map((position) => {
                  const p = row.positions[position];
                  if (p === undefined) return null;
                  const strength = matchupStrength(p.rank, p.of);
                  return (
                    <li
                      key={position}
                      data-testid={`allowed-${position}`}
                      className="flex items-center justify-between gap-2 rounded-md border border-border p-2"
                    >
                      <span>
                        <span className="font-medium">{ALLOWED_LABELS[position] ?? position}</span>{' '}
                        <span className="text-sm text-muted-foreground">
                          {fmt(p.perGame)} pts · {ordinal(p.rank)} of {p.of}
                        </span>
                      </span>
                      <StatusBadge tone={MATCHUP_TONE[strength]}>{MATCHUP_LABEL[strength]}</StatusBadge>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      </CardBody>
    </Card>
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
