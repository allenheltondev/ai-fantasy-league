import type { Clock } from '@fantasy/core';
import type { RecurringJob } from '../events/loop.js';
import type { JobDeps } from './deps.js';
import { JOBS, type JobName } from './index.js';
import { processWaivers } from './process-waivers.js';
import { advanceSeason, scoreLiveWeek } from './season.js';

/**
 * The job cadences, exactly as the EventBridge Scheduler expressions on DataJobsFunction in
 * infra/template.yaml (a test keeps the two equal). The in-process event loop (the season replay
 * simulator, local dev) runs the jobs on these cadences.
 */
export const JOB_SCHEDULE_EXPRESSIONS: Record<JobName, string> = {
  syncPlayers: 'cron(17 9,21 * * ? *)',
  syncNflState: 'rate(15 minutes)',
  syncSchedule: 'cron(7 10 * * ? *)',
  ingestStats: 'rate(2 minutes)',
  ingestProjections: 'rate(1 hour)',
  ingestTrending: 'rate(1 hour)',
  ingestNews: 'rate(15 minutes)',
  scoreLiveWeek: 'rate(2 minutes)',
  advanceSeason: 'rate(15 minutes)',
  processWaivers: 'cron(0 8 * * ? *)'
};

const UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const DAY_MS = 86_400_000;

/**
 * The next run strictly after a moment, for the two expression forms the template uses:
 * `rate(N unit)` (aligned to the epoch) and a daily `cron(M H[,H...] * * ? *)` in UTC.
 */
export function nextRunFn(expression: string): (after: Date) => Date {
  const rate = /^rate\((\d+) (minute|hour|day)s?\)$/.exec(expression);
  if (rate !== null) {
    const every = Number(rate[1]) * (UNIT_MS[rate[2] as string] as number);
    return (after) => new Date((Math.floor(after.getTime() / every) + 1) * every);
  }
  const cron = /^cron\((\d+) (\d+(?:,\d+)*) \* \* \? \*\)$/.exec(expression);
  if (cron !== null) {
    const minute = Number(cron[1]);
    const hours = (cron[2] as string)
      .split(',')
      .map(Number)
      .sort((a, b) => a - b);
    return (after) => {
      const t = after.getTime();
      const day = Math.floor(t / DAY_MS) * DAY_MS;
      for (const offset of [0, DAY_MS]) {
        for (const hour of hours) {
          const at = day + offset + hour * 3_600_000 + minute * 60_000;
          if (at > t) return new Date(at);
        }
      }
      /* v8 ignore next -- a daily cron always has a run within two days */
      throw new Error(`No run found for ${expression}`);
    };
  }
  throw new Error(`Unsupported schedule expression: ${expression}`);
}

/** The named jobs as recurring jobs for the event loop, on their production cadences unless overridden. */
export function recurringJobs(
  deps: JobDeps,
  clock: Clock,
  names: readonly JobName[],
  overrides: Partial<Record<JobName, string>> = {}
): RecurringJob[] {
  return names.map((name) => ({
    name,
    next: nextRunFn(overrides[name] ?? JOB_SCHEDULE_EXPRESSIONS[name]),
    run: () => JOBS[name]({ ...deps, log: deps.log.child({ job: name }) }, clock)
  }));
}

/**
 * The league jobs alone (the weekly cycle, live scoring, waivers), which need no data provider:
 * what local dev runs, since its reference data is seeded rather than ingested.
 */
export function seasonJobs(
  deps: Pick<JobDeps, 'repos' | 'reference' | 'events' | 'log'>,
  clock: Clock
): RecurringJob[] {
  const jobs = { advanceSeason, scoreLiveWeek, processWaivers };
  return (Object.keys(jobs) as (keyof typeof jobs)[]).map((name) => ({
    name,
    next: nextRunFn(JOB_SCHEDULE_EXPRESSIONS[name]),
    run: () => jobs[name]({ ...deps, log: deps.log.child({ job: name }) }, clock)
  }));
}
