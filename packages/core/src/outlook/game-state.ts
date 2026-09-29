import type { Instant } from '../rules/lineup.js';

/**
 * One player's NFL game this week, as every view sees it (#193): the matchup, the outlook, the
 * lineup page, and the agents all derive it here, so they never disagree about who is playing.
 *
 * The inputs are the week's games as they stand (the schedule overlaid with the latest ESPN read):
 * - ESPN's `post` is final at once, and so is a game the schedule already has as final;
 * - ESPN's `in` is live;
 * - a game past its kickoff with no live read yet is live (progress unknown), never upcoming;
 * - a team with no game is on bye.
 */

/** Where a player's game stands. */
export type PlayerGameState = 'upcoming' | 'live' | 'final' | 'bye';

/** The state order: a game only ever moves forward through it. */
export const PLAYER_GAME_STATES: readonly PlayerGameState[] = ['upcoming', 'live', 'final'];

/** One NFL game as read: the schedule's, or overlaid with the latest ESPN read. */
export interface NflGameRead {
  homeTeam: string | null;
  awayTeam: string | null;
  /** Null when unknown (an ESPN-only game without one). */
  kickoff: Instant | null;
  /** ESPN's state; a game the live feed has not read is `pre` (or `post` when the schedule has it final). */
  state: 'pre' | 'in' | 'post';
  homeScore: number | null;
  awayScore: number | null;
  /** The quarter; 5 and up is overtime. */
  period: number | null;
  /** The game clock (`8:42`) while in progress. */
  clock: string | null;
  possessionTeam: string | null;
  isRedZone: boolean;
}

export interface PlayerGame {
  state: PlayerGameState;
  /** The opposing NFL team, or null on a bye. */
  opponent: string | null;
  /** True when his team is at home; null on a bye. */
  home: boolean | null;
  kickoff: string | null;
  period: number | null;
  clock: string | null;
  teamScore: number | null;
  opponentScore: number | null;
  /** His team has the ball (live only). */
  possession: boolean;
  /** His team has the ball inside the opponent's 20 (live only). */
  redZone: boolean;
  /** Share of the game played, 0-1: 0 before kickoff, 1 when final, null when unknown (or a bye). */
  progress: number | null;
}

/** Regulation: four 15-minute quarters. */
const QUARTER_SECONDS = 15 * 60;
const REGULATION_SECONDS = 4 * QUARTER_SECONDS;
/** Overtime is nearly done: whatever happens, very little of his projection is left to score. */
export const OVERTIME_PROGRESS = 0.95;

/** Seconds on a `m:ss` game clock, or null when it cannot be read. */
export function clockSeconds(clock: string | null): number | null {
  if (clock === null) return null;
  const match = /^(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(clock.trim());
  if (match === null) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds <= QUARTER_SECONDS ? seconds : null;
}

/**
 * The share of a live game played, from the quarter and the clock: `Q3 8:42` is (2 × 900 + 378) /
 * 3600 ≈ 0.605. Without a readable clock the quarter's midpoint is used; without a quarter it is
 * unknown (null). Overtime counts as nearly done. Always within 0-1.
 */
export function gameProgress(period: number | null, clock: string | null): number | null {
  if (period === null || !Number.isFinite(period) || period < 1) return null;
  if (period > 4) return OVERTIME_PROGRESS;
  const left = clockSeconds(clock);
  const elapsedInQuarter = left === null ? QUARTER_SECONDS / 2 : QUARTER_SECONDS - left;
  const elapsed = (Math.floor(period) - 1) * QUARTER_SECONDS + elapsedInQuarter;
  return Math.round((elapsed / REGULATION_SECONDS) * 1000) / 1000;
}

function ms(t: Instant): number {
  return typeof t === 'string' ? Date.parse(t) : t.getTime();
}

const BYE: PlayerGame = {
  state: 'bye',
  opponent: null,
  home: null,
  kickoff: null,
  period: null,
  clock: null,
  teamScore: null,
  opponentScore: null,
  possession: false,
  redZone: false,
  progress: null
};

export interface PlayerGameOptions {
  /**
   * A game this long past kickoff counts as final even without a final read, so a week whose
   * finals were never read (the feed failed) does not stay live forever. Leave out to never assume.
   */
  finalAfterMs?: number;
}

/**
 * His game this week: `games` are the week's games (a team with none is on bye) and `now` the
 * caller's clock. For a fixed read the state only moves forward as `now` does.
 */
export function playerGame(
  nflTeam: string | null,
  games: readonly NflGameRead[],
  now: Instant,
  options: PlayerGameOptions = {}
): PlayerGame {
  if (nflTeam === null) return BYE;
  const game = games.find((g) => g.homeTeam === nflTeam || g.awayTeam === nflTeam);
  if (game === undefined) return BYE;
  const home = game.homeTeam === nflTeam;
  const kickoffMs = game.kickoff === null ? null : ms(game.kickoff);
  const t = ms(now);
  const started = kickoffMs !== null && kickoffMs <= t;
  const overdue =
    options.finalAfterMs !== undefined && kickoffMs !== null && t >= kickoffMs + options.finalAfterMs;
  const state: PlayerGameState =
    game.state === 'post' || overdue ? 'final' : game.state === 'in' || started ? 'live' : 'upcoming';
  const live = state === 'live';
  const hasBall = live && game.possessionTeam === nflTeam;
  const readLive = game.state === 'in';
  return {
    state,
    opponent: home ? game.awayTeam : game.homeTeam,
    home,
    kickoff: kickoffMs === null ? null : new Date(kickoffMs).toISOString(),
    period: state === 'upcoming' ? null : game.period,
    clock: live && readLive ? game.clock : null,
    teamScore: state === 'upcoming' ? null : home ? game.homeScore : game.awayScore,
    opponentScore: state === 'upcoming' ? null : home ? game.awayScore : game.homeScore,
    possession: hasBall,
    redZone: hasBall && game.isRedZone,
    progress:
      state === 'final'
        ? 1
        : state === 'upcoming'
          ? 0
          : readLive
            ? gameProgress(game.period, game.clock)
            : null
  };
}

/** True while his game can still add points: upcoming or live. */
export function stillToPlay(game: Pick<PlayerGame, 'state'>): boolean {
  return game.state === 'upcoming' || game.state === 'live';
}
