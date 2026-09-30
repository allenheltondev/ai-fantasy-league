import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core';
import { Button, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import { ApiError } from '../../api/client';
import type { Roster, RosterEntry } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { AnimatedNumber } from '../../motion/AnimatedNumber';
import { stagger } from '../../motion/decor';
import { usePrefersReducedMotion } from '../../motion/reducedMotion';
import {
  applyMoves,
  changes,
  isStarter,
  movesFor,
  place,
  placed,
  placementOf,
  projectedTotal,
  seats,
  statusLabel,
  willPlay,
  type Change,
  type Placement,
  type Target
} from './slots';
import { locksIn, periodLabel } from './gameState';
import { PlayerHeadshot } from '../../players/PlayerHeadshot';
import { PlayerLink, useOpenPlayerCard } from '../../players/PlayerLink';

const pts = (n: number) => n.toFixed(1);
const signed = (n: number, decimals = 1) =>
  `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(decimals)}`;
/** Lineup totals to the cent, as the scoreboard shows them. */
const total2 = (n: number) => n.toFixed(2);

const KICKOFF = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** "vs MIA · Sun 1:00 PM", "@ KC · Thu 8:20 PM", or "Bye". */
export function gameLine(entry: RosterEntry): string {
  if (entry.onBye || entry.kickoff === null) return 'Bye';
  const opponent = entry.opponent;
  const versus = opponent == null ? '' : `${opponent.home ? 'vs' : '@'} ${opponent.team} · `;
  return `${versus}${KICKOFF.format(new Date(entry.kickoff))}`;
}

/** What a player adds to the starters' projection in `slot`: 0 on the bench or when he will not play. */
function contribution(entry: RosterEntry, slot: string): number {
  return isStarter(slot) && willPlay(entry) ? (entry.projectedPoints ?? 0) : 0;
}

/** A target's words, for buttons and screen-reader announcements. */
function targetLabel(target: Target, rows: readonly RosterEntry[]): string {
  if (target.kind === 'bench') return 'the bench';
  if (target.kind === 'ir') return 'IR';
  const other = target.kind === 'player' ? target.playerId : target.occupant;
  const name = rows.find((p) => p.player.id === other)?.player.name;
  const slot = target.kind === 'slot' ? target.slot : 'the bench';
  return name === undefined ? slot : `${slot}, swapping with ${name}`;
}

/** What a screen reader hears while a player is dragged; targets carry their words as `label`. */
export function dragAnnouncements(nameOf: (id: string) => string): Announcements {
  const who = (id: string | number) => nameOf(String(id));
  const where = (over: { data: { current?: Record<string, unknown> } }) => String(over.data.current?.label);
  return {
    onDragStart: ({ active }) => `Picked up ${who(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over === null ? `${who(active.id)} is not over a slot.` : `${who(active.id)} is over ${where(over)}.`,
    onDragEnd: ({ active, over }) =>
      over === null
        ? `${who(active.id)} was dropped back where he was.`
        : `${who(active.id)} was dropped on ${where(over)}.`,
    onDragCancel: ({ active }) => `Moving ${who(active.id)} was cancelled.`
  };
}

/**
 * The lineup editor (#176): starters by slot and the bench, each player with his projection under
 * league scoring, opponent, kickoff, and availability. Players move by drag and drop, or by
 * choosing a player and then where he goes (keyboard, screen readers, and tap-to-swap on a phone).
 * Changes stay local, with the projected total and its change, until Save sends them to set_lineup.
 */
export function LineupBoard(props: {
  leagueId: string;
  teamId: string;
  data: Roster;
  onSaved: (warnings: { code: string; message: string }[]) => void;
  /**
   * A save lost the race with a kickoff (PLAYER_LOCKED, #193): the names of the players who locked.
   * The page says so and reloads the lineup.
   */
  onLocked?: (names: string[]) => void;
  /** The clock the lock countdowns read (ms); the page ticks it. */
  now: number;
  /**
   * A player a notification pointed at (#200, `?player=`): his row is highlighted and scrolled to,
   * and a starter who can still move starts selected, so one tap on a bench player replaces him.
   */
  highlight?: string | null;
  /** Players a pending trade would send away: their rows say so. */
  onTheBlock?: ReadonlySet<string>;
}) {
  const { data } = props;
  const api = useLeagueApi();
  const reduced = usePrefersReducedMotion();
  const saved = useMemo(() => placementOf(data.players), [data.players]);
  const [placement, setPlacement] = useState<Placement>(saved);
  const spotlight = data.players.find((p) => p.player.id === props.highlight);
  const [selected, setSelected] = useState<string | null>(
    spotlight !== undefined && !spotlight.locked && isStarter(spotlight.slot) ? spotlight.player.id : null
  );
  const openCard = useOpenPlayerCard();
  const [dragging, setDragging] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [announcement, setAnnouncement] = useState('');

  const rows = placed(data.players, placement);
  const byId = new Map(rows.map((p) => [p.player.id, p]));
  const pending = changes(data.players, placement);
  const savedTotal = projectedTotal(data.players, saved);
  const total = projectedTotal(data.players, placement);
  const moving = dragging ?? selected;
  const mover = byId.get(String(moving));
  const optimal = data.optimal ?? null;
  const optimalPlacement = optimal === null ? null : applyMoves(data.players, optimal.moves);
  const alreadyOptimal = optimalPlacement !== null && changes(rows, optimalPlacement).length === 0;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // A long press starts a drag on a phone, so a tap still selects and a swipe still scrolls.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } })
  );

  const spotlightId = spotlight?.player.id ?? null;
  useEffect(() => {
    if (spotlightId === null) return;
    document
      .querySelector(`[data-highlighted="true"]`)
      ?.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [spotlightId, reduced]);

  useEffect(() => {
    if (selected === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null);
        setAnnouncement('Move cancelled.');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  /** The placement if the moving player went to `target`, or null when he cannot (or none moves). */
  const attempt = (target: Target): Placement | null =>
    place(data.players, data.slots, placement, String(moving), target);

  /** Only ever called for a target `attempt` allows: every caller checks it first. */
  const moveTo = (target: Target) => {
    setSelected(null);
    setPlacement(attempt(target) as Placement);
    setProblem(null);
    setAnnouncement(`${String(mover?.player.name)} moved to ${targetLabel(target, rows)}.`);
  };

  const choose = (entry: RosterEntry) => {
    if (selected === entry.player.id) {
      setSelected(null);
      setAnnouncement('Move cancelled.');
      return;
    }
    setSelected(entry.player.id);
    setAnnouncement(
      `${entry.player.name} selected. Choose a highlighted slot or player to move him there, or press Escape to cancel.`
    );
  };

  /** Offered only when there is an optimal lineup (the button is disabled otherwise). */
  const optimize = () => {
    const next = optimalPlacement as Placement;
    setSelected(null);
    setPlacement(next);
    setProblem(null);
    setAnnouncement(
      `Optimized: ${changes(data.players, next).length} changes, projected ${total2(Number(optimal?.projectedPoints))}. Review and save.`
    );
  };

  const discard = () => {
    setPlacement(saved);
    setSelected(null);
    setProblem(null);
    setAnnouncement('Changes discarded.');
  };

  /** Saves the working copy, or `next` (the one-tap "Set my lineup"). */
  const save = (next: Placement = placement) => {
    setSaving(true);
    setProblem(null);
    api.setLineup(props.leagueId, props.teamId, data.week, movesFor(data.players, next)).then(
      (res) => {
        setSaving(false);
        setAnnouncement('Lineup saved.');
        props.onSaved(res.warnings);
      },
      (error: unknown) => {
        setSaving(false);
        if (error instanceof ApiError && error.code === 'PLAYER_LOCKED' && props.onLocked !== undefined) {
          props.onLocked(lockedNames(error.details, data.players));
          return;
        }
        setProblem(error);
      }
    );
  };

  const onDragStart = (e: DragStartEvent) => {
    setSelected(null);
    setDragging(String(e.active.id));
  };
  const onDragEnd = (e: DragEndEvent) => {
    const target = e.over?.data.current?.target as Target | undefined;
    if (target !== undefined && attempt(target) !== null) moveTo(target);
    setDragging(null);
  };

  const announcements = dragAnnouncements((id) => String(byId.get(id)?.player.name));

  const bench = rows.filter((p) => p.slot === 'BN');
  const ir = rows.filter((p) => p.slot === 'IR');
  const irRoom = data.slots.find((s) => s.slot === 'IR')?.count ?? 0;
  const board = {
    rows,
    moving,
    attempt,
    moveTo,
    choose,
    selected,
    saving,
    now: props.now,
    highlight: spotlightId,
    onTheBlock: props.onTheBlock ?? NOBODY,
    openCard
  };
  const spotlightRow = spotlightId === null ? undefined : byId.get(spotlightId);
  const spotlightStatus = spotlightRow === undefined ? null : statusLabel(spotlightRow);

  // Nobody starts (right after the draft, say): offer the optimizer's lineup as one tap.
  const emptyLineup = !data.players.some((p) => isStarter(p.slot)) && pending.length === 0;

  return (
    <div className="space-y-4">
      {emptyLineup && optimalPlacement !== null && !alreadyOptimal && (
        <section
          aria-label="Your lineup is empty"
          data-testid="empty-lineup"
          className="motion-pop flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-500 bg-warning-50 p-3 sm:p-4"
        >
          <div className="min-w-0">
            <h3 className="font-semibold">Your lineup is empty</h3>
            <p className="text-sm">
              Every player is on the bench, so this week would score 0.{' '}
              {optimal?.basis === 'rank'
                ? 'Start your best players by consensus rank (no projections yet), then adjust.'
                : 'Start your highest-projected players, then adjust.'}
            </p>
          </div>
          <Button
            variant="primary"
            onClick={() => save(optimalPlacement)}
            loading={saving}
            loadingLabel="Saving…"
            className="min-h-11 max-sm:w-full"
          >
            Set my lineup
          </Button>
        </section>
      )}
      <LineupSummary
        data={data}
        total={total}
        savedTotal={savedTotal}
        dirty={pending.length > 0}
        canOptimize={optimal !== null && !alreadyOptimal && !saving}
        optimalGain={optimal === null ? 0 : optimal.projectedPoints - total}
        onOptimize={optimize}
      />
      {spotlightRow !== undefined && spotlightStatus !== null && (
        <section
          role="alert"
          data-testid="player-alert"
          className={`motion-pop rounded-lg border p-3 text-sm ${
            willPlay(spotlightRow) ? 'border-warning-500 bg-warning-50' : 'border-error-600 bg-error-50'
          }`}
        >
          <p>
            <strong>{spotlightRow.player.name}</strong> is <strong>{spotlightStatus}</strong>
            {isStarter(spotlightRow.slot)
              ? spotlightRow.locked
                ? '. His game has started, so he stays in your lineup.'
                : willPlay(spotlightRow)
                  ? ' and in your lineup. Keep him, or tap a highlighted player to start instead.'
                  : '. Tap a highlighted player to start in his place, then save.'
              : ' and on your bench.'}
          </p>
        </section>
      )}
      <ApiErrorAlert error={problem} />
      <p className="text-sm text-muted-foreground">
        <span className="max-sm:hidden">
          Drag a player onto a slot, or select him and then choose where he goes. Click a name for his stats.
        </span>
        <span className="sm:hidden">Tap a player, then tap where he goes. Tap a name for his stats.</span>
      </p>
      <p role="status" aria-live="polite" className="sr-only" data-testid="lineup-announcer">
        {announcement}
      </p>
      {selected !== null && mover !== undefined && (
        <div
          data-testid="moving-banner"
          className="motion-pop sticky top-2 z-20 flex items-center justify-between gap-3 rounded-lg border border-primary-300 bg-primary-50 px-3 py-2 text-sm shadow-md"
        >
          <span className="flex min-w-0 items-center gap-2">
            <PlayerHeadshot player={mover.player} size={32} className="sm:hidden" />
            <span>
              Moving <strong>{mover.player.name}</strong>: choose a highlighted spot.
            </span>
          </span>
          <span className="flex shrink-0 gap-1">
            {/* While a player moves, a tap on any row is a move, so his card opens from here. */}
            {openCard !== null && (
              <Button variant="ghost" size="sm" onClick={() => openCard(mover.player)} className="min-h-11">
                Stats
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)} className="min-h-11">
              Cancel
            </Button>
          </span>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'Press Enter or Space to select this player, then move to a highlighted slot or player and press Enter to move him there. Press Escape to cancel.'
          }
        }}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
          <section aria-labelledby="lineup-starters" className="rounded-lg border border-border">
            <h3 id="lineup-starters" className="border-b border-border px-3 py-2 font-semibold">
              Starters
            </h3>
            <ul aria-label="Starters" className="divide-y divide-border">
              {seats(data.players, data.slots, placement).map((seat, index) => (
                <Spot
                  key={seat.key}
                  id={seat.key}
                  slot={seat.slot}
                  entry={seat.entry}
                  target={{ kind: 'slot', slot: seat.slot, occupant: seat.entry?.player.id ?? null }}
                  index={index}
                  board={board}
                />
              ))}
            </ul>
          </section>

          <div className="space-y-4">
            <section aria-labelledby="lineup-bench" className="rounded-lg border border-border">
              <DropHeader
                id="bench"
                title="Bench"
                headingId="lineup-bench"
                target={{ kind: 'bench' }}
                board={board}
              />
              <ul aria-label="Bench" className="divide-y divide-border">
                {bench.map((entry, index) => (
                  <Spot
                    key={entry.player.id}
                    id={`player-${entry.player.id}`}
                    slot="BN"
                    entry={entry}
                    target={{ kind: 'player', playerId: entry.player.id }}
                    index={index}
                    board={board}
                  />
                ))}
                {bench.length === 0 && (
                  <li className="px-3 py-3 text-sm text-muted-foreground">Nobody on the bench.</li>
                )}
              </ul>
            </section>
            {irRoom > 0 && (
              <section aria-labelledby="lineup-ir" className="rounded-lg border border-border">
                <DropHeader
                  id="ir"
                  title={`IR (${ir.length}/${irRoom})`}
                  headingId="lineup-ir"
                  target={{ kind: 'ir' }}
                  board={board}
                />
                <ul aria-label="IR" className="divide-y divide-border">
                  {ir.map((entry, index) => (
                    <Spot
                      key={entry.player.id}
                      id={`ir-${entry.player.id}`}
                      slot="IR"
                      entry={entry}
                      target={null}
                      index={index}
                      board={board}
                    />
                  ))}
                  {ir.length === 0 && (
                    <li className="px-3 py-3 text-sm text-muted-foreground">
                      Out or IR players can rest here without using a bench spot.
                    </li>
                  )}
                </ul>
              </section>
            )}
          </div>
        </div>
        <DragOverlay dropAnimation={reduced ? null : undefined}>
          {dragging !== null && byId.has(dragging) ? (
            <DragCard entry={byId.get(dragging) as RosterEntry} />
          ) : null}
        </DragOverlay>
      </DndContext>

      {pending.length > 0 && (
        <PendingChanges
          pending={pending}
          total={total}
          savedTotal={savedTotal}
          saving={saving}
          onSave={() => save()}
          onDiscard={discard}
        />
      )}
    </div>
  );
}

interface Board {
  rows: RosterEntry[];
  moving: string | null;
  attempt: (target: Target) => Placement | null;
  moveTo: (target: Target) => void;
  choose: (entry: RosterEntry) => void;
  selected: string | null;
  saving: boolean;
  now: number;
  /** The player a notification pointed at (#200). */
  highlight: string | null;
  onTheBlock: ReadonlySet<string>;
  openCard: ((player: RosterEntry['player']) => void) | null;
}

const NOBODY: ReadonlySet<string> = new Set();

/** The players a PLAYER_LOCKED refusal names (`details.lockedPlayerIds`), by name. */
export function lockedNames(details: unknown, players: readonly RosterEntry[]): string[] {
  const ids = (details as { lockedPlayerIds?: unknown } | null)?.lockedPlayerIds;
  if (!Array.isArray(ids)) return [];
  return ids.flatMap((id) => {
    const name = players.find((p) => p.player.id === id)?.player.name;
    return name === undefined ? [] : [name];
  });
}

/** "Locked · Q2 8:42", "Locked · Final", or "Locks in 12m" in the hour before his kickoff. */
function LockStatus({ entry, now }: { entry: RosterEntry; now: number }) {
  if (entry.locked) {
    // The server's game state when it sent one; a lock by the clock alone just says Locked.
    const game = entry.game;
    const when =
      game === undefined
        ? null
        : game.state === 'final'
          ? 'Final'
          : game.state === 'live'
            ? (periodLabel(game.period, game.clock) ?? 'Live')
            : null;
    return (
      <StatusBadge tone="neutral" data-testid="lock-status">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="mr-1 inline h-3 w-3 align-[-2px]">
          <path
            fill="currentColor"
            d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"
          />
        </svg>
        Locked{when === null ? '' : ` · ${when}`}
      </StatusBadge>
    );
  }
  const soon = locksIn(entry, now);
  if (soon === null) return null;
  return (
    <StatusBadge tone="warning" data-testid="lock-status">
      {soon}
    </StatusBadge>
  );
}

/** The week's projection, how the unsaved changes move it, and the Optimize button. */
function LineupSummary(props: {
  data: Roster;
  total: number;
  savedTotal: number;
  dirty: boolean;
  canOptimize: boolean;
  optimalGain: number;
  onOptimize: () => void;
}) {
  const { data } = props;
  const delta = Math.round((props.total - props.savedTotal) * 100) / 100;
  const byRank = data.optimal?.basis === 'rank';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3 sm:p-4">
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">
          {/* My Team already says whose lineup this is (#212). */}
          Week {data.week}
          {data.carriedFromWeek !== null ? ` · carried over from week ${data.carriedFromWeek}` : ''}
        </p>
        <p className="flex flex-wrap items-baseline gap-x-2" data-testid="lineup-projection">
          <span className="text-sm text-muted-foreground">Projected</span>
          <AnimatedNumber value={props.total} decimals={2} className="text-2xl font-semibold" />
          {props.dirty && delta !== 0 && (
            <span
              data-testid="lineup-projection-delta"
              className={`text-sm font-semibold ${delta > 0 ? 'text-success-700' : 'text-error-700'}`}
            >
              {signed(delta, 2)} vs saved
            </span>
          )}
          {props.dirty ? (
            <StatusBadge tone="warning">Unsaved changes</StatusBadge>
          ) : data.lineupSaved ? (
            <StatusBadge tone="success">Saved</StatusBadge>
          ) : null}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 max-sm:w-full max-sm:items-stretch">
        <Button
          variant="secondary"
          onClick={props.onOptimize}
          disabled={!props.canOptimize}
          className="min-h-11"
        >
          {!props.canOptimize
            ? 'Optimize lineup'
            : byRank
              ? 'Optimize lineup (by rank)'
              : props.optimalGain > 0.004
                ? `Optimize lineup (${signed(props.optimalGain, 2)})`
                : 'Optimize lineup'}
        </Button>
        <span className="text-xs text-muted-foreground max-sm:text-center" data-testid="optimize-note">
          {data.optimal == null
            ? 'No lineup suggestion is available.'
            : byRank
              ? `No projections for week ${data.week} yet: ranked by consensus rank instead.`
              : props.canOptimize
                ? 'Best projected lineup; locked, Out, and IR players stay put.'
                : 'Your lineup is the best projected one.'}
        </span>
      </div>
    </div>
  );
}

/** A section heading that is also a drop target: the bench or IR. */
function DropHeader(props: { id: string; title: string; headingId: string; target: Target; board: Board }) {
  const { board, target } = props;
  const valid = board.moving !== null && board.attempt(target) !== null;
  const { setNodeRef, isOver } = useDroppable({
    id: props.id,
    disabled: !valid,
    data: { target, label: props.id === 'ir' ? 'IR' : 'the bench' }
  });
  return (
    <div
      ref={setNodeRef}
      data-testid={`drop-${props.id}`}
      className={`flex min-h-11 items-center justify-between gap-2 border-b border-border px-3 py-2 transition-colors ${
        valid ? (isOver ? 'bg-primary-100' : 'bg-primary-50') : ''
      }`}
    >
      <h3 id={props.headingId} className="font-semibold">
        {props.title}
      </h3>
      {valid && board.selected !== null && (
        <Button size="sm" variant="secondary" onClick={() => board.moveTo(target)} className="min-h-11">
          Move to {props.id === 'ir' ? 'IR' : 'bench'}
        </Button>
      )}
      {valid && board.selected === null && (
        <span className="text-xs font-medium text-primary-700">Drop here</span>
      )}
    </div>
  );
}

/**
 * One row: a starting slot (maybe empty) or a bench or IR player. It is a drop target while a
 * player is moving, and its player can be picked up or selected unless he is locked.
 */
function Spot(props: {
  id: string;
  slot: string;
  entry: RosterEntry | null;
  target: Target | null;
  index: number;
  board: Board;
}) {
  const { entry, target, board } = props;
  const isMover = entry !== null && entry.player.id === board.moving;
  const valid = target !== null && board.moving !== null && !isMover && board.attempt(target) !== null;
  const label = target === null ? props.slot : targetLabel(target, board.rows);
  const { setNodeRef, isOver } = useDroppable({ id: props.id, disabled: !valid, data: { target, label } });
  const enter = stagger(props.index);
  // While a player moves: targets he can go to light up, everywhere else dims.
  const tone =
    board.moving === null || isMover
      ? ''
      : valid
        ? isOver
          ? 'bg-primary-100 ring-2 ring-inset ring-primary-500'
          : 'bg-primary-50 ring-1 ring-inset ring-primary-300'
        : 'opacity-40';
  const out = entry !== null && isStarter(props.slot) && !willPlay(entry);
  const highlighted = entry !== null && entry.player.id === board.highlight;
  return (
    <li
      ref={setNodeRef}
      data-testid={entry === null ? `lineup-empty-${props.id}` : `roster-row-${entry.player.id}`}
      data-target={board.moving === null || isMover ? undefined : valid ? 'valid' : 'invalid'}
      data-highlighted={highlighted ? 'true' : undefined}
      className={`motion-row ${enter.className} relative flex items-stretch gap-2 px-2 transition-[background-color,opacity] sm:gap-3 sm:px-3 ${tone} ${
        out ? `border-l-4 ${highlighted ? 'border-l-error-600' : 'border-l-warning-500'}` : ''
      } ${highlighted ? 'scroll-mt-24 ring-2 ring-inset ring-error-500' : ''}`}
      style={enter.style}
    >
      <span
        aria-hidden={entry !== null}
        className="flex w-11 shrink-0 items-center justify-center font-mono text-xs font-semibold text-muted-foreground"
      >
        {props.slot}
      </span>
      {entry === null ? (
        <EmptySeat slot={props.slot} valid={valid} onMove={() => target !== null && board.moveTo(target)} />
      ) : (
        <PlayerCard entry={entry} slot={props.slot} target={target} valid={valid} board={board} />
      )}
    </li>
  );
}

function EmptySeat(props: { slot: string; valid: boolean; onMove: () => void }) {
  return (
    <button
      type="button"
      disabled={!props.valid}
      onClick={props.onMove}
      aria-label={props.valid ? `Move here: empty ${props.slot} slot` : `Empty ${props.slot} slot`}
      className="my-1.5 flex min-h-11 flex-1 items-center rounded-md border border-dashed border-border px-3 text-sm italic text-muted-foreground disabled:cursor-default"
    >
      {props.valid ? (
        'Empty — move here'
      ) : (
        <span>
          Empty — <span className="max-sm:hidden">drag or choose a player</span>
          <span className="sm:hidden">tap a player to fill it</span>
        </span>
      )}
    </button>
  );
}

/**
 * A player's row. The row picks him up (drag) or selects him (click, tap, Enter); his name is its
 * own button that opens his card, so checking a player's stats never moves him. While another
 * player is moving the whole row, name included, is a place to put him.
 */
function PlayerCard(props: {
  entry: RosterEntry;
  slot: string;
  target: Target | null;
  valid: boolean;
  board: Board;
}) {
  const { entry, board } = props;
  const id = entry.player.id;
  const selectedHere = board.selected === id;
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id,
    disabled: entry.locked || board.saving,
    attributes: { roleDescription: 'movable player' }
  });
  const moverName = String(board.rows.find((p) => p.player.id === board.moving)?.player.name);
  const actsAsTarget = board.moving !== null && !selectedHere && board.moving !== id;
  const onClick = () => {
    if (actsAsTarget) {
      if (props.valid && props.target !== null) board.moveTo(props.target);
      return;
    }
    if (!entry.locked && !board.saving) board.choose(entry);
  };
  const ariaLabel = actsAsTarget
    ? props.valid && props.target !== null
      ? `Move ${moverName} to ${targetLabel(props.target, board.rows)}`
      : `${entry.player.name}: ${moverName} cannot go here`
    : `${selectedHere ? 'Selected: ' : ''}${entry.player.name}, ${props.slot}${entry.locked ? ', locked' : ''}`;
  const status = statusLabel(entry);
  const openCard = actsAsTarget ? null : board.openCard;
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className={`relative -mx-1 flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-2 sm:-mx-2 sm:px-2 ${
        entry.locked ? 'cursor-not-allowed' : actsAsTarget ? 'cursor-pointer' : 'cursor-grab'
      } ${selectedHere ? 'bg-primary-100 ring-2 ring-primary-500' : ''} ${isDragging ? 'opacity-30' : ''}`}
    >
      {/* The row's button covers it; the name sits above it as a button of its own. */}
      <button
        type="button"
        {...attributes}
        onClick={onClick}
        aria-label={ariaLabel}
        aria-pressed={selectedHere}
        aria-disabled={entry.locked || (actsAsTarget && !props.valid) || board.saving}
        className={`absolute inset-0 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 ${
          entry.locked ? 'cursor-not-allowed' : actsAsTarget ? 'cursor-pointer' : 'cursor-grab'
        }`}
      />
      {/* Rows are full on a phone: the headshot shows from `sm` up, and in the moving banner. */}
      <PlayerHeadshot player={entry.player} size={36} className="pointer-events-none max-sm:hidden" />
      <span className="pointer-events-none min-w-0 flex-1">
        <span className="block truncate font-medium">
          {openCard === null ? (
            entry.player.name
          ) : (
            <button
              type="button"
              title={`${entry.player.name}: stats and projections`}
              data-player-link=""
              onClick={() => openCard(entry.player)}
              className="pointer-events-auto relative z-10 -my-1 cursor-pointer rounded py-1 text-left decoration-primary-500 decoration-2 underline-offset-4 hover:text-primary-700 hover:underline focus-visible:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
            >
              {entry.player.name}
            </button>
          )}{' '}
          <span className="text-xs font-normal text-muted-foreground">
            {entry.player.position} · {entry.player.team ?? 'FA'}
          </span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {/* On a bye the badge says so. */}
          {!entry.onBye && <span data-testid="game-line">{gameLine(entry)}</span>}
          {entry.byeWeek !== null && !entry.onBye && <span>· bye {entry.byeWeek}</span>}
          <LockStatus entry={entry} now={board.now} />
          {status !== null && (
            <StatusBadge
              tone={entry.onBye || ['questionable', 'doubtful'].includes(entry.status) ? 'warning' : 'error'}
            >
              {status}
            </StatusBadge>
          )}
          {board.onTheBlock.has(id) && (
            <span
              data-testid="in-trade"
              className="inline-flex items-center gap-1 rounded-full bg-primary-100 px-2 py-0.5 font-medium text-primary-800"
            >
              <span aria-hidden="true">⇄</span> In a pending trade
            </span>
          )}
        </span>
      </span>
      <span className="pointer-events-none">
        <ProjectionCell entry={entry} />
      </span>
    </div>
  );
}

function ProjectionCell({ entry }: { entry: RosterEntry }): ReactNode {
  const recent = entry.recentPoints ?? null;
  return (
    <span className="flex shrink-0 flex-col items-end pr-1 text-right tabular-nums">
      <span className="text-base font-semibold" data-testid="player-projection">
        <span className="sr-only">Projected </span>
        {entry.projectedPoints === null ? '–' : pts(entry.projectedPoints)}
      </span>
      <span className="text-[0.7rem] text-muted-foreground">
        {entry.points !== null ? (
          <>
            <span className="sr-only">Scored </span>
            {pts(entry.points)} pts
          </>
        ) : recent !== null ? (
          <span title={`Average over his last ${recent.games} game${recent.games === 1 ? '' : 's'}`}>
            <span aria-hidden="true">L3 </span>
            <span className="sr-only">Last 3 weeks average </span>
            {pts(recent.average)}
          </span>
        ) : (
          'proj'
        )}
      </span>
    </span>
  );
}

/** The card that follows the pointer while dragging. */
function DragCard({ entry }: { entry: RosterEntry }) {
  return (
    <div className="flex min-w-48 items-center justify-between gap-3 rounded-lg border border-primary-500 bg-surface px-3 py-2 shadow-lg">
      <span className="font-medium">
        {entry.player.name} <span className="text-xs text-muted-foreground">{entry.player.position}</span>
      </span>
      <span className="font-semibold tabular-nums">
        {entry.projectedPoints === null ? '–' : pts(entry.projectedPoints)}
      </span>
    </div>
  );
}

/** Unsaved moves, each with what it does to the projection, and Save / Discard. Sticks to the bottom. */
function PendingChanges(props: {
  pending: Change[];
  total: number;
  savedTotal: number;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const delta = Math.round((props.total - props.savedTotal) * 100) / 100;
  return (
    <section
      aria-label="Unsaved changes"
      data-testid="pending-changes"
      className="motion-slide-in sticky bottom-2 z-10 rounded-lg border border-primary-300 bg-surface p-3 shadow-lg sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {props.pending.length} unsaved {props.pending.length === 1 ? 'change' : 'changes'}
        </h3>
        <p className="text-sm tabular-nums">
          Projected {total2(props.savedTotal)} → <strong>{total2(props.total)}</strong>{' '}
          <span
            className={
              delta > 0 ? 'text-success-700' : delta < 0 ? 'text-error-700' : 'text-muted-foreground'
            }
          >
            ({signed(delta, 2)})
          </span>
        </p>
      </div>
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm" aria-label="Changes">
        {props.pending.map((c) => {
          const gain = contribution(c.entry, c.to) - contribution(c.entry, c.from);
          return (
            <li key={c.entry.player.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                <PlayerLink player={c.entry.player} />{' '}
                <span className="font-mono text-xs text-muted-foreground">
                  {c.from} → {c.to}
                </span>
              </span>
              {gain !== 0 && (
                <span className={`tabular-nums ${gain > 0 ? 'text-success-700' : 'text-error-700'}`}>
                  {signed(gain)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={props.onDiscard} disabled={props.saving} className="min-h-11">
          Discard
        </Button>
        <Button
          variant="primary"
          onClick={props.onSave}
          loading={props.saving}
          loadingLabel="Saving…"
          className="min-h-11"
        >
          Save lineup
        </Button>
      </div>
    </section>
  );
}
