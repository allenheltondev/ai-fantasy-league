import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelClient } from '../src/fake-model.js';
import { OFF_SWITCH, ParameterKillSwitch } from '../src/kill-switch.js';
import { AGENT_TEAM, LEAGUE_ID, setup } from './support.js';
import { handleLeagueEvent } from '@fantasy/server';
import { draftSetup } from './draft-support.js';

const env = await import('../src/lambda/env.js');

describe('agent Lambda environment', () => {
  it('validates the environment', () => {
    expect(() => env.loadAgentEnv({})).toThrow(/TABLE_NAME/);
    expect(env.loadAgentEnv({ TABLE_NAME: 't' })).toMatchObject({
      TABLE_NAME: 't',
      EVENT_BUS_NAME: 'default',
      LOG_LEVEL: 'info',
      AGENT_MODEL_TIMEOUT_MS: 90_000
    });
  });

  it('builds services, the model, and the kill switch', async () => {
    const services = env.createAgentServices(env.loadAgentEnv({ TABLE_NAME: 't' }));
    expect(services.repos.agents).toBeDefined();
    expect(env.isFakeModel({ FANTASY_FAKE_MODEL: '1' })).toBe(true);
    expect(env.isFakeModel({})).toBe(false);
    expect(await env.modelFromEnv({ FANTASY_FAKE_MODEL: 'true' })).toBeInstanceOf(ScriptedModelClient);
    expect((await env.modelFromEnv({})).name).toBe('bedrock');
    expect(env.killSwitchFromEnv({}, services)).toBe(OFF_SWITCH);
    expect(env.killSwitchFromEnv({ AGENT_KILL_SWITCH_PARAM: '/ks' }, services)).toBeInstanceOf(
      ParameterKillSwitch
    );
  });
});

describe('agent Lambda handlers', () => {
  afterEach(() => {
    vi.doUnmock('../src/lambda/env.js');
    vi.doUnmock('@fantasy/server');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('routes a trigger and runs the task it requested, end to end with the fake model', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' });
    vi.stubEnv('TABLE_NAME', 'unused');
    vi.stubEnv('FANTASY_FAKE_MODEL', '1');
    vi.resetModules();
    vi.doMock('../src/lambda/env.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/lambda/env.js')>()),
      createAgentServices: () => s.services
    }));

    const router = await import('../src/lambda/router.js');
    const routed = await router.handler({
      id: 'evt-9',
      'detail-type': 'Lineup Lock Approaching',
      source: 'fantasy',
      detail: { leagueId: LEAGUE_ID, week: 5 }
    });
    expect(routed.decisions).toMatchObject([{ teamId: AGENT_TEAM, decision: 'requested', kind: 'lineup' }]);

    const task = await import('../src/lambda/task.js');
    const requested = s.events.events.find((e) => e.detailType === 'Agent Action Requested');
    const record = await task.handler({
      id: 'evt-10',
      'detail-type': 'Agent Action Requested',
      source: 'fantasy',
      detail: requested?.detail
    });
    expect(record).toMatchObject({ status: 'completed', finalAction: 'set_lineup', teamId: AGENT_TEAM });
    expect(await s.savedLineups()).toHaveLength(1);
  });

  it('writes agent memory for league events before routing, and survives a memory failure', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' });
    vi.stubEnv('TABLE_NAME', 'unused');
    vi.resetModules();
    vi.doMock('../src/lambda/env.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/lambda/env.js')>()),
      createAgentServices: () => s.services
    }));
    const router = await import('../src/lambda/router.js');
    const final = {
      id: 'evt-final',
      'detail-type': 'Week Provisionally Final',
      source: 'fantasy',
      detail: {
        leagueId: LEAGUE_ID,
        week: 4,
        matchups: [{ homeTeamId: 'team-1', awayTeamId: AGENT_TEAM, homeScore: 100, awayScore: 99 }]
      }
    };
    expect(await router.handler(final)).toEqual({ decisions: [], remembered: 1 });
    s.repos.agents.listSeats = async () => {
      throw new Error('table down');
    };
    expect(await router.handler({ ...final, id: 'evt-final-2' })).toEqual({ decisions: [], remembered: 0 });
    expect(s.logs.some((l) => l.includes('agent memory update failed'))).toBe(true);
  });

  it('grades the draft on Draft Completed with the fake model', async () => {
    const s = await draftSetup({ teamCount: 4 });
    for (let guard = 0; guard < 200; guard++) {
      const draft = await s.repos.drafts.get(s.leagueId);
      if (draft?.status === 'complete') break;
      s.clock.set(new Date(new Date(draft?.deadline ?? s.clock.now()).getTime() + 1000));
      await handleLeagueEvent(s.services, {
        id: `deadline-${String(draft!.state.picks.length + 1)}`,
        source: 'fantasy',
        'detail-type': 'Draft Pick Deadline',
        detail: { leagueId: s.leagueId, pick: draft!.state.picks.length + 1 }
      });
    }
    vi.stubEnv('TABLE_NAME', 'unused');
    vi.stubEnv('FANTASY_FAKE_MODEL', '1');
    vi.resetModules();
    vi.doMock('../src/lambda/env.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/lambda/env.js')>()),
      createAgentServices: () => s.services
    }));
    const task = await import('../src/lambda/task.js');
    const completed = s.events.events.find((e) => e.detailType === 'Draft Completed');
    const report = await task.handler({
      id: 'evt-draft',
      'detail-type': 'Draft Completed',
      source: 'fantasy',
      detail: completed?.detail
    });
    expect(report).toMatchObject({ status: 'ready', source: 'model', leagueId: s.leagueId });
  });
});
