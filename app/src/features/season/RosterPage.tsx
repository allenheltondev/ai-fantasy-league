import { useState } from 'react';
import { useParams } from 'react-router';
import { Alert, EmptyState, LoadingPage, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { Roster, RosterEntry } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { isStarter, planMove, slotOptions, statusLabel } from './slots';

/** The Roster section (#58): your players by slot, with lock and status badges, and slot moves. */
export function RosterPage() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const state = useLoad(() => api.getLeagueState(leagueId), leagueId);

  let body;
  if (state.data === null) {
    body = state.error ? <ApiErrorAlert error={state.error} /> : <LoadingPage text="Loading your team…" />;
  } else if (state.data.yourTeam === null) {
    body = <EmptyState title="No team" description="You do not manage a team in this league." />;
  } else {
    body = <LineupEditor leagueId={leagueId} teamId={state.data.yourTeam.id} />;
  }
  return (
    <div data-testid="league-section-roster" className="space-y-4">
      <h2 className="text-xl font-semibold">Roster</h2>
      {body}
    </div>
  );
}

function LineupEditor({ leagueId, teamId }: { leagueId: string; teamId: string }) {
  const api = useLeagueApi();
  const roster = useLoad(() => api.getRoster(leagueId, teamId), `${leagueId}:${teamId}`);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [warnings, setWarnings] = useState<{ code: string; message: string }[]>([]);

  if (roster.data === null) {
    return roster.error ? (
      <ApiErrorAlert error={roster.error} />
    ) : (
      <LoadingPage text="Loading your lineup…" />
    );
  }
  const data = roster.data;

  const move = (entry: RosterEntry, target: string) => {
    const moves = planMove(data.players, data.slots, entry.player.id, target);
    if (moves === null) {
      setProblem(new Error(`Every ${target} slot holds a locked player.`));
      return;
    }
    setSaving(true);
    setProblem(null);
    api.setLineup(leagueId, teamId, data.week, moves).then(
      (res) => {
        setWarnings(res.warnings);
        setSaving(false);
        roster.reload();
      },
      (error: unknown) => {
        setProblem(error);
        setSaving(false);
      }
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {data.teamName} · Week {data.week}
        {data.carriedFromWeek !== null ? ` · carried over from week ${data.carriedFromWeek}` : ''}
      </p>
      <ApiErrorAlert error={problem} />
      {warnings.map((w) => (
        <Alert key={`${w.code}:${w.message}`} variant="info">
          {w.message}
        </Alert>
      ))}
      {data.players.length === 0 ? (
        <EmptyState title="No players yet" description="Your roster fills in at the draft." />
      ) : (
        <>
          <LineupTable
            title="Starters"
            rows={data.players.filter((p) => isStarter(p.slot))}
            data={data}
            saving={saving}
            onMove={move}
          />
          <LineupTable
            title="Bench"
            rows={data.players.filter((p) => !isStarter(p.slot))}
            data={data}
            saving={saving}
            onMove={move}
          />
        </>
      )}
    </div>
  );
}

function LineupTable(props: {
  title: string;
  rows: RosterEntry[];
  data: Roster;
  saving: boolean;
  onMove: (entry: RosterEntry, slot: string) => void;
}) {
  return (
    <table className="w-full text-sm" aria-label={props.title}>
      <caption className="text-left font-semibold">{props.title}</caption>
      <thead>
        <tr className="text-left text-muted-foreground">
          <th scope="col">Slot</th>
          <th scope="col">Player</th>
          <th scope="col">Status</th>
          <th scope="col">Proj</th>
          <th scope="col">Pts</th>
          <th scope="col">Move</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => {
          const label = statusLabel(row);
          return (
            <tr key={row.player.id} data-testid={`roster-row-${row.player.id}`}>
              <td className="font-mono">{row.slot}</td>
              <td>
                {row.player.name}{' '}
                <span className="text-muted-foreground">
                  {row.player.position} · {row.player.team ?? 'FA'}
                  {row.byeWeek !== null ? ` · bye ${row.byeWeek}` : ''}
                </span>
              </td>
              <td className="space-x-1">
                {row.locked && <StatusBadge tone="neutral">Locked</StatusBadge>}
                {label && <StatusBadge tone={row.onBye ? 'warning' : 'error'}>{label}</StatusBadge>}
              </td>
              <td>{row.projectedPoints ?? '–'}</td>
              <td>{row.points ?? '–'}</td>
              <td>
                <select
                  aria-label={`Move ${row.player.name}`}
                  disabled={row.locked || props.saving}
                  value=""
                  onChange={(e) => props.onMove(row, e.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1"
                >
                  <option value="" disabled>
                    Move to…
                  </option>
                  {slotOptions(row, props.data.slots).map((slot) => (
                    <option key={slot} value={slot}>
                      {slot}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
