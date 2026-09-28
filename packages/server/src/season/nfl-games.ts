import type { LiveGame, ScheduledGame } from '@fantasy/data';
import { z } from 'zod';
import type { StoredNflWeek } from '../repos/reference.js';
import { STATS_GAME_DURATION_MS } from './window.js';

/**
 * The week's NFL games as they stand (#132): our schedule, overlaid with the latest read of ESPN's
 * scoreboard (scores, status, possession, red zone). Live scoring refreshes it every two minutes
 * during game windows (`refreshNflGames`), `get_nfl_games` serves it, and `NFL Games Updated`
 * pushes each change to open browsers.
 */

/**
 * Possession, down and distance, and the red zone are only shown while the last read is this
 * recent. Older than that (the feed failed, or the job stopped) they are dropped, so a stale
 * red-zone highlight never lingers. Scores and status stay.
 */
export const NFL_GAMES_FRESH_MS = 10 * 60_000;
/** After the last game's window closes, keep reading until every started game is final, this long. */
export const FINALS_GRACE_MS = 3 * 3_600_000;

const team = z.string().nullable();

export const NflGameSchema = z.object({
  gameId: z.string().nullable().describe('The schedule’s game id, or null for a game only ESPN listed.'),
  homeTeam: team,
  awayTeam: team,
  homeScore: z.number().nullable().describe('Null before kickoff.'),
  awayScore: z.number().nullable(),
  kickoff: z.string().nullable().describe('UTC, ISO 8601.'),
  state: z.enum(['pre', 'in', 'post']).describe('Before kickoff, in progress, or final.'),
  status: z.string().nullable().describe('Short status: `8:32 - 2nd`, `Final`, or the kickoff time.'),
  period: z.number().int().nullable().describe('The quarter (5 and up is overtime).'),
  clock: z.string().nullable().describe('The game clock while in progress.'),
  possessionTeam: team.describe('The team with the ball (live games only).'),
  isRedZone: z.boolean().describe('The team with the ball is inside the opponent’s 20.'),
  downDistance: z.string().nullable().describe('For example `2nd & 4 at DAL 7`.'),
  fieldPosition: z.string().nullable().describe('The spot of the ball, for example `DAL 7`.'),
  yardsToGoal: z.number().nullable().describe('Yards from the ball to the goal line the offense attacks.')
});
export type NflGame = z.infer<typeof NflGameSchema>;

/** A team with the ball in the red zone, for the matchup's player highlights. */
export const RedZoneTeamSchema = z.object({
  team: z.string(),
  downDistance: z.string().nullable(),
  fieldPosition: z.string().nullable()
});
export type RedZoneTeam = z.infer<typeof RedZoneTeamSchema>;

export interface NflWeekView {
  season: number;
  week: number;
  games: NflGame[];
  redZone: RedZoneTeam[];
  /** When the games were last read from ESPN, or null when only the schedule is known. */
  updatedAt: string | null;
}

const LIVE_ONLY = {
  possessionTeam: null,
  isRedZone: false,
  downDistance: null,
  fieldPosition: null,
  yardsToGoal: null
} as const;

function fromLive(game: LiveGame, fresh: boolean): NflGame {
  const view: NflGame = {
    gameId: game.gameKey,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
    kickoff: game.kickoff,
    state: game.state,
    status: game.status,
    period: game.period,
    clock: game.clock,
    possessionTeam: game.possessionTeam,
    isRedZone: game.isRedZone,
    downDistance: game.downDistance,
    fieldPosition: game.fieldPosition,
    yardsToGoal: game.yardsToGoal
  };
  return fresh ? view : { ...view, ...LIVE_ONLY, clock: null };
}

function fromSchedule(game: ScheduledGame): NflGame {
  const final = game.status === 'final';
  return {
    gameId: game.gameId,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeScore: final ? (game.homeScore ?? null) : null,
    awayScore: final ? (game.awayScore ?? null) : null,
    kickoff: game.kickoff,
    state: final ? 'post' : 'pre',
    status: final ? 'Final' : null,
    period: null,
    clock: null,
    ...LIVE_ONLY
  };
}

/** The red-zone teams among `games`. */
export function redZoneTeams(games: readonly NflGame[]): RedZoneTeam[] {
  return games.flatMap((g) =>
    g.isRedZone && g.possessionTeam !== null
      ? [{ team: g.possessionTeam, downDistance: g.downDistance, fieldPosition: g.fieldPosition }]
      : []
  );
}

/**
 * The week's games for display: each scheduled game with its latest live read (or as the schedule
 * has it), then any game only ESPN listed. Live-only fields are dropped from a stale read.
 */
export function nflWeekView(
  season: number,
  week: number,
  schedule: readonly ScheduledGame[],
  stored: StoredNflWeek | null,
  now: Date
): NflWeekView {
  const fresh = stored !== null && now.getTime() - Date.parse(stored.updatedAt) <= NFL_GAMES_FRESH_MS;
  const live = new Map((stored?.games ?? []).flatMap((g) => (g.gameKey === null ? [] : [[g.gameKey, g]])));
  const games = [
    ...schedule.map((g) => {
      const read = live.get(g.gameId);
      return read === undefined ? fromSchedule(g) : { ...fromLive(read, fresh), kickoff: g.kickoff };
    }),
    ...(stored?.games ?? []).filter((g) => g.gameKey === null).map((g) => fromLive(g, fresh))
  ];
  return { season, week, games, redZone: redZoneTeams(games), updatedAt: stored?.updatedAt ?? null };
}

/** What a browser shows: anything but the clock and the read time. */
const shown = (g: LiveGame) =>
  JSON.stringify([
    g.gameKey ?? g.espnId,
    g.homeScore,
    g.awayScore,
    g.state,
    g.period,
    g.possessionTeam,
    g.isRedZone,
    g.downDistance
  ]);

/** Whether a new read changes a score, status, possession, or situation of any game. */
export function gamesChanged(before: readonly LiveGame[], after: readonly LiveGame[]): boolean {
  if (before.length !== after.length) return true;
  const previous = new Set(before.map(shown));
  return after.some((g) => !previous.has(shown(g)));
}

/**
 * Outside the game windows, whether the week still needs a read to capture finals: the last read
 * has a game that kicked off but was not final, and the last started game's window closed less
 * than `FINALS_GRACE_MS` ago. Never before a first read, so the week is not polled between windows.
 */
export function awaitingFinals(
  stored: StoredNflWeek | null,
  schedule: readonly ScheduledGame[],
  now: Date
): boolean {
  if (stored === null) return false;
  const t = now.getTime();
  const started = schedule.filter((g) => Date.parse(g.kickoff) <= t);
  const lastKickoff = Math.max(...started.map((g) => Date.parse(g.kickoff)));
  if (!(t < lastKickoff + STATS_GAME_DURATION_MS + FINALS_GRACE_MS)) return false;
  const kicked = new Set(started.map((g) => g.gameId));
  return stored.games.some((g) => g.state !== 'post' && g.gameKey !== null && kicked.has(g.gameKey));
}
