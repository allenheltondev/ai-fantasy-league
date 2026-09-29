import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, EmptyState, Input, StatusBadge, useToast } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { LeagueTeam, Roster, StandingsData } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { TableScroll } from '../../components/TableScroll';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { useLeagueOutlet } from '../../routes/leagueContext';
import { leagueTabPath, otherTeamPath, teamPath } from '../../routes/leagueRoutes';
import { rollTeamAvatarSeed, teamAvatarSeed } from '../../routes/leagueTeams';
import { initials } from '../home/TeamBadge';
import { MyClaims } from '../players/MyClaims';
import { Transactions } from '../players/Transactions';
import { isStarter, statusLabel } from '../season/slots';
import { TeamAchievements } from '../season/TeamAchievements';

/** Who plays a team: the AI manager, the person, or nobody yet. */
export function managerOf(team: Pick<LeagueTeam, 'manager' | 'ownerName'>): string {
  return team.manager?.name ?? team.ownerName ?? 'Open seat';
}

/** A team's picture at any size: its avatar (AI manager's or picked), else its initials. */
export function TeamPicture({ team, size = 40 }: { team: LeagueTeam; size?: number }) {
  const seed = teamAvatarSeed(team);
  if (seed !== null) return <AgentAvatar seed={seed} label={`${team.name} avatar`} size={size} />;
  return (
    <span
      role="img"
      aria-label={`${team.name} avatar`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      className="inline-flex shrink-0 items-center justify-center rounded-lg bg-primary-100 font-semibold text-primary-800"
    >
      {initials(team.ownerName ?? team.name)}
    </span>
  );
}

function useStandings(leagueId: string) {
  const api = useLeagueApi();
  return useLoad<StandingsData>(() => api.getStandings(leagueId), leagueId);
}

function recordOf(standings: StandingsData | null, teamId: string): string | null {
  return standings?.standings.find((r) => r.teamId === teamId)?.record ?? null;
}

/** The viewer's team from the league layout, or the page's "no team" / loading state. */
function useYourTeam(): { team: LeagueTeam | null; fallback: React.ReactNode } {
  const outlet = useLeagueOutlet();
  const state = outlet?.state ?? null;
  if (state === null) return { team: null, fallback: <LoadingSkeleton label="Loading your team…" /> };
  const id = state.yourTeam?.id;
  const team = state.teams?.find((t) => t.id === id) ?? state.yourTeam;
  if (team === null || team === undefined) {
    return {
      team: null,
      fallback: <EmptyState title="No team" description="You do not manage a team in this league." />
    };
  }
  return { team, fallback: null };
}

/**
 * My Team › Team profile (#178): your team's name and avatar. The avatar is drawn from a seed like
 * an AI manager's (#161); "New avatar" rolls another, and Save keeps it (rename_team).
 */
export function TeamProfilePage() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const { toast } = useToast();
  const outlet = useLeagueOutlet();
  const { team, fallback } = useYourTeam();
  const [name, setName] = useState<string | null>(null);
  const [seed, setSeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (team === null) {
    return (
      <div data-testid="team-page-profile" className="space-y-4">
        <h2 className="text-xl font-semibold">Team profile</h2>
        {fallback}
      </div>
    );
  }
  const canEdit = outlet?.state?.allowedActions.includes('rename_team') === true;
  const draftName = name ?? team.name;
  const draftSeed = seed ?? team.avatarSeed ?? null;
  const changed = draftName.trim() !== team.name || (seed !== null && seed !== team.avatarSeed);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const profile: { name?: string; avatarSeed?: string } = {};
    if (draftName.trim() !== team.name) profile.name = draftName.trim();
    if (seed !== null && seed !== team.avatarSeed) profile.avatarSeed = seed;
    setBusy(true);
    setError(null);
    api.setTeamProfile(leagueId, team.id, profile).then(
      () => {
        setBusy(false);
        setName(null);
        setSeed(null);
        toast('Team profile saved.', { variant: 'success' });
        outlet?.reloadLeague();
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
      }
    );
  };

  return (
    <div data-testid="team-page-profile" className="space-y-4">
      <h2 className="text-xl font-semibold">Team profile</h2>
      <Card>
        <CardBody>
          <form className="flex flex-col gap-6 sm:flex-row sm:items-start" onSubmit={save}>
            <div className="flex flex-col items-center gap-3">
              {draftSeed === null ? (
                <TeamPicture team={{ ...team, name: draftName || team.name }} size={96} />
              ) : (
                <AgentAvatar seed={draftSeed} label={`${draftName || team.name} avatar`} size={96} />
              )}
              <Button
                variant="secondary"
                size="sm"
                className="min-h-11"
                disabled={!canEdit || busy}
                onClick={() => setSeed(rollTeamAvatarSeed())}
              >
                New avatar
              </Button>
            </div>
            <div className="min-w-0 flex-1 space-y-4">
              <Input
                label="Team name"
                value={draftName}
                maxLength={40}
                disabled={!canEdit}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Your avatar shows beside your team everywhere in the league: the dashboard, matchups,
                standings, chat, and the draft.
              </p>
              <ApiErrorAlert error={error} />
              {!canEdit && (
                <Alert variant="info">The league is complete, so its teams can no longer change.</Alert>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy}
                  disabled={!canEdit || !changed || draftName.trim() === ''}
                >
                  Save profile
                </Button>
                {changed && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setName(null);
                      setSeed(null);
                    }}
                  >
                    Undo changes
                  </Button>
                )}
              </div>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

/** My Team › Roster & moves: your pending waiver claims and your moves, with the player pool a tap away. */
export function MovesPage() {
  const { leagueId = '' } = useParams();
  const { team, fallback } = useYourTeam();
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div data-testid="team-page-moves" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Roster &amp; moves</h2>
        <Link
          to={leagueTabPath(leagueId, 'players')}
          className="btn btn-primary inline-flex min-h-11 items-center"
        >
          Add a player
        </Link>
      </div>
      {team === null ? (
        fallback
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Pick up free agents and put in waiver claims from League › Players; your claims and every move you
            make land here. Set who starts in{' '}
            <Link className="font-medium text-primary-700 hover:underline" to={teamPath(leagueId, 'lineup')}>
              Lineup
            </Link>
            .
          </p>
          <MyClaims
            leagueId={leagueId}
            refreshKey={refreshKey}
            onChanged={() => setRefreshKey((k) => k + 1)}
          />
          <Transactions leagueId={leagueId} refreshKey={refreshKey} teamId={team.id} title="Your moves" />
        </>
      )}
    </div>
  );
}

/** My Team › Achievements: every badge your team has earned. */
export function AchievementsPage() {
  const { leagueId = '' } = useParams();
  const { team, fallback } = useYourTeam();
  return (
    <div data-testid="team-page-achievements" className="space-y-4">
      <h2 className="text-xl font-semibold">Achievements</h2>
      {team === null ? (
        fallback
      ) : (
        <TeamAchievements
          leagueId={leagueId}
          teamId={team.id}
          empty={
            <EmptyState
              title="No achievements yet"
              description="Blowouts, records, and titles earn badges as the season plays out."
            />
          }
        />
      )}
    </div>
  );
}

/** My Team › Other teams: every other team in the league, to open read-only. */
export function OtherTeamsPage() {
  const { leagueId = '' } = useParams();
  const outlet = useLeagueOutlet();
  const standings = useStandings(leagueId);
  const state = outlet?.state ?? null;
  const others = (state?.teams ?? []).filter((t) => t.id !== state?.yourTeam?.id);
  return (
    <div data-testid="team-page-teams" className="space-y-4">
      <h2 className="text-xl font-semibold">Other teams</h2>
      {state === null ? (
        <LoadingSkeleton label="Loading the league's teams…" rows={4} />
      ) : others.length === 0 ? (
        <EmptyState title="No other teams" description="Teams show up here as the league fills." />
      ) : (
        <ul aria-label="Teams" className="grid gap-2 sm:grid-cols-2">
          {others.map((team) => {
            const record = recordOf(standings.data, team.id);
            return (
              <li key={team.id}>
                <Link
                  to={otherTeamPath(leagueId, team.id)}
                  className="flex min-h-11 items-center gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-primary-300 hover:bg-muted"
                >
                  <TeamPicture team={team} size={40} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{team.name}</span>
                    <span className="truncate text-sm text-muted-foreground">{managerOf(team)}</span>
                  </span>
                  {record !== null && (
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{record}</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Another team, read-only (#178): who plays it, its record, its lineup with projections, its recent
 * moves, and its achievements. Proposing a trade is the only thing to do here.
 */
export function TeamViewPage() {
  const { leagueId = '', teamId = '' } = useParams();
  const outlet = useLeagueOutlet();
  const state = outlet?.state ?? null;
  const standings = useStandings(leagueId);
  const team = state?.teams?.find((t) => t.id === teamId) ?? null;

  if (state === null) return <LoadingSkeleton label="Loading the team…" />;
  if (team === null) {
    return (
      <EmptyState
        title="Team not found"
        description="That team is not in this league."
        action={<Link to={teamPath(leagueId, 'teams')}>Back to the teams</Link>}
      />
    );
  }
  const yours = state.yourTeam?.id === team.id;
  const canTrade = !yours && state.allowedActions.includes('propose_trade');
  const record = recordOf(standings.data, team.id);
  return (
    <div data-testid="team-view" className="space-y-4">
      <Link
        className="inline-flex min-h-11 items-center text-sm font-medium text-primary-700 hover:underline"
        to={teamPath(leagueId, 'teams')}
      >
        ← All teams
      </Link>
      <div className="flex flex-wrap items-center gap-4">
        <TeamPicture team={team} size={64} />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl font-semibold">{team.name}</h2>
          <p className="text-sm text-muted-foreground">
            {managerOf(team)}
            {team.manager?.personality ? ` · ${team.manager.personality}` : ''}
            {record !== null ? ` · ${record}` : ''}
          </p>
        </div>
        {canTrade && (
          <Link
            to={`${teamPath(leagueId, 'trades')}?with=${encodeURIComponent(team.id)}`}
            className="btn btn-primary inline-flex min-h-11 items-center"
          >
            Propose trade
          </Link>
        )}
      </div>
      <TeamAchievements leagueId={leagueId} teamId={team.id} />
      <ReadOnlyLineup leagueId={leagueId} teamId={team.id} />
      <Transactions leagueId={leagueId} refreshKey={0} teamId={team.id} title="Recent moves" />
    </div>
  );
}

/** A team's lineup as it stands, starters then bench, with this week's projections. Nothing to edit. */
function ReadOnlyLineup({ leagueId, teamId }: { leagueId: string; teamId: string }) {
  const api = useLeagueApi();
  const roster = useLoad<Roster>(() => api.getRoster(leagueId, teamId), `${leagueId}:${teamId}`);
  if (roster.data === null) {
    return roster.error ? (
      <ApiErrorAlert error={roster.error} />
    ) : (
      <LoadingSkeleton label="Loading the lineup…" rows={6} />
    );
  }
  const data = roster.data;
  if (data.players.length === 0) {
    return <EmptyState title="No players yet" description="Rosters fill in at the draft." />;
  }
  const ordered = [...data.players].sort((a, b) => Number(isStarter(b.slot)) - Number(isStarter(a.slot)));
  return (
    <section aria-labelledby="team-lineup-title" className="space-y-2">
      <h3
        id="team-lineup-title"
        className="flex flex-wrap items-baseline justify-between gap-2 font-semibold"
      >
        <span>Week {data.week} lineup</span>
        {data.projectedPoints !== undefined && (
          <span className="text-sm font-normal text-muted-foreground">
            Projected {data.projectedPoints.toFixed(1)}
          </span>
        )}
      </h3>
      <TableScroll label="Lineup">
        <table className="w-full text-left text-sm" aria-label={`${data.teamName} lineup`}>
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col">Slot</th>
              <th scope="col">Player</th>
              <th scope="col">Opp</th>
              <th scope="col" className="text-right">
                Proj
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((entry) => {
              const note = statusLabel(entry);
              const opp = entry.opponent
                ? `${entry.opponent.home ? 'vs' : '@'} ${entry.opponent.team}`
                : entry.onBye
                  ? 'Bye'
                  : '–';
              return (
                <tr
                  key={entry.player.id}
                  className={isStarter(entry.slot) ? undefined : 'text-muted-foreground'}
                >
                  <td className="py-1 pr-2 font-medium">{entry.slot}</td>
                  <td className="py-1 pr-2">
                    <span className="flex flex-wrap items-center gap-x-2">
                      <span>{entry.player.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {entry.player.position} · {entry.player.team ?? 'FA'}
                      </span>
                      {note !== null && <StatusBadge tone="warning">{note}</StatusBadge>}
                    </span>
                  </td>
                  <td className="py-1 pr-2">{opp}</td>
                  <td className="py-1 text-right tabular-nums">
                    {entry.projectedPoints === null ? '–' : entry.projectedPoints.toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </section>
  );
}
