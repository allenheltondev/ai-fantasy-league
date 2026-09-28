import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Input, StatusBadge } from '@readysetcloud/ui';
import { ApiError, type ApiFetch } from '../api';
import type { PlayerRef } from './board';
import type { DraftQueue } from './queue';

/** `check_in_draft_lobby` (packages/server/src/operations/draft/lobby.ts). */
export interface LobbyTeam {
  teamId: string;
  teamName: string;
  seatType: 'human' | 'agent';
  here: boolean;
  lastSeenAt: string | null;
}

export interface DraftLobbyView {
  phase: 'setup' | 'drafting';
  scheduledAt: string | null;
  orderMode: 'slots' | 'random';
  serverTime: string;
  order: LobbyTeam[] | null;
  teams: LobbyTeam[];
  commissionerHere: boolean;
  canStart: boolean;
}

/** `3d 04:05:06`, `04:05:06`, or `5:06` until the draft. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${two(hours)}:${two(minutes)}:${two(seconds)}`;
  if (hours > 0) return `${two(hours)}:${two(minutes)}:${two(seconds)}`;
  return `${minutes}:${two(seconds)}`;
}

export interface DraftLobbyProps {
  api: ApiFetch;
  leagueId: string;
  queue: DraftQueue;
  now: () => number;
  /** Changes when a lobby event arrives (reminder, blocked start): check in again right away. */
  refresh: number;
  /** The draft may have started (the countdown ran out, or the lobby says so): reload the board. */
  onStarted: () => void;
  /** How often to check in (the server counts a check-in for 45 seconds). */
  heartbeatMs?: number;
}

/**
 * The draft room before the draft: a countdown to the scheduled start, the order, who is here, and
 * your queue. The commissioner can start the draft now.
 */
export function DraftLobby({
  api,
  leagueId,
  queue,
  now,
  refresh,
  onStarted,
  heartbeatMs = 15_000
}: DraftLobbyProps) {
  const [lobby, setLobby] = useState<DraftLobbyView | null>(null);
  // Server time minus this browser's, so the countdown matches the server's clock.
  const [skew, setSkew] = useState(0);
  const [tick, setTick] = useState(now);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<PlayerRef[]>([]);
  const started = useRef(onStarted);
  useEffect(() => {
    started.current = onStarted;
  });

  const checkIn = useCallback(async () => {
    try {
      const res = await api<DraftLobbyView>(`/leagues/${leagueId}/draft/lobby`, { method: 'POST' });
      setLobby(res.data);
      setSkew(Date.parse(res.data.serverTime) - now());
      setError(null);
      if (res.data.phase === 'drafting') started.current();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the draft room.');
    }
  }, [api, leagueId, now]);

  useEffect(() => {
    void checkIn();
    const id = setInterval(() => void checkIn(), heartbeatMs);
    return () => clearInterval(id);
  }, [checkIn, heartbeatMs, refresh]);

  useEffect(() => {
    const id = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(id);
  }, [now]);

  useEffect(() => {
    let cancelled = false;
    const query = q.trim();
    void api<{ players: PlayerRef[] }>('/players', { query: { q: query || undefined, limit: 10 } }).then(
      (res) => {
        if (!cancelled)
          setFound(res.data.players.map(({ id, name, team, position }) => ({ id, name, team, position })));
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [api, q]);

  const scheduledAt = lobby?.scheduledAt ?? null;
  const remaining = scheduledAt === null ? null : Date.parse(scheduledAt) - (tick + skew);
  const due = remaining !== null && remaining <= 0;
  // When the countdown runs out, the server starts the draft: look for the board (and keep
  // looking every few seconds, since the scheduler may take a moment).
  useEffect(() => {
    if (!due) return;
    started.current();
    const id = setInterval(() => started.current(), 3000);
    return () => clearInterval(id);
  }, [due]);

  async function startNow() {
    setStarting(true);
    setError(null);
    try {
      await api(`/leagues/${leagueId}/draft/start`, {
        method: 'POST',
        body: { randomizeOrder: lobby?.orderMode === 'random' }
      });
      started.current();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} ${e.fix ?? ''}`.trim() : 'Could not start the draft.');
    } finally {
      setStarting(false);
    }
  }

  if (lobby === null) {
    return error === null ? (
      <p className="text-muted-foreground">Opening the draft room…</p>
    ) : (
      <Alert variant="error" role="alert">
        {error}
      </Alert>
    );
  }

  const here = lobby.teams.filter((t) => t.here).length;
  return (
    <div className="space-y-4" data-testid="draft-lobby">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">
              {scheduledAt === null
                ? 'No draft time is set.'
                : `The draft starts ${new Date(scheduledAt).toLocaleString()}.`}
            </p>
            <p className="text-3xl font-semibold" data-testid="draft-countdown">
              {remaining === null
                ? 'Waiting for the commissioner'
                : due
                  ? 'Starting…'
                  : formatCountdown(remaining)}
            </p>
          </div>
          {lobby.canStart && (
            <Button onClick={() => void startNow()} loading={starting} disabled={starting}>
              Start now
            </Button>
          )}
        </CardBody>
      </Card>
      {error !== null && (
        <Alert variant="error" role="alert">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Draft order</CardTitle>
          </CardHeader>
          <CardBody>
            {lobby.order === null ? (
              <p className="text-muted-foreground">The order is shuffled when the draft starts.</p>
            ) : (
              <ol aria-label="Draft order" className="list-decimal pl-5">
                {lobby.order.map((t) => (
                  <li key={t.teamId}>{t.teamName}</li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              Who&apos;s here ({here} of {lobby.teams.length})
            </CardTitle>
          </CardHeader>
          <CardBody>
            <ul aria-label="Who's here" className="space-y-1">
              {lobby.teams.map((t) => (
                <li key={t.teamId} className="flex items-center justify-between gap-2">
                  <span>{t.teamName}</span>
                  <StatusBadge tone={t.here ? 'success' : 'neutral'}>
                    {t.seatType === 'agent' ? 'AI · here' : t.here ? 'Here' : 'Away'}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Your queue</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {queue.error !== null && (
              <Alert variant="error" role="alert">
                {queue.error}
              </Alert>
            )}
            {queue.players.length === 0 ? (
              <p className="text-muted-foreground">
                Line up the players you want. If your clock runs out, autopick takes the first one still
                available.
              </p>
            ) : (
              <ol aria-label="Your queue" className="divide-y divide-border">
                {queue.players.map((player, index) => (
                  <li key={player.id} className="flex items-center justify-between gap-2 py-1">
                    <span>
                      {index + 1}. {player.name}{' '}
                      <span className="text-muted-foreground">{player.position}</span>
                    </span>
                    <span className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={index === 0}
                        onClick={() => queue.move(player.id, -1)}
                        aria-label={`Move ${player.name} up`}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => queue.remove(player.id)}
                        aria-label={`Remove ${player.name} from the queue`}
                      >
                        ✕
                      </Button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <Input label="Find players" value={q} onChange={(e) => setQ(e.target.value)} />
            <ul aria-label="Players to queue" className="divide-y divide-border">
              {found.map((player) => (
                <li key={player.id} className="flex items-center justify-between gap-2 py-1">
                  <span>
                    {player.name}{' '}
                    <span className="text-muted-foreground">
                      {player.position} · {player.team ?? 'FA'}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={queue.has(player.id)}
                    onClick={() => queue.add(player)}
                    aria-label={`Queue ${player.name}`}
                  >
                    Queue
                  </Button>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
