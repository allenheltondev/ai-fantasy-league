import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react';
import { useParams } from 'react-router';
import { Alert, Card, CardBody, CardHeader, CardTitle, ErrorState } from '@readysetcloud/ui';
import { ApiError, apiFetch, type ApiFetch } from '../api';
import { createChatApi, type ChatApi, type RealtimeInfo } from '../chat/api';
import { resolveRoom } from '../chat/ChatPage';
import { connectMomento, type Connect } from '../chat/realtime';
import { RoomChat } from '../chat/RoomChat';
import { Confetti } from '../motion/Confetti';
import { useTitleBadge } from '../motion/decor';
import { useArrivals } from '../motion/useArrivals';
import { connectMomentoEvents, useLiveEvents, type EventConnect } from '../realtime/leagueEvents';
import { BestAvailableTable } from './BestAvailableTable';
import { BoardGrid, PickTicker } from './BoardViews';
import { DepthChart } from './DepthChart';
import { DraftTopBar } from './DraftTopBar';
import { PlayerCard } from './PlayerCard';
import { QueuePanel, RosterPanel } from './Panels';
import type { BoardSort } from './research';
import {
  secondsUntil,
  shortName,
  type PlayerRef,
  type DraftBoard,
  type DraftRecap,
  type DraftRecapEntry
} from './board';
import { DraftLobby } from './DraftLobby';
import { useDraftQueue } from './queue';
import { useDraftSound, playChime } from './sound';

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
  /** The draft chat's API and live connection (tests pass fakes). */
  chatApi?: ChatApi;
  chatConnect?: Connect;
  /** The your-turn chime (tests pass a spy). */
  chime?: () => void;
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

/** Available players the room lists. */
export const AVAILABLE_LIMIT = 50;
/** The desktop room: everything on one screen at this width and up. */
export const WIDE_QUERY = '(min-width: 1024px)';
/** The desktop room spreads past the page column up to this width, this far from the screen's edges. */
const MAX_ROOM_WIDTH = 1680;
const ROOM_GUTTER = 16;
/** Below this height the desktop room stops shrinking and the page scrolls instead. */
const MIN_ROOM_HEIGHT = 440;
/** How long the "You're up!" moment stays. */
const YOURE_UP_MS = 2400;

/** True while `query` matches; true when the browser cannot tell (tests, old browsers). */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * The height that makes `ref` end at the bottom of the viewport, so the page itself does not scroll
 * (the room's panels scroll instead). Re-measured on resize and whenever `deps` change.
 */
function useFitScreen(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  deps: unknown
): CSSProperties | null {
  const [fit, setFit] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!enabled) {
      setFit(null);
      return undefined;
    }
    const measure = () => {
      const el = ref.current;
      const parent = el?.parentElement;
      if (el === null || parent === null || parent === undefined) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      // Break out of the page's content column: the room uses the screen's width, up to a cap.
      const screen = document.documentElement.clientWidth;
      const width = Math.max(parent.clientWidth, Math.min(screen - 2 * ROOM_GUTTER, MAX_ROOM_WIDTH));
      const left = parent.getBoundingClientRect().left;
      setFit({
        height: Math.max(MIN_ROOM_HEIGHT, Math.floor(window.innerHeight - top - spaceBelow(el))),
        width,
        marginLeft: Math.min(0, Math.round((screen - width) / 2 - left))
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref, enabled, deps]);
  return fit;
}

/**
 * What the layout puts below `el` in the flow, up to the body: later siblings and each ancestor's
 * bottom padding, border and margin (the page's bottom padding, say). Fixed and absolute elements
 * (drawers, confetti) take no room.
 */
export function spaceBelow(el: HTMLElement): number {
  let below = 0;
  let node: HTMLElement = el;
  while (node.parentElement !== null && node !== document.body) {
    const parent: HTMLElement = node.parentElement;
    for (let sib = node.nextElementSibling; sib !== null; sib = sib.nextElementSibling) {
      const position = getComputedStyle(sib).position;
      if (position !== 'fixed' && position !== 'absolute') below += sib.getBoundingClientRect().height;
    }
    const style = getComputedStyle(parent);
    below +=
      (parseFloat(style.paddingBottom) || 0) +
      (parseFloat(style.borderBottomWidth) || 0) +
      (parseFloat(getComputedStyle(node).marginBottom) || 0);
    node = parent;
  }
  return below;
}

type CenterView = 'players' | 'board' | 'depth';
type SideTab = 'roster' | 'queue' | 'chat';
type PhoneTab = 'players' | 'queue' | 'roster' | 'board' | 'chat';

/** An accessible tab strip; `panelId` is the id of the panel the tabs control. */
function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  panelId,
  className = '',
  tabClassName = ''
}: {
  label: string;
  tabs: { value: T; label: ReactNode; name: string }[];
  value: T;
  onChange(value: T): void;
  panelId: string;
  className?: string;
  tabClassName?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={`flex ${className}`}>
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`${panelId}-tab-${tab.value}`}
            aria-selected={selected}
            aria-controls={panelId}
            aria-label={tab.name}
            onClick={() => onChange(tab.value)}
            className={`${tabClassName} ${
              selected
                ? 'border-primary-500 text-primary-800'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** The draft room: the clock, the board and ticker, the best available players, your roster and queue, and chat. */
export function DraftPage({
  api = apiFetch,
  pollMs = 3000,
  livePollMs = 30_000,
  connect = connectMomentoEvents,
  now = Date.now,
  chatApi,
  chatConnect = connectMomento,
  chime = playChime
}: DraftPageProps) {
  const { leagueId = '' } = useParams();
  const queue = useDraftQueue(leagueId, api);
  const chat = useMemo(() => chatApi ?? createChatApi(api), [chatApi, api]);
  const sound = useDraftSound(chime);
  const wide = useMediaQuery(WIDE_QUERY);
  const [board, setBoard] = useState<DraftBoard | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [pickError, setPickError] = useState<ApiError | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [clockBusy, setClockBusy] = useState(false);
  const [q, setQ] = useState('');
  const [position, setPosition] = useState('');
  const [sort, setSort] = useState<BoardSort>('rank');
  const [card, setCard] = useState<PlayerRef | null>(null);
  // Null until you pick a view: players while drafting, the board once it is over.
  const [centerChoice, setCenter] = useState<CenterView | null>(null);
  const [side, setSide] = useState<SideTab>('roster');
  const [phoneChoice, setPhoneTab] = useState<PhoneTab | null>(null);
  const [tick, setTick] = useState(now);
  // Your own pick just went in: a line naming the player (and confetti for your first).
  const [myPick, setMyPick] = useState<{ name: string; n: number; first: boolean } | null>(null);
  const [youreUp, setYoureUp] = useState(0);
  // Bumped by lobby events, so the lobby checks in again at once.
  const [lobbyRefresh, setLobbyRefresh] = useState(0);
  const room = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<DraftBoard>(`/leagues/${leagueId}/draft`, {
        query: {
          q: q.trim() || undefined,
          position: position || undefined,
          limit: AVAILABLE_LIMIT,
          sort: sort === 'rank' ? undefined : sort
        }
      });
      setBoard(res.data);
      setAllowed(res.league?.allowedActions ?? []);
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

  // New picks slide onto the ticker and flip onto the board; the ones there on first load don't.
  const arrived = useArrivals(board === null ? null : board.picks.map((p) => String(p.overall)));
  const yourTurn =
    board !== null &&
    board.status === 'in_progress' &&
    board.onTheClock !== null &&
    board.onTheClock.teamId === board.yourTeamId;
  useTitleBadge(yourTurn, 'Your pick!');

  // "You're up!": a moment (and the chime, when on) each time your turn starts.
  const turnKey = yourTurn ? (board?.onTheClock?.overall ?? null) : null;
  const { play } = sound;
  useEffect(() => {
    if (turnKey === null) return undefined;
    setYoureUp(turnKey);
    play();
    const id = setTimeout(() => setYoureUp(0), YOURE_UP_MS);
    return () => clearTimeout(id);
  }, [turnKey, play]);

  const fit = useFitScreen(room, wide && board !== null, board === null ? 0 : 1);

  async function draft(playerId: string, overall: number, name: string) {
    const before = board?.rosters.find((r) => r.teamId === board.yourTeamId)?.players.length ?? 0;
    setPicking(playerId);
    setPickError(null);
    try {
      await api(`/leagues/${leagueId}/draft/picks`, { method: 'POST', body: { playerId, pick: overall } });
      setMyPick((d) => ({ name, n: (d?.n ?? 0) + 1, first: before === 0 }));
      await load();
    } catch (error) {
      setPickError(toApiError(error));
    } finally {
      setPicking(null);
    }
  }

  async function setClock(action: 'pause' | 'resume') {
    setClockBusy(true);
    setPickError(null);
    try {
      await api(`/leagues/${leagueId}/draft/${action}`, { method: 'POST', body: {} });
      await load();
    } catch (error) {
      setPickError(toApiError(error));
    } finally {
      setClockBusy(false);
    }
  }

  if (board === null) {
    return (
      <div data-testid="league-section-draft" className="space-y-4">
        <h2 className="text-xl font-semibold">Draft</h2>
        {loadError === null ? (
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
          <ErrorState
            message={loadError.message}
            action={{ label: 'Try again', onClick: () => void load() }}
          />
        )}
      </div>
    );
  }

  const done = board.status === 'complete';
  const center = centerChoice ?? (done ? 'board' : 'players');
  const phoneTab = phoneChoice ?? (done ? 'board' : 'players');
  const clock = board.onTheClock;
  const current = clock === null ? 0 : clock.overall;
  const seconds =
    clock === null ? null : clock.deadline === null ? clock.secondsLeft : secondsUntil(clock.deadline, tick);
  const drafted = new Set(board.picks.map((p) => p.player.id));
  const likelyGone = board.likelyGone ?? [];
  const goneIds = new Set(likelyGone.map((p) => p.id));
  const queuedCount = queue.players.filter((p) => !drafted.has(p.id)).length;
  const canCommission = allowed.includes('pause_draft') || allowed.includes('resume_draft');
  const onDraft = (player: PlayerRef) => void draft(player.id, current, player.name);

  const topBar = (
    <DraftTopBar
      board={board}
      seconds={seconds}
      yourTurn={yourTurn}
      live={live === 'live'}
      updates={live === 'live' ? 'Updating live' : `Refreshing every ${Math.round(pollMs / 1000)}s`}
      sound={sound}
      commissioner={
        canCommission
          ? {
              busy: clockBusy,
              onPause: () => void setClock('pause'),
              onResume: () => void setClock('resume')
            }
          : null
      }
    />
  );

  const alerts = (
    <>
      {myPick !== null && (
        <p key={myPick.n} role="status" className="motion-pop text-sm font-semibold text-success-700">
          You drafted {myPick.name}!
        </p>
      )}
      {pickError !== null && (
        <Alert variant="error" role="alert">
          {pickError.message} {pickError.fix}
        </Alert>
      )}
      {board.recap != null && <DraftRecapCard recap={board.recap} />}
    </>
  );

  // Positions the teams ahead of you will likely thin out: "TE 5 left in the top 100, 2 likely gone".
  const runs = (board.scarcity ?? []).filter((s) => s.likelyGone > 0);
  const insights = likelyGone.length > 0 && board.yourNextPick !== null && (
    <div className="space-y-0.5 text-xs text-muted-foreground" data-testid="likely-gone">
      <p className="truncate">
        <span className="font-semibold text-foreground">
          Likely gone before your {yourTurn ? 'next ' : ''}pick:
        </span>{' '}
        {likelyGone.map((p) => shortName(p)).join(', ')}
      </p>
      {runs.length > 0 && (
        <p className="truncate" data-testid="scarcity">
          <span className="font-semibold text-foreground">Left in the top 100:</span>{' '}
          {runs.map((s) => `${s.left} ${s.position} (${s.likelyGone} likely gone)`).join(' · ')}
        </p>
      )}
    </div>
  );

  const players = (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {insights}
      <BestAvailableTable
        rows={board.bestAvailable}
        sort={sort}
        onSort={setSort}
        position={position}
        onPosition={setPosition}
        q={q}
        onQuery={setQ}
        isQueued={queue.has}
        queueReady={queue.ready}
        onQueue={queue.add}
        canDraft={yourTurn}
        picking={picking}
        onDraft={onDraft}
        onOpen={setCard}
        likelyGone={goneIds}
        scarcity={board.scarcity}
      />
    </div>
  );
  const grid = <BoardGrid board={board} arrived={arrived} onOpen={setCard} />;
  const depth = <DepthChart api={api} leagueId={leagueId} version={board.picks.length} onOpen={setCard} />;
  const ticker = <PickTicker board={board} arrived={arrived} onOpen={setCard} />;
  const roster = <RosterPanel board={board} onOpen={setCard} />;
  const queuePanel = (
    <QueuePanel
      queue={queue}
      drafted={drafted}
      canDraft={yourTurn}
      picking={picking}
      onDraft={onDraft}
      onOpen={setCard}
    />
  );
  const chatPanel = (
    <RoomChat
      leagueId={leagueId}
      room={resolveRoom('draft', [], null, [], null)}
      api={chat}
      connect={chatConnect}
      onOther={() => undefined}
      onSeen={() => void chat.markRead(leagueId, 'draft').catch(() => undefined)}
      panel
    />
  );
  const queueLabel = `Queue${queuedCount > 0 ? ` (${queuedCount})` : ''}`;
  const TAB = 'border-b-2 px-3 py-1.5 text-sm font-medium';

  let layout: ReactNode;
  if (wide) {
    layout = (
      <div
        ref={room}
        data-testid="draft-room"
        data-layout="wide"
        style={fit ?? undefined}
        className="flex min-h-0 flex-col gap-2"
      >
        {topBar}
        {ticker}
        {alerts}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_20rem] gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="flex min-h-0 flex-col gap-2" aria-label="Players and board">
            <Tabs<CenterView>
              label="Main view"
              value={center}
              onChange={setCenter}
              panelId="draft-center"
              className="border-b border-border"
              tabClassName={TAB}
              tabs={[
                { value: 'players', label: 'Players', name: 'Players' },
                { value: 'board', label: 'Board', name: 'Board' },
                { value: 'depth', label: 'Depth', name: 'Depth' }
              ]}
            />
            <div id="draft-center" role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
              {center === 'players' ? (
                players
              ) : center === 'board' ? (
                grid
              ) : (
                <div className="h-full overflow-auto">{depth}</div>
              )}
            </div>
          </section>
          <aside
            className="flex min-h-0 flex-col gap-2 rounded-lg border border-border bg-surface p-2"
            aria-label="Your team"
          >
            <Tabs<SideTab>
              label="Your team"
              value={side}
              onChange={setSide}
              panelId="draft-side"
              className="border-b border-border"
              tabClassName={`flex-1 ${TAB}`}
              tabs={[
                { value: 'roster', label: 'My roster', name: 'My roster' },
                { value: 'queue', label: queueLabel, name: 'Queue' },
                { value: 'chat', label: 'Chat', name: 'Chat' }
              ]}
            />
            <div id="draft-side" role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
              {side === 'roster' ? roster : side === 'queue' ? queuePanel : chatPanel}
            </div>
          </aside>
        </div>
      </div>
    );
  } else {
    const body: Record<PhoneTab, ReactNode> = {
      players,
      queue: queuePanel,
      roster,
      board: (
        <div className="space-y-3">
          {ticker}
          <Tabs<CenterView>
            label="Board view"
            value={center === 'depth' ? 'depth' : 'board'}
            onChange={setCenter}
            panelId="draft-phone-board"
            className="border-b border-border"
            tabClassName={TAB}
            tabs={[
              { value: 'board', label: 'Board', name: 'Board' },
              { value: 'depth', label: 'Depth', name: 'Depth' }
            ]}
          />
          <div id="draft-phone-board" role="tabpanel" className="overflow-x-auto">
            {center === 'depth' ? depth : grid}
          </div>
        </div>
      ),
      chat: <div className="h-[60vh]">{chatPanel}</div>
    };
    layout = (
      <div ref={room} data-testid="draft-room" data-layout="phone" className="space-y-3 pb-20">
        <div className="sticky top-0 z-20 bg-background py-1">{topBar}</div>
        {alerts}
        <div id="draft-phone" role="tabpanel" className="min-w-0">
          {body[phoneTab]}
        </div>
        <Tabs<PhoneTab>
          label="Draft room"
          value={phoneTab}
          onChange={setPhoneTab}
          panelId="draft-phone"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
          tabClassName="flex min-h-11 flex-1 items-center justify-center border-t-2 text-xs font-medium"
          tabs={[
            { value: 'players', label: 'Players', name: 'Players' },
            { value: 'queue', label: queueLabel, name: 'Queue' },
            { value: 'roster', label: 'Roster', name: 'Roster' },
            { value: 'board', label: 'Board', name: 'Board' },
            { value: 'chat', label: 'Chat', name: 'Chat' }
          ]}
        />
      </div>
    );
  }

  return (
    <div data-testid="league-section-draft">
      <h2 className="sr-only">Draft room</h2>
      {myPick?.first === true && <Confetti key={myPick.n} size="burst" />}
      {youreUp !== 0 && (
        <div
          key={youreUp}
          role="status"
          data-testid="youre-up"
          className="motion-pop pointer-events-none fixed inset-x-0 top-1/3 z-50 mx-auto w-fit rounded-2xl border-2 border-primary-500 bg-surface px-10 py-5 text-4xl font-bold text-primary-800 shadow-lg"
        >
          You're up!
        </div>
      )}
      {layout}
      {card !== null && (
        <PlayerCard
          api={api}
          leagueId={leagueId}
          player={card}
          onClose={() => setCard(null)}
          queued={queue.has(card.id)}
          queueReady={queue.ready}
          onQueue={queue.add}
          canDraft={yourTurn && !drafted.has(card.id)}
          picking={picking === card.id}
          onDraft={(player) => void draft(player.id, current, player.name).then(() => setCard(null))}
        />
      )}
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
      <CardBody className="max-h-48 space-y-3 overflow-y-auto text-sm" data-testid="draft-recap">
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
