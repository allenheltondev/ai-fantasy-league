import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  Select,
  StatusBadge,
  useToast
} from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { LeagueTeam, Roster, StandingsData } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { TableScroll } from '../../components/TableScroll';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { useLeagueOutlet } from '../../routes/leagueContext';
import { otherTeamPath, teamPath } from '../../routes/leagueRoutes';
import { rollTeamAvatarSeed, teamAvatarSeed } from '../../routes/leagueTeams';
import { initials } from '../home/TeamBadge';
import { Transactions } from '../players/Transactions';
import { isStarter, statusLabel } from '../season/slots';
import { TeamAchievements } from '../season/TeamAchievements';
import { PlayerHeadshot } from '../../players/PlayerHeadshot';
import { PlayerLink } from '../../players/PlayerLink';
import { NflTeamLink } from '../../players/NflTeamLink';

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

/**
 * The head of My Team: whose team is shown, its record, a picker that opens any team in the league,
 * and what you can do with it. Yours: edit its name and avatar, and jump to your moves and trades.
 * Another team: Propose trade. Nothing outside the league layout (a page rendered on its own).
 */
export function TeamHeader({ teamId }: { teamId: string }) {
  const { leagueId = '' } = useParams();
  const navigate = useNavigate();
  const outlet = useLeagueOutlet();
  const standings = useStandings(leagueId);
  const [editing, setEditing] = useState(false);
  const state = outlet?.state ?? null;
  const yourId = state?.yourTeam?.id ?? null;
  const team =
    state?.teams?.find((t) => t.id === teamId) ?? (yourId === teamId ? (state?.yourTeam ?? null) : null);
  if (state === null || team === null) return null;
  const yours = yourId === team.id;
  const canTrade = !yours && state.allowedActions.includes('propose_trade');
  const record = recordOf(standings.data, team.id);
  // Yours first, then the rest in league order.
  const teams = [...(state.teams ?? [])].sort((a, b) => Number(b.id === yourId) - Number(a.id === yourId));
  return (
    <section aria-label="Team" className="space-y-4" data-testid="team-header">
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
        {teams.length > 1 && (
          <div className="w-full sm:w-64">
            <Select
              label="View team"
              value={team.id}
              onChange={(e) =>
                navigate(
                  e.target.value === yourId
                    ? teamPath(leagueId, 'lineup')
                    : otherTeamPath(leagueId, e.target.value)
                )
              }
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id === yourId ? `${t.name} (you)` : t.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {yours ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="min-h-11"
            aria-expanded={editing}
            onClick={() => setEditing((open) => !open)}
          >
            Edit team
          </Button>
          <Link
            to={teamPath(leagueId, 'moves')}
            className="btn btn-ghost btn-sm inline-flex min-h-11 items-center"
          >
            Add &amp; drop players
          </Link>
          <Link
            to={teamPath(leagueId, 'trades')}
            className="btn btn-ghost btn-sm inline-flex min-h-11 items-center"
          >
            Trades
          </Link>
        </div>
      ) : (
        canTrade && (
          <Link
            to={`${teamPath(leagueId, 'trades')}?with=${encodeURIComponent(team.id)}`}
            className="btn btn-primary inline-flex min-h-11 items-center"
          >
            Propose trade
          </Link>
        )
      )}
      {yours && editing && <TeamProfileForm team={team} onClose={() => setEditing(false)} />}
    </section>
  );
}

/**
 * Your team's name and avatar (#178), from My Team's "Edit team". The avatar is drawn from a seed
 * like an AI manager's (#161); "New avatar" rolls another, and Save keeps it (rename_team).
 */
function TeamProfileForm({ team, onClose }: { team: LeagueTeam; onClose: () => void }) {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const { toast } = useToast();
  const outlet = useLeagueOutlet();
  const [name, setName] = useState<string | null>(null);
  const [seed, setSeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

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
        toast('Team profile saved.', { variant: 'success' });
        outlet?.reloadLeague();
        onClose();
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
      }
    );
  };

  return (
    <Card data-testid="team-profile">
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
            {team.renamedFrom && (
              <p className="text-sm text-muted-foreground" data-testid="renamed-from">
                Renamed from {team.renamedFrom}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Your avatar shows beside your team everywhere in the league: the dashboard, matchups, standings,
              chat, and the draft.
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
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/**
 * Another team, read-only under My Team (#178): its header (the team picker, and Propose trade), its
 * achievements, its lineup with projections, and its recent moves. Your own team is My Team itself.
 */
export function TeamViewPage() {
  const { leagueId = '', teamId = '' } = useParams();
  const outlet = useLeagueOutlet();
  const state = outlet?.state ?? null;
  const team = state?.teams?.find((t) => t.id === teamId) ?? null;

  if (state === null) return <LoadingSkeleton label="Loading the team…" />;
  if (state.yourTeam?.id === teamId) return <Navigate to={teamPath(leagueId, 'lineup')} replace />;
  if (team === null) {
    return (
      <EmptyState
        title="Team not found"
        description="That team is not in this league."
        action={<Link to={teamPath(leagueId, 'lineup')}>Back to My Team</Link>}
      />
    );
  }
  return (
    <div data-testid="team-view" className="space-y-4">
      <TeamHeader teamId={team.id} />
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
                      <PlayerHeadshot player={entry.player} size={24} />
                      <PlayerLink player={entry.player} />
                      <span className="text-xs text-muted-foreground">
                        {entry.player.position} · <NflTeamLink team={entry.player.team} leagueId={leagueId} />
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
