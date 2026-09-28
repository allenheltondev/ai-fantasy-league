import type { Clock } from '@fantasy/core';
import { processLeagueWaivers, type ProcessResult } from '../waivers/process.js';
import type { JobDeps, JobResult } from './deps.js';

/**
 * Waiver processing (daily at the waiver run hour; see `WAIVER_RUN_HOUR_UTC`). Resolves the due
 * claims of every in-season league, one league at a time so a failure in one does not stop the
 * others. Each league's run is idempotent per window (`processLeagueWaivers`).
 */
export async function processWaivers(
  deps: Pick<JobDeps, 'repos' | 'events' | 'log'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const leagues = [
    ...(await deps.repos.leagues.listByPhase('regular_season')),
    ...(await deps.repos.leagues.listByPhase('playoffs'))
  ];
  const results: ProcessResult[] = [];
  const errors: string[] = [];
  for (const league of leagues) {
    try {
      results.push(await processLeagueWaivers(deps, league, now));
    } catch (error) {
      deps.log.error('waiver processing failed', { leagueId: league.id, error });
      errors.push(league.id);
    }
  }
  if (errors.length > 0 && errors.length === leagues.length) {
    throw new Error(`Waiver processing failed for every league: ${errors.join(', ')}`);
  }
  return {
    status: 'ok',
    leagues: leagues.length,
    processed: results.filter((r) => r.status === 'processed').length,
    awarded: results.reduce((sum, r) => sum + r.awarded, 0),
    failedLeagues: errors
  };
}
