import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '@readysetcloud/ui';
import type { MatchupData, MatchupLineup, MatchupSide, RedZoneTeam, RosterEntry } from '../../api/types';
import { ManagerTag } from '../../components/AgentAvatar';
import { AnimatedNumber, DeltaFloater } from '../../motion/AnimatedNumber';
import { usePrefersReducedMotion } from '../../motion/reducedMotion';
import { BallMark } from './NflGamesStrip';
import { RED_ZONE_POSITIONS, RedZoneChip } from './RedZone';
import { isStarter } from './slots';
import {
  KICKOFF,
  countsLabel,
  gameContext,
  gameOf,
  periodLabel,
  scoreLine,
  sitsOut,
  stateCounts,
  versus
} from './gameState';
import './matchup.css';

/**
 * The live matchup (#193): a sticky score bar with both teams' totals, live projections, and who is
 * playing, over a slot-by-slot head-to-head (your QB against theirs) with each player's game, box
 * score, points, and projection. Points lead; the game is second; the projection is third.
 */

const pts = (n: number) => n.toFixed(2);
const proj = (n: number) => n.toFixed(1);
const STATUS_LABEL = { scheduled: 'Upcoming', in_progress: 'Live', final: 'Final' } as const;

type Matchup = NonNullable<MatchupData['matchup']>;
type Side = 'home' | 'away';

/** Screen readers hear score changes at most this often. */
export const ANNOUNCE_EVERY_MS = 30_000;

/**
 * `message`, released to a polite live region at most once per `everyMs`: a burst of score changes
 * becomes one announcement of the latest score, never a stream. Nothing is announced on first load.
 */
export function useThrottledAnnouncement(message: string, everyMs = ANNOUNCE_EVERY_MS): string {
  const [spoken, setSpoken] = useState('');
  const first = useRef(message);
  const last = useRef(0);
  useEffect(() => {
    if (message === first.current) return undefined;
    first.current = '';
    const wait = Math.max(0, last.current + everyMs - Date.now());
    const timer = setTimeout(() => {
      last.current = Date.now();
      setSpoken(message);
    }, wait);
    return () => clearTimeout(timer);
  }, [message, everyMs]);
  return spoken;
}

/** One pip per starter, by game state. The label beside it says the same in words. */
function Pips({ players, align }: { players: readonly RosterEntry[]; align: 'start' | 'end' }) {
  const starters = players.filter((p) => isStarter(p.slot));
  const counts = stateCounts(starters);
  // Playing first, then to play, done, and out.
  const order = { live: 0, upcoming: 1, final: 2, bye: 3, out: 3 } as const;
  const pips = starters
    .map((p) => (sitsOut(p) ? ('out' as const) : gameOf(p).state))
    .sort((a, b) => order[a] - order[b]);
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${align === 'end' ? 'items-end' : 'items-start'}`}>
      <span aria-hidden="true" className="flex flex-wrap gap-[3px]" data-testid="status-pips">
        {pips.map((state, i) => (
          <span key={i} data-state={state} className={`h2h-pip h2h-pip-${state}`} />
        ))}
      </span>
      <span className="text-[0.7rem] leading-tight text-muted-foreground" data-testid="status-counts">
        {countsLabel(counts)}
      </span>
    </div>
  );
}

function TeamScore({
  side,
  lineup,
  align,
  leading,
  trailing
}: {
  side: MatchupSide;
  lineup: MatchupLineup;
  align: 'start' | 'end';
  leading: boolean;
  trailing: boolean;
}) {
  const end = align === 'end';
  return (
    <section
      aria-label={side.teamName}
      data-leading={leading || undefined}
      className={`flex min-w-0 flex-col gap-0.5 ${end ? 'items-end text-right' : 'items-start'}`}
    >
      <h3 className="w-full truncate text-sm font-semibold sm:text-base">{side.teamName}</h3>
      <ManagerTag manager={side.manager} teamId={side.teamId} className="max-sm:hidden" />
      <AnimatedNumber
        className={`!min-w-0 text-2xl font-semibold sm:text-3xl ${trailing ? 'text-muted-foreground' : 'text-foreground'}`}
        data-testid={`score-${side.teamId}`}
        value={side.score ?? 0}
      />
      {lineup.projectedPoints !== undefined && (
        <span className="text-xs text-muted-foreground" data-testid={`projected-${side.teamId}`}>
          Proj {proj(lineup.projectedPoints)}
        </span>
      )}
      <Pips players={lineup.players} align={align} />
    </section>
  );
}

/** The score bar: sticks to the top while the head-to-head scrolls under it. */
export function ScoreBar({
  week,
  matchup,
  lineups,
  leader
}: {
  week: number;
  matchup: Matchup;
  lineups: { home: MatchupLineup; away: MatchupLineup };
  leader: string | null;
}) {
  const { home, away } = matchup;
  const said = useThrottledAnnouncement(
    `${home.teamName} ${pts(home.score ?? 0)}, ${away.teamName} ${pts(away.score ?? 0)}.`
  );
  const live = matchup.status === 'in_progress';
  return (
    <div className="sticky top-0 z-20 -mx-4 bg-background/95 px-4 pb-2 pt-2 backdrop-blur sm:mx-0 sm:px-0">
      <div
        data-testid="score-bar"
        className={`grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2 rounded-lg border border-border bg-surface p-3 shadow-sm sm:gap-4 sm:p-4 ${
          live ? 'h2h-bar-live' : ''
        }`}
      >
        <TeamScore
          side={home}
          lineup={lineups.home}
          align="start"
          leading={leader === home.teamId}
          trailing={leader === away.teamId}
        />
        <div className="flex flex-col items-center gap-1 pt-0.5 text-center">
          <StatusBadge tone={live ? 'success' : 'neutral'}>
            {live && <span className="motion-live-dot mr-1" aria-hidden="true" />}
            {STATUS_LABEL[matchup.status]}
          </StatusBadge>
          <span className="text-xs text-muted-foreground">Week {week}</span>
        </div>
        <TeamScore
          side={away}
          lineup={lineups.away}
          align="end"
          leading={leader === away.teamId}
          trailing={leader === home.teamId}
        />
      </div>
      <p role="status" aria-live="polite" className="sr-only" data-testid="score-announcer">
        {said}
      </p>
    </div>
  );
}

/** "C. McCaffrey" for the phone column; a team defense keeps its name. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const [first = '', ...rest] = parts;
  return `${first[0]}. ${rest.join(' ')}`;
}

function LockMark() {
  return (
    <svg
      role="img"
      aria-label="Locked: game started"
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0 text-muted-foreground"
      data-testid="lock-mark"
    >
      <title>Locked: game started</title>
      <path
        fill="currentColor"
        d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"
      />
    </svg>
  );
}

/**
 * His team is driving inside the opponent's 20 (the server's game state) and he scores from it: a
 * defense does not. The drive's down and distance come from the week's games when they are loaded.
 */
export function redZoneOf(entry: RosterEntry, drives: readonly RedZoneTeam[]): RedZoneTeam | null {
  const team = entry.player.team;
  if (team === null || !gameOf(entry).redZone || !RED_ZONE_POSITIONS.includes(entry.player.position)) {
    return null;
  }
  return drives.find((d) => d.team === team) ?? { team, downDistance: null, fieldPosition: null };
}

/** The game line: when, against whom, the score, the ball and the red zone, or why he scores nothing. */
function ContextLine({ entry, zone }: { entry: RosterEntry; zone: RedZoneTeam | null }) {
  const game = gameOf(entry);
  if (game.state === 'bye') {
    return (
      <StatusBadge tone="warning" data-testid="sits-out">
        BYE<span className="sr-only">: scores nothing this week</span>
      </StatusBadge>
    );
  }
  if (sitsOut(entry)) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <StatusBadge tone="warning" data-testid="sits-out">
          {(entry.injuryStatus ?? entry.status).toUpperCase()}
          <span className="sr-only">: scores nothing this week</span>
        </StatusBadge>
        <span className="text-muted-foreground">{gameContext(entry)}</span>
      </span>
    );
  }
  if (game.state === 'final') {
    const score = scoreLine(game, true);
    return (
      <span className="text-muted-foreground">
        <span className="h2h-final-tag">Final</span>{' '}
        <span className="whitespace-nowrap">{score ?? versus(game)}</span>
      </span>
    );
  }
  if (game.state === 'live') {
    const score = scoreLine(game, false);
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1">
        <span className="font-semibold text-success-700">
          {periodLabel(game.period, game.clock) ?? 'Live'}
        </span>
        <span aria-hidden="true">·</span>
        <span className="whitespace-nowrap">
          {versus(game)}
          {score === null ? '' : ` ${score}`}
        </span>
        {game.possession && zone === null && <BallMark />}
        {zone !== null && <RedZoneChip className="" compact zone={zone} />}
      </span>
    );
  }
  // Upcoming: the kickoff, then the opponent; each part stays whole when the cell wraps.
  return (
    <span className="text-muted-foreground">
      {game.kickoff !== null && (
        <span className="whitespace-nowrap">{KICKOFF.format(new Date(game.kickoff))}</span>
      )}{' '}
      <span className="whitespace-nowrap">{versus(game)}</span>
    </span>
  );
}

function PlayerCell({
  entry,
  side,
  showLock,
  zone
}: {
  entry: RosterEntry | null;
  side: Side;
  showLock: boolean;
  zone: RedZoneTeam | null;
}) {
  const reduced = usePrefersReducedMotion();
  const end = side === 'away';
  if (entry === null) {
    return (
      <td className={`h2h-player ${end ? 'text-right' : ''}`}>
        <span className="text-xs italic text-muted-foreground">Empty</span>
      </td>
    );
  }
  const game = gameOf(entry);
  const out = sitsOut(entry);
  const live = game.state === 'live' && !out;
  const edge = end ? 'h2h-edge-end' : 'h2h-edge-start';
  const tone =
    zone !== null ? `h2h-redzone ${edge}${reduced ? '' : ' h2h-pulse'}` : live ? `h2h-live ${edge}` : '';
  return (
    <td
      data-testid={`h2h-player-${entry.player.id}`}
      data-state={out && game.state !== 'bye' ? 'out' : game.state}
      className={`h2h-player ${tone} ${end ? 'text-right' : ''}`}
    >
      <span className={`flex min-w-0 items-center gap-1.5 ${end ? 'flex-row-reverse' : ''}`}>
        {live && <span className="motion-live-dot shrink-0" aria-hidden="true" />}
        <span
          className={`min-w-0 truncate font-medium ${game.state === 'final' ? 'text-muted-foreground' : ''}`}
        >
          <span className="sm:hidden">{shortName(entry.player.name)}</span>
          <span className="max-sm:hidden">{entry.player.name}</span>
        </span>
        {showLock && entry.locked && <LockMark />}
      </span>
      <span className="block truncate text-xs text-muted-foreground">
        {entry.player.position} · {entry.player.team ?? 'FA'}
      </span>
      <span className="mt-0.5 block text-xs" data-testid="game-context">
        <ContextLine entry={entry} zone={zone} />
      </span>
      {entry.statLine && (
        <span
          className="mt-0.5 block text-[0.7rem] leading-snug text-muted-foreground"
          data-testid="stat-line"
        >
          {entry.statLine}
        </span>
      )}
    </td>
  );
}

/** Points first, the projection small under it: live-adjusted while he plays. */
function PointsCell({
  entry,
  side,
  zone
}: {
  entry: RosterEntry | null;
  side: Side;
  zone: RedZoneTeam | null;
}) {
  const align = side === 'away' ? 'text-left' : 'text-right';
  if (entry === null) return <td className={`h2h-points ${align}`} />;
  const game = gameOf(entry);
  const out = sitsOut(entry);
  const projection =
    out || game.state === 'bye'
      ? null
      : game.state === 'live'
        ? (entry.expectedPoints ?? entry.projectedPoints)
        : entry.projectedPoints;
  const tint = zone !== null ? 'h2h-redzone' : '';
  return (
    <td className={`h2h-points relative tabular-nums ${align} ${tint}`}>
      <span className="block text-base font-semibold sm:text-lg" data-testid="player-points">
        {entry.points === null ? (
          <span className="text-muted-foreground">
            <span aria-hidden="true">–</span>
            <span className="sr-only">No points yet</span>
          </span>
        ) : (
          <>
            <span className="sr-only">Points </span>
            {pts(entry.points)}
          </>
        )}
      </span>
      {projection !== null && projection !== undefined && (
        <span className="block text-[0.7rem] text-muted-foreground" data-testid="player-projection">
          <span className="sr-only">{game.state === 'live' ? 'Projected final ' : 'Projected '}</span>
          <span aria-hidden="true" className="max-sm:hidden">
            proj{' '}
          </span>
          {proj(projection)}
        </span>
      )}
      <DeltaFloater value={entry.points} />
    </td>
  );
}

interface Pair {
  key: string;
  slot: string;
  home: RosterEntry | null;
  away: RosterEntry | null;
}

/** Both sides' players in `slots` paired by slot, in order: QB with QB, RB1 with RB1, … */
export function pairBySlot(
  home: readonly RosterEntry[],
  away: readonly RosterEntry[],
  include: (slot: string) => boolean
): Pair[] {
  const order: string[] = [];
  for (const p of [...home, ...away]) if (include(p.slot) && !order.includes(p.slot)) order.push(p.slot);
  return order.flatMap((slot) => {
    const mine = home.filter((p) => p.slot === slot);
    const theirs = away.filter((p) => p.slot === slot);
    return Array.from({ length: Math.max(mine.length, theirs.length) }, (_, i) => ({
      key: `${slot}-${i}`,
      slot,
      home: mine[i] ?? null,
      away: theirs[i] ?? null
    }));
  });
}

function PairRow({
  pair,
  lockSide,
  drives
}: {
  pair: Pair;
  lockSide: Side | null;
  drives: readonly RedZoneTeam[];
}) {
  const homeZone = pair.home === null ? null : redZoneOf(pair.home, drives);
  const awayZone = pair.away === null ? null : redZoneOf(pair.away, drives);
  return (
    <tr data-testid={`h2h-row-${pair.key}`} className="border-t border-border align-top">
      <PlayerCell entry={pair.home} side="home" showLock={lockSide === 'home'} zone={homeZone} />
      <PointsCell entry={pair.home} side="home" zone={homeZone} />
      <th scope="row" className="h2h-slot">
        {pair.slot}
      </th>
      <PointsCell entry={pair.away} side="away" zone={awayZone} />
      <PlayerCell entry={pair.away} side="away" showLock={lockSide === 'away'} zone={awayZone} />
    </tr>
  );
}

const benchTotal = (players: readonly RosterEntry[]) =>
  players.filter((p) => !isStarter(p.slot)).reduce((sum, p) => sum + Math.round((p.points ?? 0) * 100), 0) /
  100;

/**
 * The head-to-head: starters paired slot by slot, then the bench, collapsed under its point totals.
 * `yourSide` is the viewer's own team: its locked players show a lock, and "Edit lineup" shows while
 * any of them can still move.
 */
export function HeadToHead({
  matchup,
  lineups,
  yourSide,
  editLineup,
  redZone
}: {
  matchup: Matchup;
  lineups: { home: MatchupLineup; away: MatchupLineup };
  yourSide: Side | null;
  editLineup: string | null;
  redZone: readonly RedZoneTeam[];
}): ReactNode {
  const [benchOpen, setBenchOpen] = useState(false);
  const home = lineups.home.players;
  const away = lineups.away.players;
  const starters = pairBySlot(home, away, isStarter);
  const bench = pairBySlot(home, away, (slot) => !isStarter(slot));
  const mine = yourSide === null ? [] : lineups[yourSide].players;
  const canEdit = editLineup !== null && mine.some((p) => !p.locked);
  return (
    <section aria-labelledby="h2h-heading" className="rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 px-3 py-2 sm:px-4">
        <h3 id="h2h-heading" className="font-semibold">
          Head to head
        </h3>
        {canEdit && (
          <Link
            to={editLineup}
            className="inline-flex min-h-11 items-center text-sm font-medium text-primary-700 hover:underline"
          >
            Edit lineup
          </Link>
        )}
      </div>
      <table className="h2h w-full table-fixed text-sm">
        <caption className="sr-only">
          Starters slot by slot: {matchup.home.teamName} on the left, {matchup.away.teamName} on the right.
        </caption>
        <colgroup>
          <col />
          <col className="w-[3.25rem] sm:w-20" />
          <col className="w-10 sm:w-16" />
          <col className="w-[3.25rem] sm:w-20" />
          <col />
        </colgroup>
        <thead className="sr-only">
          <tr>
            <th scope="col">{matchup.home.teamName}</th>
            <th scope="col">{matchup.home.teamName} points</th>
            <th scope="col">Slot</th>
            <th scope="col">{matchup.away.teamName} points</th>
            <th scope="col">{matchup.away.teamName}</th>
          </tr>
        </thead>
        <tbody>
          {starters.map((pair) => (
            <PairRow key={pair.key} pair={pair} lockSide={yourSide} drives={redZone} />
          ))}
        </tbody>
        {bench.length > 0 && (
          <tbody>
            <tr className="border-t-2 border-border">
              <td className="h2h-bench-total text-right" colSpan={2}>
                {pts(benchTotal(home))}
                <span className="max-sm:sr-only"> pts</span>
              </td>
              <th scope="row" className="h2h-slot">
                <button
                  type="button"
                  aria-expanded={benchOpen}
                  aria-controls="h2h-bench"
                  onClick={() => setBenchOpen((open) => !open)}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-0.5 rounded-md font-sans text-xs font-semibold text-primary-700 hover:bg-primary-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
                >
                  Bench
                  <span
                    aria-hidden="true"
                    className={`transition-transform ${benchOpen ? 'rotate-180' : ''}`}
                  >
                    ▾
                  </span>
                </button>
              </th>
              <td className="h2h-bench-total text-left" colSpan={2}>
                {pts(benchTotal(away))}
                <span className="max-sm:sr-only"> pts</span>
              </td>
            </tr>
          </tbody>
        )}
        {bench.length > 0 && (
          <tbody id="h2h-bench" data-testid="h2h-bench" hidden={!benchOpen}>
            {bench.map((pair) => (
              <PairRow key={pair.key} pair={pair} lockSide={yourSide} drives={redZone} />
            ))}
          </tbody>
        )}
      </table>
    </section>
  );
}
