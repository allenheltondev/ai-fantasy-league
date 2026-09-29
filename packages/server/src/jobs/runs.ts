import type { Logger } from '../log.js';
import type { JobRun, ReferenceStore } from '../repos/reference.js';
import type { JobResult } from './deps.js';

/**
 * The scheduled data jobs by name, in the order of JOBS in ./index.ts (a test keeps the two
 * equal). Kept apart from the jobs themselves so the API can list them without bundling the jobs.
 */
export const DATA_JOB_NAMES = [
  'syncPlayers',
  'syncNflState',
  'syncSchedule',
  'ingestStats',
  'ingestProjections',
  'ingestTrending',
  'ingestNews',
  'scoreLiveWeek',
  'advanceSeason',
  'officialFinal',
  'processWaivers',
  'syncSeasonResearch',
  'managerCheckIns',
  'syncGameDayInjuries'
] as const;

/** Longest summary or error message a run record keeps. */
export const JOB_RUN_TEXT_LIMIT = 1000;

function clip(text: string): string {
  return text.length <= JOB_RUN_TEXT_LIMIT ? text : `${text.slice(0, JOB_RUN_TEXT_LIMIT - 1)}…`;
}

/** The run record for a job that returned `result`. */
export function jobRunFromResult(
  job: string,
  result: JobResult,
  finishedAt: Date,
  durationMs: number
): JobRun {
  const { status, reason, ...rest } = result;
  return {
    job,
    finishedAt: finishedAt.toISOString(),
    status,
    reason: status === 'ok' ? null : (reason ?? null),
    summary: Object.keys(rest).length === 0 ? null : clip(JSON.stringify(rest)),
    durationMs
  };
}

/** The run record for a job that threw. */
export function jobRunFromError(job: string, error: unknown, finishedAt: Date, durationMs: number): JobRun {
  return {
    job,
    finishedAt: finishedAt.toISOString(),
    status: 'failed',
    reason: clip(error instanceof Error ? error.message : String(error)),
    summary: null,
    durationMs
  };
}

/**
 * Stores the run as the job's latest (`JOBRUN#<job>`). Best effort: a failure to record is logged
 * and never changes the job's own outcome.
 */
export async function recordJobRun(
  deps: { reference: Pick<ReferenceStore, 'jobRuns'>; log: Logger },
  run: JobRun
): Promise<void> {
  try {
    await deps.reference.jobRuns.put(run);
  } catch (error) {
    deps.log.warn('could not record the job run', { error, status: run.status });
  }
}
