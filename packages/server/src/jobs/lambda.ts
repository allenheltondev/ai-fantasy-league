/**
 * Lambda entrypoint for the scheduled data jobs. One function serves every job: each EventBridge
 * Scheduler schedule invokes it with `{ "job": "<name>" }` (see JOBS in ./index.ts and
 * DataJobsFunction in infra/template.yaml).
 *
 * scripts/package-server.sh bundles this file as `jobs.mjs` beside the API's `index.mjs` in the
 * same artifact, so the template's handler is `jobs.handler`.
 */
import { SSMClient } from '@aws-sdk/client-ssm';
import { systemClock, type Clock } from '@fantasy/core';
import { LiveDataProvider, NflverseClient, SleeperClient } from '@fantasy/data';
import { EventBridgePublisher } from '../events/eventbridge.js';
import { createLogger } from '../log.js';
import { PlayerDirectory } from '../players/directory.js';
import { createDynamoRepos } from '../repos/dynamo/index.js';
import { createDynamoReferenceStore } from '../repos/dynamo/reference.js';
import { createDocumentClient } from '../repos/dynamo/table.js';
import { loadJobsConfig } from './config.js';
import type { JobDeps, JobResult } from './deps.js';
import { isJobName, JOB_NAMES, JOBS } from './index.js';
import { createNewsSource } from './news/source.js';

export interface JobEvent {
  job?: unknown;
}

/** Builds production job dependencies from environment variables. */
export function createJobDeps(env: Record<string, string | undefined>, clock: Clock = systemClock): JobDeps {
  const config = loadJobsConfig(env);
  const log = createLogger({ level: config.logLevel, bindings: { component: 'data-jobs' } });
  const table = { doc: createDocumentClient(), tableName: config.tableName };
  const repos = createDynamoRepos(table);
  const provider = new LiveDataProvider({
    sleeper: new SleeperClient({ clock, ...(config.sleeperBaseUrl && { baseUrl: config.sleeperBaseUrl }) }),
    nflverse: new NflverseClient(),
    onCrosswalkReport: (report) => log.info('crosswalk report', { report })
  });
  return {
    provider,
    reference: createDynamoReferenceStore(table),
    events: new EventBridgePublisher({ busName: config.eventBusName }),
    directory: new PlayerDirectory({ repo: repos.players, clock }),
    log,
    news: createNewsSource({
      parameterName: config.newsFeedsParameter,
      ssm: new SSMClient({}),
      inline: config.newsFeeds,
      log
    })
  };
}

/** Runs one job by name. Unknown names fail loudly so a mistyped schedule shows up in alarms. */
export async function runJob(
  event: JobEvent,
  deps: JobDeps,
  clock: Clock
): Promise<JobResult & { job: string }> {
  if (!isJobName(event.job)) {
    throw new Error(`Unknown job ${JSON.stringify(event.job)}. Expected one of: ${JOB_NAMES.join(', ')}`);
  }
  const job = event.job;
  const log = deps.log.child({ job });
  const started = clock.now().getTime();
  try {
    const result = await JOBS[job]({ ...deps, log }, clock);
    log.info('job finished', {
      status: result.status,
      reason: result.reason,
      ms: clock.now().getTime() - started
    });
    return { job, ...result };
  } catch (error) {
    log.error('job failed', { error });
    throw error;
  }
}

let deps: JobDeps | null = null;

export async function handler(event: JobEvent): Promise<JobResult & { job: string }> {
  deps ??= createJobDeps(process.env);
  return runJob(event, deps, systemClock);
}
