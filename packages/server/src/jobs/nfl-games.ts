import type { ScheduledGame } from '@fantasy/data';
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
