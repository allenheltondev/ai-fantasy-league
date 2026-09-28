import type { LiveGame, ScheduledGame } from '@fantasy/data';
import type { StoredGamePlays } from '../repos/reference.js';
import { awaitingFinals, gamesChanged, nflWeekView } from '../season/nfl-games.js';
import type { JobDeps } from './deps.js';

type NflGamesDeps = Pick<JobDeps, 'reference' | 'events' | 'log'> & Partial<Pick<JobDeps, 'provider'>>;

export interface NflWeekTarget {
  season: number;
  week: number;
  /** The week's scheduled games. */
  games: readonly ScheduledGame[];
  /** Some game is in its window now. */
  live: boolean;
}

export type NflGamesOutcome = 'unavailable' | 'idle' | 'unchanged' | 'changed' | 'failed';

/**
 * Reads the week's games from ESPN's scoreboard (once per season and week, however many leagues
 * play it), stores them, and emits `NFL Games Updated` when a score, status, possession, or
 * situation changed. It reads while a game window is open, and after the last one closes only
 * until every started game is final (`awaitingFinals`), so the week is not polled between windows.
 * Games whose score moved also get their scoring plays read (`refreshScoringPlays`, #164).
 *
 * Best effort: live scoring must never fail because of it, so every error is logged as a warning
 * and reported as `failed`. A provider without live games (the simulator, local dev) is skipped.
 */
export async function refreshNflGames(
  deps: NflGamesDeps,
  target: NflWeekTarget,
  now: Date
): Promise<NflGamesOutcome> {
  const { season, week, games } = target;
  const provider = deps.provider;
  if (provider?.getLiveGames === undefined) return 'unavailable';
  try {
    const stored = await deps.reference.nflGames.get(season, week);
    if (!target.live && !awaitingFinals(stored, games, now)) return 'idle';
    const read = await provider.getLiveGames(season, week, now, games);
    const next = { season, week, games: read, updatedAt: now.toISOString() };
    await deps.reference.nflGames.put(next);
    await refreshScoringPlays(deps, season, week, stored?.games ?? [], read, now);
    if (stored !== null && !gamesChanged(stored.games, read)) return 'unchanged';
    const view = nflWeekView(season, week, games, next, now);
    await deps.events.publish('NFL Games Updated', {
      season,
      week,
      games: view.games,
      redZone: view.redZone,
      updatedAt: next.updatedAt
    });
    return 'changed';
  } catch (error) {
    deps.log.warn('could not refresh the NFL games; live scoring goes on without them', {
      season,
      week,
      error
    });
    return 'failed';
  }
}

const sameScore = (
  a: Pick<LiveGame, 'homeScore' | 'awayScore'>,
  b: Pick<LiveGame, 'homeScore' | 'awayScore'>
) => a.homeScore === b.homeScore && a.awayScore === b.awayScore;

/**
 * Whether a game's scoring plays should be read now: it has points, and its score changed since
 * the stored scoreboard, or the stored plays do not reach the current score yet (none stored, or
 * the last one's score is behind: ESPN's summary can trail its scoreboard by a poll). So a game
 * costs about one summary read per score, not one per poll.
 */
export function needsScoringPlays(
  game: LiveGame,
  previous: LiveGame | undefined,
  stored: StoredGamePlays | undefined
): boolean {
  if (game.state === 'pre' || (game.homeScore ?? 0) + (game.awayScore ?? 0) === 0) return false;
  if (previous === undefined || !sameScore(previous, game)) return true;
  if (stored === undefined || !sameScore(stored, game) || stored.plays.length === 0) return true;
  const last = stored.plays.findLast((p) => p.homeScore !== null && p.awayScore !== null);
  return last !== undefined && !sameScore(last, game);
}

/**
 * Reads ESPN's summary of each game whose score moved (`needsScoringPlays`) and stores its scoring
 * plays (`NFLPLAYS#<season>#W05`, 14-day TTL). A play keeps the time it was first seen, which the
 * scoring log matches entries against. Best effort per game: a failed read is logged and the game
 * is tried again on the next poll; it never fails the NFL games or live scoring.
 */
export async function refreshScoringPlays(
  deps: NflGamesDeps,
  season: number,
  week: number,
  previous: readonly LiveGame[],
  read: readonly LiveGame[],
  now: Date
): Promise<number> {
  const provider = deps.provider;
  if (provider?.getScoringPlays === undefined) return 0;
  const getScoringPlays = provider.getScoringPlays.bind(provider);
  let storedGames: StoredGamePlays[];
  try {
    storedGames = await deps.reference.nflPlays.listWeek(season, week);
  } catch (error) {
    deps.log.warn('could not read the stored scoring plays', { season, week, error });
    return 0;
  }
  const stored = new Map(storedGames.map((g) => [g.espnId, g]));
  const due = read.filter((game) =>
    needsScoringPlays(
      game,
      previous.find((p) => p.espnId === game.espnId),
      stored.get(game.espnId)
    )
  );
  const results = await Promise.allSettled(
    due.map(async (game) => {
      const plays = await getScoringPlays(game.espnId, now);
      const seen = new Map((stored.get(game.espnId)?.plays ?? []).map((p) => [p.id, p.seenAt]));
      await deps.reference.nflPlays.put({
        season,
        week,
        espnId: game.espnId,
        gameKey: game.gameKey,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
        plays: plays.map((p) => ({ ...p, seenAt: seen.get(p.id) ?? now.toISOString() })),
        updatedAt: now.toISOString()
      });
    })
  );
  let refreshed = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') refreshed++;
    else {
      deps.log.warn('could not read the scoring plays of a game; trying again next poll', {
        season,
        week,
        espnId: due[i]?.espnId,
        error: result.reason
      });
    }
  });
  return refreshed;
}
