import { managerCheckIns } from './check-ins.js';
import type { Job } from './deps.js';
import { ingestNews } from './ingest-news.js';
import { ingestProjections } from './ingest-projections.js';
import { ingestStats } from './ingest-stats.js';
import { ingestTrending } from './ingest-trending.js';
import { advanceSeason, officialFinal, scoreLiveWeek } from './season.js';
import { processWaivers } from './process-waivers.js';
import { syncNflState } from './sync-nfl-state.js';
import { syncPlayers } from './sync-players.js';
import { syncSchedule } from './sync-schedule.js';
import { syncSeasonResearch } from './sync-season-research.js';

/**
 * Every scheduled job, by the name the EventBridge schedules send as `{ "job": "<name>" }`.
 * Cadences live in infra/template.yaml (DataJobsFunction's ScheduleV2 events).
 */
export const JOBS = {
  syncPlayers,
  syncNflState,
  syncSchedule,
  ingestStats,
  ingestProjections,
  ingestTrending,
  ingestNews,
  scoreLiveWeek,
  advanceSeason,
  officialFinal,
  processWaivers,
  syncSeasonResearch,
  managerCheckIns
} as const satisfies Record<string, Job>;

export type JobName = keyof typeof JOBS;
export const JOB_NAMES = Object.keys(JOBS) as JobName[];

export function isJobName(value: unknown): value is JobName {
  return typeof value === 'string' && Object.hasOwn(JOBS, value);
}

export type { Job, JobDeps, JobResult, NewsSource } from './deps.js';
export {
  advanceSeason,
  ingestNews,
  ingestProjections,
  ingestStats,
  ingestTrending,
  managerCheckIns,
  scoreLiveWeek,
  officialFinal,
  processWaivers,
  syncNflState,
  syncPlayers,
  syncSchedule,
  syncSeasonResearch
};
