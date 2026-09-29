import { LiveDataProvider } from '@fantasy/data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestJobDeps, nflState, StubProvider } from '../../test/support/jobs.js';
import { EventBridgePublisher } from '../events/eventbridge.js';
import { createLogger } from '../log.js';
import { loadJobsConfig } from './config.js';
import { isJobName, JOB_NAMES } from './index.js';
import { createJobDeps, handler, runJob } from './lambda.js';
import { DATA_JOB_NAMES, JOB_RUN_TEXT_LIMIT, jobRunFromError, jobRunFromResult } from './runs.js';

const ENV = { TABLE_NAME: 'FantasyTable', NEWS_FEEDS_PARAMETER: '/fantasy/news-feeds' };

describe('loadJobsConfig', () => {
  it('reads the environment with defaults', () => {
    expect(loadJobsConfig(ENV)).toEqual({
      tableName: 'FantasyTable',
      eventBusName: 'default',
      sleeperBaseUrl: undefined,
      newsFeedsParameter: '/fantasy/news-feeds',
      newsFeeds: undefined,
      logLevel: 'info',
      badgeChest: false,
      agentKillSwitchParam: undefined
    });
    expect(
      loadJobsConfig({ ...ENV, SLEEPER_BASE_URL: 'https://sleeper.example', LOG_LEVEL: 'debug' })
    ).toMatchObject({ sleeperBaseUrl: 'https://sleeper.example', logLevel: 'debug' });
    expect(loadJobsConfig({ ...ENV, BADGE_CHEST_ENABLED: 'true' }).badgeChest).toBe(true);
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
    // The agent kill switch is wired only when the deployment names its parameter.
    expect(createJobDeps(ENV).agentKillSwitch).toBeUndefined();
    expect(
      createJobDeps({ ...ENV, AGENT_KILL_SWITCH_PARAM: '/fantasy/agents/kill-switch' }).agentKillSwitch
    ).toBeDefined();
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
      'officialFinal',
      'processWaivers',
      'syncSeasonResearch',
      'managerCheckIns'
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

describe('job run records (#181)', () => {
  it('lists the same jobs the API reports on', () => {
    expect([...DATA_JOB_NAMES]).toEqual(JOB_NAMES);
  });

  it('records each run: ok as latest and last ok, a skip with its reason, a failure with its error', async () => {
    const provider = new StubProvider();
    provider.state = nflState();
    const deps = createTestJobDeps({ provider });
    await runJob({ job: 'syncNflState' }, deps, deps.clock);
    deps.clock.advance(60_000);
    await runJob({ job: 'ingestStats' }, deps, deps.clock);
    deps.clock.advance(60_000);
    provider.state = null;
    await expect(runJob({ job: 'syncNflState' }, deps, deps.clock)).rejects.toThrow();

    const [state, stats, never] = await deps.reference.jobRuns.list([
      'syncNflState',
      'ingestStats',
      'syncPlayers'
    ]);
    expect(state).toMatchObject({
      job: 'syncNflState',
      latest: { status: 'failed', reason: 'StubProvider: state was not set', summary: null },
      lastOk: { status: 'ok', reason: null, finishedAt: '2025-09-04T12:00:00.000Z' }
    });
    expect(JSON.parse(state?.lastOk?.summary ?? '')).toMatchObject({ season: 2025, week: 1 });
    expect(stats).toMatchObject({
      latest: { status: 'skipped', reason: 'no_schedule', finishedAt: '2025-09-04T12:01:00.000Z' },
      lastOk: null
    });
    expect(never).toEqual({ job: 'syncPlayers', latest: null, lastOk: null });
  });

  it('never fails a job because its record could not be written', async () => {
    const lines: string[] = [];
    const provider = new StubProvider();
    provider.state = nflState();
    const deps = { ...createTestJobDeps({ provider }), log: createLogger({ sink: (l) => lines.push(l) }) };
    deps.reference.jobRuns.put = async () => {
      throw new Error('table is gone');
    };
    expect(await runJob({ job: 'syncNflState' }, deps, deps.clock)).toMatchObject({ status: 'ok' });
    expect(lines.some((l) => l.includes('could not record the job run'))).toBe(true);
  });

  it('keeps summaries short, errors as text, and leaves out an empty summary', () => {
    const at = new Date('2026-09-28T12:00:00.000Z');
    const long = jobRunFromResult('ingestNews', { status: 'ok', items: 'x'.repeat(5000) }, at, 5);
    expect(long.summary).toHaveLength(JOB_RUN_TEXT_LIMIT);
    expect(long.summary?.endsWith('…')).toBe(true);
    expect(jobRunFromResult('ingestNews', { status: 'skipped' }, at, 5)).toEqual({
      job: 'ingestNews',
      finishedAt: at.toISOString(),
      status: 'skipped',
      reason: null,
      summary: null,
      durationMs: 5
    });
    expect(jobRunFromError('ingestNews', 'boom', at, 5)).toMatchObject({ status: 'failed', reason: 'boom' });
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
