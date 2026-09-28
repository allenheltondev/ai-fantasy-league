import { FixedClock, effectiveManager } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { START } from '../../../test/support/harness.js';
import { seedLeague } from '../../../test/support/leagues.js';
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
const MEMBER: Principal = { type: 'user', sub: 'user-777', email: null, name: 'Member' };
const AGENT = agentPrincipal({ agentId: 'lg-1.team-2', teamId: 'team-2', leagueId: 'lg-1' });
const SEAT = { personalityId: 'hype-man', difficulty: 'all_pro', archetype: 'win_now' };

async function setup(phase: LeaguePhase = 'setup') {
  const repos = createInMemoryRepos();
  await seedLeague(repos, {
    id: 'lg-1',
    // team-1: the commissioner; team-4: another person; team-2 and team-3: agent seats.
    owners: [{ sub: 'user-123', name: 'Commish' }, null, null, { sub: 'user-777', name: 'Member' }],
    teamCount: 4,
    overrides: { phase, week: phase === 'setup' ? null : 5 }
  });
  const events = new InMemoryEventPublisher();
  const services = createServices({
    clock: new FixedClock(START),
    repos,
    events,
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
  return { repos, run, services, events };
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
    const member = await run('get_agent_seat', { leagueId: 'lg-1', teamId: 'team-2' }, MEMBER);
    expect(member.body).toMatchObject({ data: { commissioner: null } });
    expect(JSON.stringify(member.body)).not.toContain('win_now');
    const outsider = await run('get_agent_seat', { leagueId: 'lg-1', teamId: 'team-2' }, OTHER);
    expect(outsider.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const agent = await run('get_agent_seat', { leagueId: 'lg-1', teamId: 'team-2' }, AGENT);
    expect(agent.body).toMatchObject({ data: { commissioner: null } });
    const missing = await run('get_agent_seat', { leagueId: 'lg-1', teamId: 'team-3' });
    expect(missing.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const noLeague = await run('get_agent_seat', { leagueId: 'nope', teamId: 'team-3' });
    expect(noLeague.body).toMatchObject({ error: { code: 'LEAGUE_NOT_FOUND' } });
  });

  it('is commissioner-only, human-only, and closed once the season is complete', async () => {
    const { run } = await setup();
    const other = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT }, OTHER);
    expect(other.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const agent = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT }, AGENT);
    expect(agent.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const midSeason = await setup('regular_season');
    const change = await midSeason.run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-2',
      ...SEAT
    });
    expect(change.body).toMatchObject({ data: { seat: { version: 1 } } });
    const complete = await setup('complete');
    const late = await complete.run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT });
    expect(late.body).toMatchObject({ error: { code: 'PHASE_NOT_ALLOWED' } });
    const bad = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team 2!', ...SEAT });
    expect(bad.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    const human = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-4', ...SEAT });
    expect(human.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    const ghost = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-9', ...SEAT });
    expect(ghost.body).toMatchObject({ error: { code: 'TEAM_NOT_FOUND' } });
  });

  it('announces post-draft changes that weaken or strengthen an agent, but not setup edits', async () => {
    const pre = await setup();
    await pre.run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT });
    await pre.run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-2',
      ...SEAT,
      difficulty: 'rookie'
    });
    expect(pre.events.events.filter((e) => e.detailType === 'Agent Seat Changed')).toEqual([]);

    const mid = await setup('regular_season');
    await mid.run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT });
    await mid.run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT });
    await mid.run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-2',
      ...SEAT,
      difficulty: 'rookie',
      archetype: 'balanced'
    });
    await mid.run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-2',
      ...SEAT,
      difficulty: 'rookie',
      archetype: 'balanced',
      personalityId: 'stats-nerd',
      advanced: { modelOverride: 'claude-opus-5' }
    });
    const announced = mid.events.events.filter((e) => e.detailType === 'Agent Seat Changed');
    expect(announced.map((e) => e.detail)).toEqual([
      {
        leagueId: 'lg-1',
        teamId: 'team-2',
        changedBy: 'user#user-123',
        phase: 'regular_season',
        version: 3,
        changes: [
          { field: 'difficulty', from: 'All-Pro', to: 'Rookie' },
          { field: 'archetype', from: 'Win Now', to: 'Balanced' },
          { field: 'model', from: 'Claude Sonnet 5', to: 'Amazon Nova Micro' }
        ]
      },
      expect.objectContaining({
        version: 4,
        changes: [
          { field: 'model', from: 'Amazon Nova Micro', to: 'Claude Opus 5' },
          { field: 'personality', from: 'Hype Man', to: 'The Spreadsheet' }
        ]
      })
    ]);
  });

  it('randomizes seats deterministically from a seed', async () => {
    const { run } = await setup();
    const a = await run('randomize_agent_seats', {
      leagueId: 'lg-1',
      teamIds: ['team-2', 'team-3'],
      seed: 'fixed'
    });
    expect(a.status).toBe(200);
    const data = (a.body as { data: { seed: string; seats: { config: { personalityId: string } }[] } }).data;
    expect(data.seed).toBe('fixed');
    expect(new Set(data.seats.map((s) => s.config.personalityId)).size).toBe(2);
    const b = await run('randomize_agent_seats', {
      leagueId: 'lg-1',
      teamIds: ['team-2', 'team-3'],
      seed: 'fixed'
    });
    const again = (b.body as typeof a.body & { data: typeof data }).data;
    expect(again.seats.map((s) => s.config)).toEqual(data.seats.map((s) => s.config));
    expect(again.seats.map((s) => (s as unknown as { version: number }).version)).toEqual([2, 2]);
    const unseeded = await run('randomize_agent_seats', { leagueId: 'lg-1', teamIds: ['team-3'] });
    expect(unseeded.body).toMatchObject({ data: { seed: `lg-1:${START}` } });
    const tooMany = await run('randomize_agent_seats', {
      leagueId: 'lg-1',
      teamIds: ['a', 'b', 'c', 'd', 'e']
    });
    expect(tooMany.body).toMatchObject({
      error: { code: 'INVALID_INPUT', message: 'This league has 4 teams.' }
    });
    const withHuman = await run('randomize_agent_seats', { leagueId: 'lg-1', teamIds: ['team-2', 'team-4'] });
    expect(withHuman.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('reports activity and the weekly budget to the commissioner', async () => {
    const { run, repos } = await setup('regular_season');
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
          byAgent: [{ agentId: 'lg-1.team-2', teamId: 'team-2', allowanceUsd: 0.5, costUsd: 0.5, tasks: 2 }],
          byModel: [{ modelKey: 'nova-lite' }, { modelKey: 'nova-pro' }]
        }
      }
    });
    const past = await run('get_agent_activity', { leagueId: 'lg-1', week: 4, teamId: 'team-2' });
    expect(past.body).toMatchObject({ data: { budget: { week: 4, spentUsd: 0, exceeded: false } } });
    const denied = await run('get_agent_activity', { leagueId: 'lg-1' }, OTHER);
    expect(denied.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const league5 = await repos.leagues.get('lg-1');
    expect(budgetWeek({ ...league5!, week: null })).toBe(0);
    expect((await leagueBudget(repos.agents, league5!)).week).toBe(5);
  });

  it('withholds sealed summaries (pending bids, private offers, open votes) until they resolve', async () => {
    const { run, repos } = await setup('regular_season');
    const base = {
      leagueId: 'lg-1',
      teamId: 'team-2',
      agentId: 'lg-1.team-2',
      week: 5,
      trigger: { detailType: 'Waiver Window Opened', eventId: 'e1' },
      status: 'completed' as const,
      fallbackReason: null,
      toolsCalled: [],
      latencyMs: 1,
      usage: [],
      costUsd: 0,
      startedAt: START,
      finishedAt: START
    };
    const trade = (tradeId: string, status: string) =>
      repos.trades.create({ leagueId: 'lg-1', trade: { tradeId, status, proposedAt: START } } as never);
    const claim = (id: string, status: string) =>
      repos.waivers.createClaim({ id, leagueId: 'lg-1', status } as never);
    await trade('t-open', 'proposed');
    await trade('t-review', 'in_review');
    await trade('t-done', 'processed');
    await trade('t-withdrawn', 'withdrawn');
    await trade('t-odd', 'some_future_status');
    await claim('c-pending', 'pending');
    await claim('c-awarded', 'awarded');
    const put = (taskId: string, sealed: Record<string, unknown> | undefined) =>
      repos.agents.completeTask(
        {
          ...base,
          taskId,
          kind: taskId,
          finalAction: 'x',
          reasoningSummary: `secret ${taskId}`,
          ...(sealed === undefined
            ? {}
            : { sealed: { summary: `sealed ${taskId}`, trades: [], waiverClaims: [], ...sealed } })
        } as never,
        new Date('2027-01-01T00:00:00.000Z')
      );
    await put('plain', undefined);
    await put('bids-pending', { waiverClaims: ['c-awarded', 'c-pending'] });
    await put('bids-resolved', { waiverClaims: ['c-awarded'] });
    await put('bid-missing', { waiverClaims: ['c-gone'] });
    await put('offer-private', { trades: [{ tradeId: 't-open', until: 'public' }] });
    await put('offer-public', { trades: [{ tradeId: 't-review', until: 'public' }] });
    await put('vote-open', { trades: [{ tradeId: 't-review', until: 'final' }] });
    await put('vote-final', { trades: [{ tradeId: 't-done', until: 'final' }] });
    await put('offer-missing', { trades: [{ tradeId: 't-gone', until: 'public' }] });
    // Withdrawn offers stay private, and a status this code does not know stays sealed.
    await put('offer-withdrawn', { trades: [{ tradeId: 't-withdrawn', until: 'public' }] });
    await put('offer-odd', { trades: [{ tradeId: 't-odd', until: 'final' }] });
    const result = await run('get_agent_activity', { leagueId: 'lg-1', limit: 100 });
    const tasks = (
      result.body as { data: { tasks: { kind: string; reasoningSummary: string; redacted: boolean }[] } }
    ).data.tasks;
    const shown = Object.fromEntries(tasks.map((t) => [t.kind, [t.reasoningSummary, t.redacted]]));
    expect(shown).toEqual({
      plain: ['secret plain', false],
      'bids-pending': ['sealed bids-pending', true],
      'bids-resolved': ['secret bids-resolved', false],
      'bid-missing': ['sealed bid-missing', true],
      'offer-private': ['sealed offer-private', true],
      'offer-public': ['secret offer-public', false],
      'vote-open': ['sealed vote-open', true],
      'vote-final': ['secret vote-final', false],
      'offer-missing': ['sealed offer-missing', true],
      'offer-withdrawn': ['sealed offer-withdrawn', true],
      'offer-odd': ['sealed offer-odd', true]
    });
    expect(JSON.stringify(result.body)).not.toContain('c-pending');
  });

  it('ranks models by win rate with standings and season cost (members only)', async () => {
    const { run, repos } = await setup('regular_season');
    const put = (teamId: string, difficulty: 'hall_of_famer' | 'rookie') =>
      repos.agents.putSeat({
        leagueId: 'lg-1',
        teamId,
        agentId: `lg-1.${teamId}`,
        config: { personalityId: 'hype-man', difficulty, archetype: 'balanced' },
        version: 1,
        updatedAt: START,
        updatedBy: 'user#user-123'
      });
    await put('team-2', 'hall_of_famer');
    await put('team-3', 'rookie');
    const empty = await run('get_model_leaderboard', { leagueId: 'lg-1' }, MEMBER);
    expect(empty.body).toMatchObject({
      data: {
        throughWeek: null,
        models: expect.arrayContaining([expect.objectContaining({ winRate: null })])
      }
    });

    const row = (teamId: string, rank: number, wins: number, losses: number, pointsFor: number) => ({
      teamId,
      rank,
      wins,
      losses,
      ties: 0,
      gamesPlayed: wins + losses,
      winPct: wins / (wins + losses),
      pointsFor,
      pointsAgainst: 400,
      streak: null,
      tiebreakerOverNext: null
    });
    await repos.schedule.putStandings({
      leagueId: 'lg-1',
      week: 4,
      rows: [
        row('team-2', 1, 4, 0, 520),
        row('team-1', 2, 2, 2, 450),
        row('team-4', 3, 2, 2, 430),
        row('team-3', 4, 0, 4, 380)
      ],
      computedAt: START
    });
    const usage = { leagueId: 'lg-1', modelKey: 'claude-opus-5', inputTokens: 1, outputTokens: 1, tasks: 1 };
    await repos.agents.addUsage({ ...usage, week: 1, agentId: 'lg-1.team-2', costUsd: 0.4 });
    await repos.agents.addUsage({ ...usage, week: 5, agentId: 'lg-1.team-2', costUsd: 0.4 });
    await repos.agents.addUsage({
      ...usage,
      week: 3,
      agentId: 'lg-1.team-3',
      modelKey: 'nova-micro',
      costUsd: 0.01
    });

    const result = await run('get_model_leaderboard', { leagueId: 'lg-1' }, MEMBER);
    const data = (result.body as { data: { throughWeek: number; teams: unknown[]; models: unknown[] } }).data;
    expect(data.throughWeek).toBe(4);
    expect(data.teams[0]).toMatchObject({
      teamId: 'team-2',
      seatType: 'agent',
      modelKey: 'claude-opus-5',
      provider: 'anthropic',
      personality: 'Hype Man',
      difficulty: 'Hall of Famer',
      winRate: 1,
      costUsd: 0.8,
      trades: 0,
      tradeValue: 0,
      waiverClaims: 0,
      waiverHitRate: null
    });
    expect(data.models).toEqual([
      expect.objectContaining({
        modelKey: 'claude-opus-5',
        teams: 1,
        wins: 4,
        costPerWinUsd: 0.2,
        bestRank: 1
      }),
      expect.objectContaining({
        modelKey: 'human',
        modelName: 'Human',
        teams: 2,
        winRate: 0.5,
        pointsForPerTeam: 440,
        costUsd: 0,
        costPerWinUsd: null
      }),
      expect.objectContaining({ modelKey: 'nova-micro', winRate: 0, costPerWinUsd: null, bestRank: 4 })
    ]);
    const outsider = await run('get_model_leaderboard', { leagueId: 'lg-1' }, OTHER);
    expect(outsider.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('shows the commissioner the kill switch state', async () => {
    const { run, services } = await setup('regular_season');
    const off = await run('get_agent_activity', { leagueId: 'lg-1' });
    expect(off.body).toMatchObject({ data: { killSwitch: { configured: false, engaged: false } } });
    services.agentKillSwitch = { engaged: async () => true };
    const on = await run('get_agent_activity', { leagueId: 'lg-1' });
    expect(on.body).toMatchObject({ data: { killSwitch: { configured: true, engaged: true } } });
  });

  it('lists the catalog and suggests varied seats from a seed', async () => {
    const { run } = await setup();
    const plain = await run('get_agent_catalog', {}, OTHER);
    const catalog = (plain.body as { data: Record<string, unknown[]> }).data;
    expect(catalog.personalities).toHaveLength(24);
    expect(catalog.difficulties).toHaveLength(5);
    expect(catalog.archetypes).toHaveLength(8);
    expect(catalog.modelTiers).toEqual(['micro', 'lite', 'standard', 'advanced', 'frontier']);
    expect(catalog.difficulties?.[0]).toMatchObject({ id: 'rookie', decisionModelTier: 'micro' });
    expect(catalog.models).toContainEqual(expect.objectContaining({ key: 'nova-micro', tier: 'micro' }));
    expect(catalog.models).toContainEqual(
      expect.objectContaining({ key: 'claude-opus-5', tier: 'frontier' })
    );
    expect(catalog.suggestion).toBeNull();
    const a = await run('get_agent_catalog', { suggest: 7, seed: 's1' });
    const b = await run('get_agent_catalog', { suggest: 7, seed: 's1' });
    const seats = (a.body as { data: { suggestion: { seed: string; seats: { personalityId: string }[] } } })
      .data.suggestion;
    expect(seats.seed).toBe('s1');
    expect(new Set(seats.seats.map((x) => x.personalityId)).size).toBe(7);
    expect(b.body).toEqual(a.body);
    const fresh = await run('get_agent_catalog', { suggest: 2 });
    expect(fresh.body).toMatchObject({ data: { suggestion: { seed: expect.any(String) } } });
    const tooMany = await run('get_agent_catalog', { suggest: 25 });
    expect(tooMany.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('names managers: set, kept when left out, unique in the league, and shown to members (#159)', async () => {
    const { run } = await setup();
    const named = await run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-2',
      ...SEAT,
      name: '  Marcus "Hype" Hale ',
      avatarSeed: 'hale-1'
    });
    expect(named.body).toMatchObject({
      data: {
        seat: {
          config: { name: 'Marcus "Hype" Hale', avatarSeed: 'hale-1' },
          manager: { name: 'Marcus "Hype" Hale', avatarSeed: 'hale-1' }
        }
      }
    });
    // A settings change without a name keeps the manager's name and avatar.
    const kept = await run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-2',
      ...SEAT,
      difficulty: 'pro'
    });
    expect(kept.body).toMatchObject({
      data: { seat: { config: { name: 'Marcus "Hype" Hale', avatarSeed: 'hale-1' } } }
    });
    const clash = await run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-3',
      ...SEAT,
      name: 'marcus "hype" hale'
    });
    expect(clash.body).toMatchObject({
      error: {
        code: 'INVALID_INPUT',
        fix: expect.stringContaining('Pick a name no one else in the league uses')
      }
    });
    const person = await run('configure_agent_seat', {
      leagueId: 'lg-1',
      teamId: 'team-3',
      ...SEAT,
      name: 'Member'
    });
    expect(person.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    for (const bad of [{ name: 'Two\nLines' }, { name: 'x'.repeat(41) }, { avatarSeed: 'no spaces' }]) {
      const res = await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-3', ...SEAT, ...bad });
      expect(res.body).toMatchObject({ error: { code: 'INVALID_INPUT', fix: expect.any(String) } });
    }
    const member = await run('get_agent_seat', { leagueId: 'lg-1', teamId: 'team-2' }, MEMBER);
    expect(member.body).toMatchObject({
      data: { seat: { manager: { name: 'Marcus "Hype" Hale', avatarSeed: 'hale-1' } } }
    });
    const state = await run('get_league_state', { leagueId: 'lg-1' }, MEMBER);
    const teams = (state.body as { data: { teams: { id: string; manager: unknown }[] } }).data.teams;
    expect(teams.find((t) => t.id === 'team-2')?.manager).toEqual({
      name: 'Marcus "Hype" Hale',
      avatarSeed: 'hale-1',
      personality: 'Hype Man'
    });
    // Not configured yet: a stable default name from the agent id.
    expect(teams.find((t) => t.id === 'team-3')?.manager).toEqual({
      ...effectiveManager(null, 'lg-1.team-3'),
      personality: null
    });
    expect(teams.find((t) => t.id === 'team-1')?.manager).toBeNull();
    const league = await run('get_league', { leagueId: 'lg-1' }, MEMBER);
    expect(league.body).toMatchObject({
      data: {
        teams: expect.arrayContaining([
          expect.objectContaining({
            id: 'team-2',
            manager: expect.objectContaining({ name: 'Marcus "Hype" Hale' })
          })
        ])
      }
    });
  });

  it('randomizes unique names and avatars that avoid the rest of the league (#159)', async () => {
    const { run } = await setup();
    await run('configure_agent_seat', { leagueId: 'lg-1', teamId: 'team-2', ...SEAT, name: 'Ruth Carter' });
    const res = await run('randomize_agent_seats', { leagueId: 'lg-1', teamIds: ['team-3'], seed: 'n' });
    const seat = (
      res.body as { data: { seats: { config: { name: string; avatarSeed: string }; manager: unknown }[] } }
    ).data.seats[0];
    expect(seat?.config.name).toEqual(expect.any(String));
    expect(seat?.config.name).not.toBe('Ruth Carter');
    expect(seat?.manager).toEqual({ name: seat?.config.name, avatarSeed: seat?.config.avatarSeed });
    const catalog = await run('get_agent_catalog', { suggest: 3, seed: 'c' });
    const data = (
      catalog.body as {
        data: {
          managerNames: { first: string[]; last: string[] };
          personalities: { nicknames: string[] }[];
          suggestion: { seats: { name: string; avatarSeed: string }[] };
        };
      }
    ).data;
    expect(data.managerNames.first.length).toBeGreaterThan(20);
    expect(data.personalities.every((p) => p.nicknames.length > 0)).toBe(true);
    expect(new Set(data.suggestion.seats.map((x) => x.name)).size).toBe(3);
  });
});
