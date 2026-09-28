import { LiveDataProvider } from '@fantasy/data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestJobDeps, nflState, StubProvider } from '../../test/support/jobs.js';
import { EventBridgePublisher } from '../events/eventbridge.js';
import { createLogger } from '../log.js';
import { loadJobsConfig } from './config.js';
import { isJobName, JOB_NAMES } from './index.js';
import { createJobDeps, handler, runJob } from './lambda.js';

const ENV = { TABLE_NAME: 'FantasyTable', NEWS_FEEDS_PARAMETER: '/fantasy/news-feeds' };

describe('loadJobsConfig', () => {
  it('reads the environment with defaults', () => {
    expect(loadJobsConfig(ENV)).toEqual({
      tableName: 'FantasyTable',
      eventBusName: 'default',
      sleeperBaseUrl: undefined,
      newsFeedsParameter: '/fantasy/news-feeds',
      newsFeeds: undefined,
      logLevel: 'info'
    });
    expect(
      loadJobsConfig({ ...ENV, SLEEPER_BASE_URL: 'https://sleeper.example', LOG_LEVEL: 'debug' })
    ).toMatchObject({ sleeperBaseUrl: 'https://sleeper.example', logLevel: 'debug' });
  });

  it('names what is missing or invalid', () => {
    expect(() => loadJobsConfig({ SLEEPER_BASE_URL: 'nope' })).toThrow(/TABLE_NAME, SLEEPER_BASE_URL/);
  });
});

describe('createJobDeps', () => {
  it('wires live providers and AWS clients without calling anything', () => {
    const deps = createJobDeps({ ...ENV, SLEEPER_BASE_URL: 'https://sleeper.example' });
    expect(deps.provider).toBeInstanceOf(LiveDataProvider);
    expect(deps.events).toBeInstanceOf(EventBridgePublisher);
    expect(createJobDeps(ENV).provider).toBeInstanceOf(LiveDataProvider);
  });
});

describe('runJob', () => {
  it('knows every job by name', () => {
    expect(JOB_NAMES).toEqual([
      'syncPlayers',
      'syncNflState',
      'syncSchedule',
      'ingestStats',
      'ingestProjections',
      'ingestTrending',
      'ingestNews',
      'scoreLiveWeek',
      'advanceSeason',
      'processWaivers'
    ]);
    expect(isJobName('syncPlayers')).toBe(true);
    expect(isJobName('toString')).toBe(false);
    expect(isJobName(7)).toBe(false);
  });

  it('runs the named job and reports its result', async () => {
    const lines: string[] = [];
    const provider = new StubProvider();
    provider.state = nflState();
    const deps = { ...createTestJobDeps({ provider }), log: createLogger({ sink: (l) => lines.push(l) }) };
    expect(await runJob({ job: 'syncNflState' }, deps, deps.clock)).toMatchObject({
      job: 'syncNflState',
      status: 'ok',
      week: 1
    });
    expect(await runJob({ job: 'ingestStats' }, deps, deps.clock)).toMatchObject({
      job: 'ingestStats',
      status: 'skipped',
      reason: 'no_schedule'
    });
    expect(lines.some((l) => l.includes('"job":"ingestStats"') && l.includes('job finished'))).toBe(true);
  });

  it('rejects unknown jobs and rethrows job failures after logging them', async () => {
    const lines: string[] = [];
    const deps = { ...createTestJobDeps(), log: createLogger({ sink: (l) => lines.push(l) }) };
    await expect(runJob({ job: 'nope' }, deps, deps.clock)).rejects.toThrow(/Unknown job "nope"/);
    await expect(runJob({}, deps, deps.clock)).rejects.toThrow(/Expected one of: syncPlayers/);
    await expect(runJob({ job: 'syncNflState' }, deps, deps.clock)).rejects.toThrow(/state was not set/);
    expect(lines.some((l) => l.includes('job failed'))).toBe(true);
  });
});

describe('handler', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('builds dependencies from the environment once and dispatches by job name', async () => {
    vi.stubEnv('TABLE_NAME', 'FantasyTable');
    vi.stubEnv('LOG_LEVEL', 'error');
    await expect(handler({ job: 'nope' })).rejects.toThrow(/Unknown job/);
    await expect(handler({ job: 'missing' })).rejects.toThrow(/Unknown job/);
  });
});
