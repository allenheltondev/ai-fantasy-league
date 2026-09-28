import type { Clock } from '@fantasy/core';
import { detectWeekRollover } from '@fantasy/data';
import { skipped, type JobDeps, type JobResult } from './deps.js';

/**
 * NFL state (every 15 minutes). Stores Sleeper's season and week under `NFLSTATE`/`CURRENT` and,
 * when the week (or season type, or season) moves forward, emits `Week Rolled Over` exactly once:
 * the write is conditional on the state it replaced, so a concurrent or repeated run sees no
 * change and stays quiet.
 */
export async function syncNflState(
  deps: Pick<JobDeps, 'provider' | 'reference' | 'events' | 'log'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const [next, previous] = await Promise.all([deps.provider.getNflState(now), deps.reference.nflState.get()]);
  const rollover = detectWeekRollover(previous, next);
  const written = await deps.reference.nflState.put({ ...next, updatedAt: now.toISOString() }, previous);
  if (!written) {
    deps.log.warn('NFL state changed underneath this run; leaving the rollover to the writer that won');
    return skipped('concurrent_update');
  }
  if (rollover !== null) {
    await deps.events.publish('Week Rolled Over', {
      season: next.season,
      seasonType: next.seasonType,
      week: next.week,
      kind: rollover.kind,
      from: rollover.from,
      to: rollover.to,
      rolledOverAt: now.toISOString()
    });
    deps.log.info('week rolled over', { from: rollover.from, to: rollover.to });
  }
  return {
    status: 'ok',
    season: next.season,
    seasonType: next.seasonType,
    week: next.week,
    rolledOver: rollover !== null
  };
}
