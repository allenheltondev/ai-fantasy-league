import { FixedClock } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { league, START } from '../../../test/support/harness.js';
import { agentPrincipal, type Principal } from '../../auth/principal.js';
import { createContext } from '../../context.js';
import { InMemoryEventPublisher } from '../../events/publisher.js';
import { silentLogger } from '../../log.js';
import { executeOperation } from '../../registry/execute.js';
import { createInMemoryRepos } from '../../repos/memory.js';
import type { LeaguePhase } from '../../repos/types.js';
import { createServices } from '../../services.js';
import { registry } from '../index.js';
import { budgetWeek, leagueBudget } from './budget.js';

const COMMISH: Principal = { type: 'user', sub: 'user-123', email: null, name: 'Commish' };
const OTHER: Principal = { type: 'user', sub: 'user-999', email: null, name: 'Other' };
const AGENT = agentPrincipal({ agentId: 'lg-1.team-2', teamId: 'team-2', leagueId: 'lg-1' });
const SEAT = { personalityId: 'hype-man', difficulty: 'all_pro', archetype: 'win_now' };

async function setup(phase: LeaguePhase = 'setup') {
  const repos = createInMemoryRepos();
  await repos.leagues.create(league({ phase, teamCount: 4, week: phase === 'setup' ? null : 5 }));
  const services = createServices({
    clock: new FixedClock(START),
    repos,
    events: new InMemoryEventPublisher(),
    log: silentLogger
  });
  let n = 0;
  const run = async (name: string, input: Record<string, unknown>, principal: Principal = COMMISH) => {
    const operation = registry.get(name);
    if (operation === undefined) throw new Error(name);
    const result = await executeOperation({
      registry,
      operation,
      ctx: createContext(services, principal),
      input,
      idempotencyKey: operation.mutation ? `test-key-${++n}` : null
    });
    return result;
  };
  return { repos, run };
}

describe('agent seat operations', () => {
  it('configures a seat with versioned history and effective settings', async () => {
    const { run, repos } = await setup();
    const first = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      data: {
        seat: {
          teamId: 'team-2',
          agentId: 'lg-1.team-2',
          version: 1,
          updatedBy: 'user#user-123',
          effective: {
            decisionModels: ['claude-sonnet-5', 'claude-haiku-4-5', 'nova-pro'],
            actionsPerTrigger: 4
          }
        }
      }
    });
    const second = await run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-2',
      ...SEAT,
      difficulty: 'rookie',
      advanced: { modelOverride: 'nova-pro' },
      expectedVersion: 1
    });
    expect(second.body).toMatchObject({
      data: { seat: { version: 2, effective: { decisionModels: ['nova-pro', 'nova-micro', 'nova-lite'] } } }
    });
    const stale = await run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-2',
      ...SEAT,
      expectedVersion: 1
    });
    expect(stale.body).toMatchObject({ error: { code: 'CONFLICT', details: { currentVersion: 2 } } });
    expect(await repos.agents.seatHistory('lg-1', 'team-2')).toHaveLength(2);
  });

  it('shows the full config only to the commissioner', async () => {
    const { run } = await setup();
    await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT });
    const commish = await run('get_agent_seat', { leagueId: 'lg-1', teamId: 'team-2' });
    expect(commish.body).toMatchObject({
      data: {
        seat: {
          personality: { id: 'hype-man', displayName: 'Hype Man' },
          difficulty: { displayName: 'All-Pro' }
        },
        commissioner: { current: { version: 1 }, history: [{ version: 1 }] }
      }
    });
    const other = await run('get_agent_seat', { leagueId: 'lg-1', teamId: 'team-2' }, OTHER);
    expect(other.body).toMatchObject({ data: { commissioner: null } });
    expect(JSON.stringify(other.body)).not.toContain('win_now');
    const agent = await run('get_agent_seat', { leagueId: 'lg-1', teamId: 'team-2' }, AGENT);
    expect(agent.body).toMatchObject({ data: { commissioner: null } });
    const missing = await run('get_agent_seat', { leagueId: 'lg-1', teamId: 'team-3' });
    expect(missing.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const noLeague = await run('get_agent_seat', { leagueId: 'nope', teamId: 'team-3' });
    expect(noLeague.body).toMatchObject({ error: { code: 'LEAGUE_NOT_FOUND' } });
  });

  it('is commissioner-only, human-only, and pre-draft only', async () => {
    const { run } = await setup();
    const other = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT }, OTHER);
    expect(other.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const agent = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT }, AGENT);
    expect(agent.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const drafting = await setup('drafting');
    const late = await drafting.run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT });
    expect(late.body).toMatchObject({ error: { code: 'PHASE_NOT_ALLOWED' } });
    const bad = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team 2!', ...SEAT });
    expect(bad.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('randomizes seats deterministically from a seed', async () => {
    const { run } = await setup();
    const a = await run('randomize_agent_seats', {
      leagueId: 'lg-1',
      teamIds: ['t1', 't2', 't3'],
      seed: 'fixed'
    });
    expect(a.status).toBe(200);
    const data = (a.body as { data: { seed: string; seats: { config: { personalityId: string } }[] } }).data;
    expect(data.seed).toBe('fixed');
    expect(new Set(data.seats.map((s) => s.config.personalityId)).size).toBe(3);
    const b = await run('randomize_agent_seats', {
      leagueId: 'lg-1',
      teamIds: ['t1', 't2', 't3'],
      seed: 'fixed'
    });
    const again = (b.body as typeof a.body & { data: typeof data }).data;
    expect(again.seats.map((s) => s.config)).toEqual(data.seats.map((s) => s.config));
    expect(again.seats.map((s) => (s as unknown as { version: number }).version)).toEqual([2, 2, 2]);
    const unseeded = await run('randomize_agent_seats', { leagueId: 'lg-1', teamIds: ['t4'] });
    expect(unseeded.body).toMatchObject({ data: { seed: `lg-1:${START}` } });
    const tooMany = await run('randomize_agent_seats', {
      leagueId: 'lg-1',
      teamIds: ['a', 'b', 'c', 'd', 'e']
    });
    expect(tooMany.body).toMatchObject({
      error: { code: 'INVALID_INPUT', message: 'This league has 4 teams.' }
    });
  });

  it('reports activity and the weekly budget to the commissioner', async () => {
    const { run, repos } = await setup('pre_lock');
    await repos.agents.putSeat({
      leagueId: 'lg-1',
      teamId: 'team-2',
      agentId: 'lg-1.team-2',
      config: { personalityId: 'hype-man', difficulty: 'pro', archetype: 'balanced' },
      version: 1,
      updatedAt: START,
      updatedBy: 'user#user-123'
    });
    const row = {
      leagueId: 'lg-1',
      week: 5,
      agentId: 'lg-1.team-2',
      modelKey: 'nova-pro',
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.2,
      tasks: 1
    };
    await repos.agents.addUsage(row);
    await repos.agents.addUsage({ ...row, modelKey: 'nova-lite', costUsd: 0.3 });
    const result = await run('get_agent_activity', { leagueId: 'lg-1' });
    expect(result.body).toMatchObject({
      data: {
        tasks: [],
        budget: {
          week: 5,
          ceilingUsd: 0.5,
          spentUsd: 0.5,
          remainingUsd: 0,
          exceeded: true,
          byAgent: [{ agentId: 'lg-1.team-2', costUsd: 0.5, tasks: 2 }],
          byModel: [{ modelKey: 'nova-lite' }, { modelKey: 'nova-pro' }]
        }
      }
    });
    const past = await run('get_agent_activity', { leagueId: 'lg-1', week: 4, teamId: 'team-2' });
    expect(past.body).toMatchObject({ data: { budget: { week: 4, spentUsd: 0, exceeded: false } } });
    const denied = await run('get_agent_activity', { leagueId: 'lg-1' }, OTHER);
    expect(denied.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(budgetWeek(league())).toBe(0);
    const league5 = await repos.leagues.get('lg-1');
    expect((await leagueBudget(repos.agents, league5!)).week).toBe(5);
  });
});
