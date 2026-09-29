import { CHECK_IN_TIME_ZONE, zonedParts, zonedTimeToUtc, type Clock } from '@fantasy/core';
import type { RecurringJob } from '../events/loop.js';
import { managerCheckIns } from './check-ins.js';
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
  officialFinal: 'cron(0 15 ? * THU,FRI *)',
  processWaivers: 'cron(0 8 * * ? *)',
  syncSeasonResearch: 'rate(1 hour)',
  managerCheckIns: 'cron(0 9,14,20 * * ? *)'
};

/**
 * Jobs whose cron runs in a time zone rather than UTC (`ScheduleExpressionTimezone` on the
 * schedule in infra/template.yaml): the manager check-ins keep US Eastern wall-clock times through
 * daylight saving.
 */
export const JOB_SCHEDULE_TIMEZONES: Partial<Record<JobName, string>> = {
  managerCheckIns: CHECK_IN_TIME_ZONE
};

const UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const DAY_MS = 86_400_000;
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * The next run strictly after a moment, for the expression forms the template uses: `rate(N unit)`
 * (aligned to the epoch), a daily `cron(M H[,H...] * * ? *)`, and a weekly
 * `cron(M H[,H...] ? * DAY[,DAY...] *)`. Crons run in UTC unless a `timeZone` is given (a daily
 * cron only).
 */
export function nextRunFn(expression: string, timeZone?: string): (after: Date) => Date {
  const rate = /^rate\((\d+) (minute|hour|day)s?\)$/.exec(expression);
  if (rate !== null) {
    const every = Number(rate[1]) * (UNIT_MS[rate[2] as string] as number);
    return (after) => new Date((Math.floor(after.getTime() / every) + 1) * every);
  }
  const cron =
    /^cron\((\d+) (\d+(?:,\d+)*) (?:\* \* \?|\? \* ((?:SUN|MON|TUE|WED|THU|FRI|SAT)(?:,(?:SUN|MON|TUE|WED|THU|FRI|SAT))*)) \*\)$/.exec(
      expression
    );
  if (cron !== null) {
    const minute = Number(cron[1]);
    const days = cron[3] === undefined ? null : new Set(cron[3].split(',').map((d) => WEEKDAYS.indexOf(d)));
    const hours = (cron[2] as string)
      .split(',')
      .map(Number)
      .sort((a, b) => a - b);
    if (timeZone !== undefined) {
      if (days !== null) throw new Error(`Unsupported schedule expression in ${timeZone}: ${expression}`);
      return (after) => {
        const today = zonedParts(after, timeZone);
        for (let offset = 0; offset <= 1; offset++) {
          for (const hour of hours) {
            const at = zonedTimeToUtc({ ...today, day: today.day + offset, hour, minute }, timeZone);
            if (at.getTime() > after.getTime()) return at;
          }
        }
        /* v8 ignore next -- a daily cron always has a run by the end of the next day */
        throw new Error(`No run found for ${expression}`);
      };
    }
    return (after) => {
      const t = after.getTime();
      const day = Math.floor(t / DAY_MS) * DAY_MS;
      for (let offset = 0; offset <= 7 * DAY_MS; offset += DAY_MS) {
        if (days !== null && !days.has(new Date(day + offset).getUTCDay())) continue;
        for (const hour of hours) {
          const at = day + offset + hour * 3_600_000 + minute * 60_000;
          if (at > t) return new Date(at);
        }
      }
      /* v8 ignore next -- a daily or weekly cron always has a run within eight days */
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
    next:
      overrides[name] === undefined
        ? nextRunFn(JOB_SCHEDULE_EXPRESSIONS[name], JOB_SCHEDULE_TIMEZONES[name])
        : nextRunFn(overrides[name]),
    run: () => JOBS[name]({ ...deps, log: deps.log.child({ job: name }) }, clock)
  }));
}

/**
 * The league jobs alone (the weekly cycle, live scoring, waivers, manager check-ins), which need no
 * data provider: what local dev runs, since its reference data is seeded rather than ingested.
 */
export function seasonJobs(
  deps: Pick<JobDeps, 'repos' | 'reference' | 'events' | 'log'>,
  clock: Clock
): RecurringJob[] {
  const jobs = { advanceSeason, scoreLiveWeek, processWaivers, managerCheckIns };
  return (Object.keys(jobs) as (keyof typeof jobs)[]).map((name) => ({
    name,
    next: nextRunFn(JOB_SCHEDULE_EXPRESSIONS[name], JOB_SCHEDULE_TIMEZONES[name]),
    run: () => jobs[name]({ ...deps, log: deps.log.child({ job: name }) }, clock)
  }));
}
