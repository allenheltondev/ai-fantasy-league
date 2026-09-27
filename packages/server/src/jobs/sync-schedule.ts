import type { Clock } from '@fantasy/core';
import type { JobDeps, JobResult } from './deps.js';

/**
 * Schedule (daily). Stores the league season's games (UTC kickoffs, per week under
 * `NFLSCHED#<season>#W05`) and bye weeks, which live scoring's game-window gate and lineup locks
 * read. The season comes from the stored NFL state, or the provider's when none is stored yet.
 */
export async function syncSchedule(
  deps: Pick<JobDeps, 'provider' | 'reference' | 'log'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const state = (await deps.reference.nflState.get()) ?? (await deps.provider.getNflState(now));
  const season = state.leagueSeason;
  const [games, byes] = await Promise.all([
    deps.provider.getSchedule(season, now),
    deps.provider.getByeWeeks(season, now)
  ]);
  await deps.reference.schedule.putSeason(season, games, byes, now);
  const result: JobResult = {
    status: 'ok',
    season,
    games: games.length,
    teamsWithByes: Object.keys(byes).length
  };
  deps.log.info('schedule synced', result);
  return result;
}
