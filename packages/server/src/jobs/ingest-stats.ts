import type { Clock } from '@fantasy/core';
import { deepEqual, isInGameWindow, type StatLine } from '@fantasy/data';
import type { PlayerDirectory } from '../players/directory.js';
import type { StoredStatLine } from '../repos/reference.js';
import { STATS_GAME_DURATION_MS } from '../season/window.js';
import { skipped, type JobDeps, type JobResult } from './deps.js';

/** The live stats window (kickoff to +4.5h), shared with the season loop. */
export { STATS_GAME_DURATION_MS };

/**
 * Ids of the synced player universe, used to skip lines for players we do not store (IDP, practice
 * squads). Null when nothing is synced yet, meaning "keep everything".
 */
export async function universeIds(directory: PlayerDirectory): Promise<Set<string> | null> {
  const players = await directory.all();
  return players.length === 0 ? null : new Set(players.map((p) => p.id));
}

export function inUniverse<T extends { playerId: string }>(
  lines: readonly T[],
  ids: Set<string> | null
): T[] {
  return ids === null ? [...lines] : lines.filter((l) => ids.has(l.playerId));
}

/**
 * Live stats (every 2 minutes, but only does work inside a game window). Reads the stored NFL state
 * and that week's stored schedule (two cheap reads) and returns early outside a window. Inside one
 * it pulls the week's stat lines, writes only the lines that changed to `STATS#<season>#W05`, and
 * emits `Scores Updated` with those player ids.
 */
export async function ingestStats(
  deps: Pick<JobDeps, 'provider' | 'reference' | 'events' | 'directory' | 'log'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const state = await deps.reference.nflState.get();
  if (state === null) return skipped('no_nfl_state');
  if (state.seasonType !== 'regular') return skipped('not_regular_season', { seasonType: state.seasonType });
  const games = await deps.reference.schedule.getWeek(state.season, state.week);
  if (games.length === 0) return skipped('no_schedule', { season: state.season, week: state.week });
  if (!isInGameWindow(now, games, { gameDurationMs: STATS_GAME_DURATION_MS })) {
    return skipped('outside_game_window', { season: state.season, week: state.week });
  }

  const [fetched, stored, ids] = await Promise.all([
    deps.provider.getWeekStats(state.season, state.week, now),
    deps.reference.stats.getWeek(state.season, state.week),
    universeIds(deps.directory)
  ]);
  const previous = new Map(stored.map((l) => [l.playerId, l]));
  const updatedAt = now.toISOString();
  const changed: StoredStatLine[] = inUniverse(fetched, ids)
    .filter((line) => !sameLine(previous.get(line.playerId), line))
    .map((line) => ({ ...line, updatedAt }));
  await deps.reference.stats.putLines(changed);
  if (changed.length > 0) {
    await deps.events.publish('Scores Updated', {
      season: state.season,
      week: state.week,
      playerIds: changed.map((l) => l.playerId),
      updatedAt
    });
  }
  return {
    status: 'ok',
    season: state.season,
    week: state.week,
    fetched: fetched.length,
    changed: changed.length
  };
}

/** Whether a stored line already matches a fetched one (team and stats). */
export function sameLine(before: StoredStatLine | undefined, after: StatLine): boolean {
  return before !== undefined && before.team === after.team && deepEqual(before.stats, after.stats);
}
