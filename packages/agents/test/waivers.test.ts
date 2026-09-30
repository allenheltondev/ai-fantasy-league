import { suggestFaabBid, yahooDefaultSettings } from '@fantasy/core';
import { createContext, executeOperation, seatTenureStart, type UserPrincipal } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { claimsToApply } from '../src/tasks/waivers.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { AGENT_TEAM, LEAGUE_ID, setup, START } from './support.js';

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const COMMISSIONER: UserPrincipal = { type: 'user', sub: 'user-123', email: null, name: 'Allen' };
const HAWK = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'waiver_hawk' } as const;
const PATIENT = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;

function request(overrides: Partial<AgentActionRequested> = {}): AgentActionRequested {
  return {
    taskId: 'waivers.evt1',
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind: 'waivers',
    trigger: { detailType: 'Waiver Window Opened', eventId: 'evt-1', urgent: false },
    payload: { week: 5, closesAt: '2026-10-05T08:00:00.000Z' },
    requestedAt: START,
    ...overrides
  };
}

/**
 * A league with 3-player rosters. The agent (team-2) holds qb2, rb2, and te2, so every pickup
 * needs a drop. rb3 (30 projected points) was just dropped and is on waivers; rb1 is on team-3;
 * wr5 is a free agent who projects nothing. All three are trending.
 */
async function waiverLeague(
  config: typeof HAWK | typeof PATIENT,
  phase: 'regular_season' | 'drafting' = 'regular_season',
  options: { allowZeroBids?: boolean; trending?: boolean; rolling?: boolean } = {}
) {
  const settings = yahooDefaultSettings(4);
  settings.waivers.type = options.rolling === true ? 'rolling' : 'faab';
  settings.roster.slots = { QB: 1, RB: 1, BN: 1 };
  settings.waivers.allowZeroBids = options.allowZeroBids ?? true;
  const s = await setup({ league: { settings, phase } });
  await s.seat(AGENT_TEAM, config);
  for (const [teamId, roster] of [
    ['team-2', ['qb2', 'rb2', 'te2']],
    ['team-3', ['rb1']]
  ] as const) {
    const team = await s.repos.teams.get(LEAGUE_ID, teamId);
    if (team === null) throw new Error(teamId);
    await s.repos.teams.update({ ...team, roster: [...roster] });
  }
  await s.repos.waivers.putWireEntry({
    leagueId: LEAGUE_ID,
    playerId: 'rb3',
    droppedByTeamId: 'team-4',
    droppedAt: START,
    clearsAt: '2026-10-06T15:00:00.000Z'
  });
  if (options.trending === false) return s;
  await s.services.data.reference.trending.put({
    type: 'add',
    capturedAt: '2026-10-04T14:00:00.000Z',
    lookbacks: {
      '72': [
        { playerId: 'rb3', count: 900 },
        { playerId: 'rb1', count: 500 },
        { playerId: 'wr5', count: 100 }
      ]
    }
  });
  return s;
}

describe('waiver task', () => {
  it('keeps a repair goal active while its real waiver claim is pending', async () => {
    const s = await waiverLeague(HAWK);
    const injured = (await s.repos.players.get('rb2'))!;
    await s.repos.players.putMany([{ ...injured, injuryStatus: 'Out' }]);
    await runAgentAction(s.deps(new ScriptedModelClient()), request());
    expect(await s.repos.waivers.listClaims(LEAGUE_ID, 'pending')).toHaveLength(1);
    const team = (await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))!;
    const agenda = await s.repos.agents.getAgenda(LEAGUE_ID, AGENT_ID, seatTenureStart(team));
    expect(agenda.goals.find((g) => g.slot === 'RB')?.status).toBe('active');
    expect(team.roster).not.toContain('rb3');
  });

  it('claims the trending pickup with a FAAB bid shaped by the archetype (fake model default)', async () => {
    const s = await waiverLeague(HAWK);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), request());
    expect(record).toMatchObject({ status: 'completed', finalAction: 'claim_waiver' });
    const input = model.transcript[0]?.systemPrompt ?? '';
    expect(input).toContain('RB3 (rb3, RB): 30 projected pts, +30 over the drop; on waivers, bid $');
    expect(input).toContain('drop RB2 (rb2)');
    expect(input).not.toContain('(rb1,');

    const claims = await s.repos.waivers.listClaims(LEAGUE_ID, 'pending');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ teamId: AGENT_TEAM, addPlayerId: 'rb3', dropPlayerId: 'rb2' });
    const hawkBid = claims[0]?.bid ?? 0;
    // A waiver hawk (0.95) bids about 58% of the budget for a +30 pickup; noise is within ±8%.
    expect(hawkBid).toBeGreaterThanOrEqual(53);
    expect(hawkBid).toBeLessThanOrEqual(63);

    const patient = await waiverLeague(PATIENT);
    await runAgentAction(patient.deps(new ScriptedModelClient()), request());
    const patientBid = (await patient.repos.waivers.listClaims(LEAGUE_ID, 'pending'))[0]?.bid ?? 0;
    expect(patientBid).toBeLessThan(hawkBid);
    expect(patientBid).toBeGreaterThan(
      suggestFaabBid({ gain: 30, faabRemaining: 100, aggressiveness: 0.5 }) - 5
    );
  });

  it('talks about priority, not money, in a rolling league, and claims with no bid', async () => {
    const s = await waiverLeague(HAWK, 'regular_season', { rolling: true });
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), request());
    expect(record).toMatchObject({ status: 'completed', finalAction: 'claim_waiver' });
    const input = model.transcript[0]?.systemPrompt ?? '';
    expect(input).toContain('rolling waivers');
    expect(input).toContain('RB3 (rb3, RB): 30 projected pts, +30 over the drop; on waivers, place a claim');
    expect(input).not.toMatch(/FAAB|highest bid|bid \$/);
    const [claim] = await s.repos.waivers.listClaims(LEAGUE_ID, 'pending');
    expect(claim).toMatchObject({ addPlayerId: 'rb3', bid: 0 });
  });

  it('adds a free agent at no cost, and uses an open roster spot without a drop', async () => {
    const s = await waiverLeague(PATIENT);
    // A newer snapshot where qb1 (a free agent) also projects: 625 passing yards is 25 points.
    await s.services.data.reference.projections.putSnapshot(
      { season: 2026, week: 5, capturedAt: '2026-10-02T12:00:00.000Z', hash: 'fa', count: 2 },
      [
        { playerId: 'rb3', season: 2026, week: 5, stats: { rush_yd: 300 } },
        { playerId: 'qb1', season: 2026, week: 5, stats: { pass_yd: 625 } }
      ]
    );
    await s.services.data.reference.trending.put({
      type: 'add',
      capturedAt: '2026-10-04T14:30:00.000Z',
      lookbacks: { '72': [{ playerId: 'qb1', count: 50 }] }
    });
    const model = new ScriptedModelClient();
    await runAgentAction(s.deps(model), request({ payload: {} }));
    expect(model.transcript[0]?.systemPrompt).toContain(
      'QB1 (qb1, QB): 25 projected pts, +25 over the drop; free agent, add now, drop QB2 (qb2)'
    );
    expect((await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM))?.roster).toEqual(['rb2', 'te2', 'qb1']);

    const open = await waiverLeague(PATIENT);
    const team = await open.repos.teams.get(LEAGUE_ID, AGENT_TEAM);
    if (team === null) throw new Error('team');
    await open.repos.teams.update({ ...team, roster: ['qb2'] });
    const openModel = new ScriptedModelClient();
    await runAgentAction(open.deps(openModel), request());
    expect(await open.repos.waivers.listClaims(LEAGUE_ID, 'pending')).toMatchObject([
      { addPlayerId: 'rb3', dropPlayerId: null }
    ]);
  });

  it('suggests nothing without trending data, and bids at least $1 when $0 bids are off', async () => {
    const quiet = await waiverLeague(HAWK, 'regular_season', { trending: false });
    const model = new ScriptedModelClient();
    expect(await runAgentAction(quiet.deps(model), request())).toMatchObject({ finalAction: 'none' });
    expect(model.transcript[0]?.systemPrompt).toContain('No trending pickup looks better');

    const strict = await waiverLeague(PATIENT, 'regular_season', { allowZeroBids: false });
    const decision = new ScriptedModelClient();
    await runAgentAction(strict.deps(decision), request());
    expect((await strict.repos.waivers.listClaims(LEAGUE_ID, 'pending'))[0]?.bid).toBeGreaterThanOrEqual(1);
  });

  it('makes no claims when the model fails', async () => {
    const s = await waiverLeague(HAWK);
    const model = new ScriptedModelClient({ fail: () => new Error('bedrock is down') });
    const record = await runAgentAction(s.deps(model), request());
    expect(record).toMatchObject({ status: 'fallback', finalAction: 'none' });
    expect(await s.repos.waivers.listClaims(LEAGUE_ID)).toEqual([]);
  });

  it('submits the model’s claims, clamping bids to the budget and reporting refusals', async () => {
    const s = await waiverLeague(HAWK);
    const model = new ScriptedModelClient({
      script: () => ({
        steps: [{ tool: 'get_news', args: { playerId: 'rb3' } }],
        decision: {
          summary: 'All in on rb3.',
          claims: [
            { playerId: 'rb3', dropPlayerId: 'te2', bid: 500 },
            { playerId: 'rb1', dropPlayerId: 'qb2', bid: 1 }
          ]
        }
      })
    });
    const record = await runAgentAction(s.deps(model), request());
    expect(record.reasoningSummary).toBe(
      'All in on rb3. Claimed: rb3 ($100). Refused: rb1 (PLAYER_NOT_AVAILABLE).'
    );
    expect(record.toolsCalled.map((c) => c.name)).toContain('claim_waiver');
    expect(await s.repos.waivers.listClaims(LEAGUE_ID, 'pending')).toMatchObject([
      { bid: 100, dropPlayerId: 'te2' }
    ]);

    const empty = await waiverLeague(HAWK);
    const none = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'Pass.', claims: [] } })
    });
    expect(await runAgentAction(empty.deps(none), request())).toMatchObject({ finalAction: 'none' });

    const refused = await waiverLeague(HAWK);
    const bad = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'Oops.', claims: [{ playerId: 'rb1', bid: 1 }] } })
    });
    expect(await runAgentAction(refused.deps(bad), request())).toMatchObject({
      finalAction: 'claims_failed'
    });
  });

  it('does not claim a player again when another task claimed him since it looked (#248)', async () => {
    const s = await waiverLeague(HAWK);
    const model = new ScriptedModelClient({
      script: () => ({
        steps: [],
        decision: { summary: 'Going for rb3.', claims: [{ playerId: 'rb3', dropPlayerId: 'te2', bid: 5 }] }
      })
    });
    // The first task claims him; a second, which looked before that claim landed, would duplicate it.
    await runAgentAction(s.deps(model), request());
    const again = await runAgentAction(s.deps(model), request({ taskId: 'waivers.evt2' }));
    expect(again.reasoningSummary).toBe('Going for rb3. Already claimed: rb3.');
    expect(again.toolsCalled.filter((c) => c.name === 'claim_waiver')).toEqual([]);
    expect(await s.repos.waivers.listClaims(LEAGUE_ID, 'pending')).toHaveLength(1);
  });

  it('does nothing while waivers are closed', async () => {
    const s = await waiverLeague(HAWK, 'drafting');
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), request());
    expect(record).toMatchObject({
      finalAction: 'none',
      reasoningSummary: 'Nothing worth a claim this window.'
    });
    expect(model.transcript[0]?.systemPrompt).toContain('Waivers are closed right now.');
  });

  it('is triggered by Waiver Window Opened for every agent team', async () => {
    const s = await waiverLeague(HAWK);
    const decisions = await routeEvent(
      { services: s.services, kinds: defaultTaskKinds },
      {
        id: 'evt-9',
        'detail-type': 'Waiver Window Opened',
        source: 'fantasy',
        detail: { leagueId: LEAGUE_ID, week: 5 }
      }
    );
    expect(decisions).toMatchObject([{ teamId: AGENT_TEAM, decision: 'requested', kind: 'waivers' }]);
  });

  it('applies no more claims than the difficulty allows per trigger, whatever the model returns', async () => {
    const s = await waiverLeague(HAWK);
    await s.seat(AGENT_TEAM, { ...HAWK, advanced: { levers: { actionsPerTrigger: 1 } } });
    const greedy = new ScriptedModelClient({
      script: () => ({
        steps: [],
        decision: {
          summary: 'Everyone!',
          claims: [
            { playerId: 'rb3', dropPlayerId: 'te2', bid: 10 },
            { playerId: 'wr5', dropPlayerId: 'qb2', bid: 1 },
            { playerId: 'rb1', dropPlayerId: 'rb2', bid: 1 }
          ]
        }
      })
    });
    const record = await runAgentAction(s.deps(greedy), request());
    expect(record.toolsCalled.filter((c) => c.name === 'claim_waiver')).toHaveLength(1);
    expect(record.reasoningSummary).toBe(
      'Everyone! Claimed: rb3 ($10). Ignored 2 more claim(s) over the action limit.'
    );
    expect(greedy.transcript[0]?.systemPrompt).toContain(
      'most wanted first, at most 1; any more are ignored'
    );
    expect(claimsToApply([1, 2, 3], 2)).toEqual([1, 2]);
  });

  it('shows the model only what its research access could find', async () => {
    const s = await waiverLeague(HAWK);
    await s.seat(AGENT_TEAM, {
      ...HAWK,
      advanced: { levers: { research: { projections: false, trending: false } } }
    });
    const model = new ScriptedModelClient();
    await runAgentAction(s.deps(model), request());
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toMatch(/- RB3 \(rb3, RB\): on waivers, bid \$\d+, drop RB2 \(rb2\)\.\n/);
    expect(prompt).not.toContain('projected pts');
    expect(prompt).not.toContain('Trending adds');
  });

  it('seals the bids in the commissioner activity log until waivers are processed', async () => {
    const s = await waiverLeague(HAWK);
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), request());
    const [claim] = await s.repos.waivers.listClaims(LEAGUE_ID, 'pending');
    expect(record.sealed).toMatchObject({ waiverClaims: [claim?.id], trades: [] });
    const activity = async () => {
      const op = s.registry.get('get_agent_activity');
      const res = await executeOperation({
        registry: s.registry,
        operation: op!,
        ctx: createContext(s.services, COMMISSIONER),
        input: { leagueId: LEAGUE_ID },
        idempotencyKey: null
      });
      return (res.body as { data: { tasks: { reasoningSummary: string; redacted: boolean }[] } }).data
        .tasks[0];
    };
    const sealed = await activity();
    expect(sealed).toMatchObject({ redacted: true, finalAction: 'sealed', toolsCalled: [] });
    expect(sealed?.reasoningSummary).toBe(
      'Made 1 waiver claim(s); players and bids are hidden until waivers are processed.'
    );
    expect(JSON.stringify(sealed)).not.toContain(`$${claim?.bid}`);
    await s.repos.waivers.updateClaim({ ...claim!, status: 'awarded', resolvedAt: START, cost: claim!.bid });
    expect(await activity()).toMatchObject({ redacted: false, reasoningSummary: record.reasoningSummary });
  });
});
