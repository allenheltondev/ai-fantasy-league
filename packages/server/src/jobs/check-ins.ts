import { checkInMoment, type Clock } from '@fantasy/core';
import { listInSeason } from '../season/lineups.js';
import type { JobDeps, JobResult } from './deps.js';
import { settle, skipped } from './deps.js';

/**
 * Manager check-ins (#195), three times a day (09:00, 14:00, 20:00 US Eastern; see
 * `JOB_SCHEDULE_TIMEZONES`). Agents otherwise act only when something happens in the league, so in a
 * quiet league they never look at their teams. This job publishes one `Manager Check-In` per
 * drafted, unfinished league with agent seats; the agent router turns it into a `check_in` task for
 * every agent there, each after its own human-like delay.
 *
 * - Leagues in setup or drafting, and complete leagues, are left out (`listInSeason`).
 * - With the agent kill switch on, nothing is published (the check-ins would only run fallbacks).
 * - The check-in's key is its local date and slot (`checkInMoment`): the router fires once per
 *   league and key, so a retried or replayed run changes nothing.
 */
export async function managerCheckIns(
  deps: Pick<JobDeps, 'repos' | 'events' | 'log' | 'agentKillSwitch'>,
  clock: Clock
): Promise<JobResult> {
  const moment = checkInMoment(clock.now());
  if ((await deps.agentKillSwitch?.engaged()) === true) return skipped('kill_switch', { slot: moment.slot });
  const leagues = await listInSeason(deps.repos);
  let published = 0;
  let failed = 0;
  for (const league of leagues) {
    try {
      if ((await deps.repos.agents.listSeats(league.id)).length === 0) continue;
      await deps.events.publish('Manager Check-In', {
        leagueId: league.id,
        slot: moment.slot,
        date: moment.date,
        at: moment.at.toISOString(),
        nextAt: moment.nextAt.toISOString(),
        week: league.week
      });
      published++;
    } catch (error) {
      deps.log.error('manager check-in failed', { leagueId: league.id, error });
      failed++;
    }
  }
  return settle(deps.log, 'managerCheckIns', {
    status: 'ok',
    slot: moment.slot,
    date: moment.date,
    leagues: leagues.length,
    published,
    failed
  });
}
