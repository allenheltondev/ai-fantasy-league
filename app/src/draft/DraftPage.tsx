import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Input,
  Select,
  StatusBadge
} from '@readysetcloud/ui';
import { ApiError, apiFetch, type ApiFetch } from '../api';
import { formatClock, overallPick, POSITIONS, secondsUntil, type DraftBoard } from './board';

export interface DraftPageProps {
  /** The API client (tests pass a fake). */
  api?: ApiFetch;
  /** How often to refresh the board. Realtime updates replace polling later. */
  pollMs?: number;
  /** The wall clock for the countdown. */
  now?: () => number;
}

function toApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(0, { code: 'NETWORK', message: 'Could not reach the server.' });
}

const STATUS = {
  in_progress: { tone: 'success', label: 'Live' },
  paused: { tone: 'warning', label: 'Paused' },
  complete: { tone: 'neutral', label: 'Complete' }
} as const;

/** The draft room: the board grid, the clock, the best available players, and your pick. */
export function DraftPage({ api = apiFetch, pollMs = 3000, now = Date.now }: DraftPageProps) {
  const { leagueId = '' } = useParams();
  const [board, setBoard] = useState<DraftBoard | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [pickError, setPickError] = useState<ApiError | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [position, setPosition] = useState('');
  const [tick, setTick] = useState(now);

  const load = useCallback(async () => {
    try {
      const res = await api<DraftBoard>(`/leagues/${leagueId}/draft`, {
        query: { q: q.trim() || undefined, position: position || undefined, limit: 25 }
      });
      setBoard(res.data);
      setLoadError(null);
    } catch (error) {
      setLoadError(toApiError(error));
    }
  }, [api, leagueId, q, position]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  useEffect(() => {
    const id = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(id);
  }, [now]);

  async function draft(playerId: string, overall: number) {
    setPicking(playerId);
    setPickError(null);
    try {
      await api(`/leagues/${leagueId}/draft/picks`, { method: 'POST', body: { playerId, pick: overall } });
      await load();
    } catch (error) {
      setPickError(toApiError(error));
    } finally {
      setPicking(null);
    }
  }

  let content;
  if (board === null) {
    content =
      loadError === null ? (
        <p className="text-muted-foreground">Loading the draft board…</p>
      ) : loadError.code === 'DRAFT_NOT_STARTED' ? (
        <EmptyState title="The draft has not started" description={loadError.fix} />
      ) : (
        <ErrorState message={loadError.message} action={{ label: 'Try again', onClick: () => void load() }} />
      );
  } else {
    const clock = board.onTheClock;
    const mine = clock !== null && clock.teamId === board.yourTeamId && board.status === 'in_progress';
    const current = clock === null ? 0 : clock.overall;
    const seconds =
      clock === null
        ? null
        : clock.deadline === null
          ? clock.secondsLeft
          : secondsUntil(clock.deadline, tick);
    const byOverall = new Map(board.picks.map((p) => [p.overall, p]));
    const roster = board.rosters.find((r) => r.teamId === board.yourTeamId);
    content = (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge tone={STATUS[board.status].tone}>{STATUS[board.status].label}</StatusBadge>
          {clock !== null && (
            <p>
              <strong>{clock.teamName}</strong> is on the clock: round {clock.round}, pick {clock.overall}.{' '}
              <span data-testid="pick-clock" className="font-mono">
                {formatClock(seconds ?? 0)}
              </span>
            </p>
          )}
        </div>
        {mine && <Alert variant="info">You are on the clock! Pick a player below.</Alert>}
        {!mine && board.yourNextPick !== null && (
          <p className="text-muted-foreground">
            Your next pick is #{board.yourNextPick.overall}, {board.yourNextPick.picksAway} pick(s) away.
          </p>
        )}
        {board.status === 'complete' && (
          <Alert variant="success">The draft is complete. Good luck this season!</Alert>
        )}
        {pickError !== null && (
          <Alert variant="error" role="alert">
            {pickError.message} {pickError.fix}
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Board</CardTitle>
          </CardHeader>
          <CardBody className="overflow-x-auto">
            <table aria-label="Draft board" className="min-w-full text-sm">
              <thead>
                <tr>
                  <th scope="col">Rd</th>
                  {board.order.map((team) => (
                    <th
                      key={team.teamId}
                      scope="col"
                      className={team.teamId === board.yourTeamId ? 'text-primary-800' : ''}
                    >
                      {team.teamName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: board.rounds }, (_, r) => r + 1).map((round) => (
                  <tr key={round}>
                    <th scope="row">{round}</th>
                    {board.order.map((team, index) => {
                      const overall = overallPick(round, index, board.order.length);
                      const pick = byOverall.get(overall);
                      const onClock = current === overall;
                      return (
                        <td
                          key={team.teamId}
                          data-testid={`cell-${overall}`}
                          className={onClock ? 'bg-primary-100' : ''}
                        >
                          {pick === undefined
                            ? onClock
                              ? 'On the clock'
                              : ''
                            : `${pick.player.name} (${pick.player.position})${pick.auto ? ' · auto' : ''}`}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Best available</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap gap-3">
                <Input label="Search players" value={q} onChange={(e) => setQ(e.target.value)} />
                <Select label="Position" value={position} onChange={(e) => setPosition(e.target.value)}>
                  <option value="">All</option>
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </div>
              <ul aria-label="Best available" className="divide-y divide-border">
                {board.bestAvailable.map(({ player, rank }) => (
                  <li key={player.id} className="flex items-center justify-between gap-2 py-2">
                    <span>
                      {player.name}{' '}
                      <span className="text-muted-foreground">
                        {player.position} · {player.team ?? 'FA'} · rank {rank ?? '—'}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      disabled={!mine || picking !== null}
                      loading={picking === player.id}
                      onClick={() => void draft(player.id, current)}
                      aria-label={`Draft ${player.name}`}
                    >
                      Pick
                    </Button>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Your team</CardTitle>
            </CardHeader>
            <CardBody>
              {board.yourNeeds.length > 0 && (
                <p className="text-muted-foreground">Still to fill: {board.yourNeeds.join(', ')}</p>
              )}
              <ol aria-label="Your roster" className="list-decimal pl-5">
                {(roster?.players ?? []).map((p) => (
                  <li key={p.id}>
                    {p.name} ({p.position})
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="league-section-draft" className="space-y-4">
      <h2 className="text-xl font-semibold">Draft</h2>
      {content}
    </div>
  );
}
