import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ErrorState,
  SegmentedControl,
  StatusBadge
} from '@readysetcloud/ui';
import { ApiError, apiFetch, type ApiFetch } from '../api';
import type { RealtimeInfo } from '../chat/api';
import { Confetti } from '../motion/Confetti';
import { useTitleBadge } from '../motion/decor';
import { useArrivals } from '../motion/useArrivals';
import { connectMomentoEvents, useLiveEvents, type EventConnect } from '../realtime/leagueEvents';
import { BestAvailableTable } from './BestAvailableTable';
import { DepthChart } from './DepthChart';
import { PlayerCard } from './PlayerCard';
import type { BoardSort } from './research';
import {
  formatClock,
  overallPick,
  secondsUntil,
  type PlayerRef,
  type DraftBoard,
  type DraftRecap,
  type DraftRecapEntry
} from './board';
import { DraftLobby } from './DraftLobby';
import { useDraftQueue } from './queue';

export interface DraftPageProps {
  /** The API client (tests pass a fake). */
  api?: ApiFetch;
  /** How often to refresh the board when realtime is off or has failed. */
  pollMs?: number;
  /** How often to refresh anyway while live, in case an event is missed. */
  livePollMs?: number;
  /** Subscribes to live league events (tests pass a fake). */
  connect?: EventConnect;
  /** The wall clock for the countdown. */
  now?: () => number;
}

function toApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(0, { code: 'NETWORK', message: 'Could not reach the server.' });
}

/** The events that change the board. */
export const DRAFT_EVENTS = [
  'Draft Pick Made',
  'Draft Turn Started',
  'Draft Completed',
  // The commissioner froze or restarted the clock: reload so the countdown stops or restarts now.
  'Draft Paused',
  'Draft Resumed',
  // Before the draft: the lobby's reminder and a scheduled start that could not happen.
  'Draft Starting Soon',
  'Draft Start Blocked'
] as const;

const STATUS = {
  in_progress: { tone: 'success', label: 'Live' },
  paused: { tone: 'warning', label: 'Paused' },
  complete: { tone: 'neutral', label: 'Complete' }
} as const;

/** The draft room: the board grid, the clock, the best available players, and your pick. */
export function DraftPage({
  api = apiFetch,
  pollMs = 3000,
  livePollMs = 30_000,
  connect = connectMomentoEvents,
  now = Date.now
}: DraftPageProps) {
  const { leagueId = '' } = useParams();
  const queue = useDraftQueue(leagueId, api);
  const [board, setBoard] = useState<DraftBoard | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [pickError, setPickError] = useState<ApiError | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [position, setPosition] = useState('');
  const [sort, setSort] = useState<BoardSort>('rank');
  const [card, setCard] = useState<PlayerRef | null>(null);
  const [view, setView] = useState<'board' | 'depth'>('board');
  const [tick, setTick] = useState(now);
  // Your own pick just went in: a burst of confetti and a line naming the player.
  const [myPick, setMyPick] = useState<{ name: string; n: number } | null>(null);
  // Bumped by lobby events, so the lobby checks in again at once.
  const [lobbyRefresh, setLobbyRefresh] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await api<DraftBoard>(`/leagues/${leagueId}/draft`, {
        query: {
          q: q.trim() || undefined,
          position: position || undefined,
          limit: 25,
          sort: sort === 'rank' ? undefined : sort
        }
      });
      setBoard(res.data);
      setLoadError(null);
    } catch (error) {
      setLoadError(toApiError(error));
    }
  }, [api, leagueId, q, position, sort]);

  const realtime = async (id: string) => (await api<RealtimeInfo>(`/leagues/${id}/realtime`)).data;
  const live = useLiveEvents({
    leagueId,
    types: DRAFT_EVENTS,
    realtime,
    connect,
    onEvent: (event) => {
      if (event.detailType === 'Draft Starting Soon' || event.detailType === 'Draft Start Blocked') {
        setLobbyRefresh((n) => n + 1);
      }
      void load();
    }
  });
  const interval = live === 'live' ? livePollMs : pollMs;

  useEffect(() => {
    void load();
  }, [load]);

  // Going live only swaps the timer; it doesn't refetch the board.
  useEffect(() => {
    const id = setInterval(() => void load(), interval);
    return () => clearInterval(id);
  }, [load, interval]);

  useEffect(() => {
    const id = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(id);
  }, [now]);

  // New picks flip onto the board; the picks already made when the board first loads don't.
  const arrived = useArrivals(board === null ? null : board.picks.map((p) => String(p.overall)));
  const yourTurn =
    board !== null &&
    board.status === 'in_progress' &&
    board.onTheClock !== null &&
    board.onTheClock.teamId === board.yourTeamId;
  useTitleBadge(yourTurn, 'Your pick!');

  async function draft(playerId: string, overall: number, name: string) {
    setPicking(playerId);
    setPickError(null);
    try {
      await api(`/leagues/${leagueId}/draft/picks`, { method: 'POST', body: { playerId, pick: overall } });
      setMyPick((d) => ({ name, n: (d?.n ?? 0) + 1 }));
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
        <DraftLobby
          api={api}
          leagueId={leagueId}
          queue={queue}
          now={now}
          refresh={lobbyRefresh}
          onStarted={() => void load()}
        />
      ) : (
        <ErrorState message={loadError.message} action={{ label: 'Try again', onClick: () => void load() }} />
      );
  } else {
    const clock = board.onTheClock;
    const mine = yourTurn;
    const current = clock === null ? 0 : clock.overall;
    const seconds =
      clock === null
        ? null
        : clock.deadline === null
          ? clock.secondsLeft
          : secondsUntil(clock.deadline, tick);
    const byOverall = new Map(board.picks.map((p) => [p.overall, p]));
    const roster = board.rosters.find((r) => r.teamId === board.yourTeamId);
    const drafted = new Set(board.picks.map((p) => p.player.id));
    const queued = queue.players.filter((p) => !drafted.has(p.id));
    const open = (player: PlayerRef) => (
      <button type="button" className="text-left hover:underline" onClick={() => setCard(player)}>
        {player.name}
      </button>
    );
    content = (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge tone={STATUS[board.status].tone}>{STATUS[board.status].label}</StatusBadge>
          <span className="text-sm text-muted-foreground" data-testid="draft-updates">
            {live === 'live' ? 'Updating live' : `Refreshing every ${Math.round(pollMs / 1000)}s`}
          </span>
          {clock !== null && (
            <p>
              <strong>{clock.teamName}</strong> is on the clock: round {clock.round}, pick {clock.overall}.{' '}
              <span data-testid="pick-clock" className="font-mono">
                {formatClock(seconds ?? 0)}
              </span>
            </p>
          )}
        </div>
        {mine && (
          // A few pulses to catch your eye, then it settles.
          <div className="motion-attention">
            <Alert variant="info">You are on the clock! Pick a player below.</Alert>
          </div>
        )}
        {myPick !== null && (
          <p key={myPick.n} role="status" className="motion-pop font-semibold text-success-700">
            You drafted {myPick.name}!
          </p>
        )}
        {!mine && board.yourNextPick !== null && (
          <p className="text-muted-foreground">
            Your next pick is #{board.yourNextPick.overall}, {board.yourNextPick.picksAway} pick(s) away.
          </p>
        )}
        {board.status === 'complete' && (
          <Alert variant="success">The draft is complete. Good luck this season!</Alert>
        )}
        {board.status === 'paused' && (
          <Alert variant="info">The commissioner paused the draft. The clock is frozen.</Alert>
        )}
        {board.recap != null && <DraftRecapCard recap={board.recap} />}
        {pickError !== null && (
          <Alert variant="error" role="alert">
            {pickError.message} {pickError.fix}
          </Alert>
        )}

        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{view === 'board' ? 'Board' : 'Depth'}</CardTitle>
            <SegmentedControl
              aria-label="Board view"
              value={view}
              onChange={setView}
              options={[
                { value: 'board', label: 'Board' },
                { value: 'depth', label: 'Depth' }
              ]}
            />
          </CardHeader>
          <CardBody className="overflow-x-auto">
            {view === 'depth' ? (
              <DepthChart api={api} leagueId={leagueId} version={board.picks.length} onOpen={setCard} />
            ) : (
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
                            title={pick?.reason ?? undefined}
                          >
                            {pick === undefined ? (
                              onClock ? (
                                'On the clock'
                              ) : (
                                ''
                              )
                            ) : (
                              <span
                                key={pick.player.id}
                                className={arrived(String(overall)) ? 'motion-flip-in' : undefined}
                              >
                                {open(pick.player)} ({pick.player.position}){pick.auto ? ' · auto' : ''}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Best available</CardTitle>
            </CardHeader>
            <CardBody>
              <BestAvailableTable
                rows={board.bestAvailable}
                sort={sort}
                onSort={setSort}
                position={position}
                onPosition={setPosition}
                q={q}
                onQuery={setQ}
                isQueued={queue.has}
                onQueue={queue.add}
                canDraft={mine}
                picking={picking}
                onDraft={(player) => void draft(player.id, current, player.name)}
                onOpen={setCard}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Your queue</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2">
              {queue.error !== null && (
                <Alert variant="error" role="alert">
                  {queue.error}
                </Alert>
              )}
              {queued.length === 0 ? (
                <p className="text-muted-foreground">
                  Queue players from Best available to line up your next picks. If your clock runs out,
                  autopick takes the first one still available.
                </p>
              ) : (
                <ol aria-label="Your queue" className="divide-y divide-border">
                  {queued.map((player, index) => (
                    <li key={player.id} className="flex items-center justify-between gap-2 py-2">
                      <span>
                        {index + 1}. {open(player)}{' '}
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
                        <Button
                          size="sm"
                          disabled={!mine || picking !== null}
                          loading={picking === player.id}
                          onClick={() => void draft(player.id, current, player.name)}
                          aria-label={`Draft ${player.name} from the queue`}
                        >
                          Pick
                        </Button>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
          <Card className="md:col-span-3">
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
                    {open(p)} ({p.position})
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>
        {card !== null && (
          <PlayerCard
            api={api}
            leagueId={leagueId}
            player={card}
            onClose={() => setCard(null)}
            queued={queue.has(card.id)}
            onQueue={queue.add}
            canDraft={mine && !drafted.has(card.id)}
            picking={picking === card.id}
            onDraft={(player) => void draft(player.id, current, player.name).then(() => setCard(null))}
          />
        )}
      </div>
    );
  }

  return (
    <div data-testid="league-section-draft" className="space-y-4">
      <h2 className="text-xl font-semibold">Draft</h2>
      {myPick !== null && <Confetti key={myPick.n} size="burst" />}
      {content}
    </div>
  );
}

function recapPick(e: DraftRecapEntry): string {
  const adp = e.adp === null ? '' : ` (ADP ${e.adp})`;
  return `${e.teamName}: ${e.player.name} at pick ${e.overall}${adp}`;
}

/** The short recap shown once the draft is complete: steals, reaches, and each agent's first pick. */
function DraftRecapCard({ recap }: { recap: DraftRecap }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Draft recap</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm" data-testid="draft-recap">
        {recap.steals.length > 0 && (
          <p>
            <strong>Steals:</strong> {recap.steals.map(recapPick).join('; ')}
          </p>
        )}
        {recap.reaches.length > 0 && (
          <p>
            <strong>Reaches:</strong> {recap.reaches.map(recapPick).join('; ')}
          </p>
        )}
        {recap.agentPicks.length > 0 && (
          <ul aria-label="AI first picks" className="space-y-1">
            {recap.agentPicks.map((e) => (
              <li key={e.teamId}>
                <strong>{e.teamName}</strong> took {e.player.name} at pick {e.overall}
                {e.reason !== null && <span className="text-muted-foreground">: “{e.reason}”</span>}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
