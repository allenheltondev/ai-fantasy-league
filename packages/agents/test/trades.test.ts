import { ARCHETYPES, resolveAgentConfig, tradeAppetite } from '@fantasy/core';
import { createContext, executeOperation, type UserPrincipal } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { acceptBar, countersUsed } from '../src/tasks/trades.js';
import { AGENT_TEAM, LEAGUE_ID, roster, setup, START, type Setup } from './support.js';

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const ALLEN: UserPrincipal = { type: 'user', sub: 'user-123', email: null, name: 'Allen' };
const PRO = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;
const ROOKIE = { ...PRO, difficulty: 'rookie' } as const;

/**
 * The agent (team-2) rosters every support player but rb3 (the only one who projects: 30 points a
 * week); Allen (team-1) has rb3. Allen's tools run through the same registry as the agent's.
 */
async function tradeLeague(config: typeof PRO | typeof ROOKIE): Promise<Setup> {
  const s = await setup();
  await s.seat(AGENT_TEAM, config);
  const rosters: Record<string, string[]> = {
    'team-1': ['rb3'],
    'team-2': roster()
      .map((r) => r.playerId)
      .filter((id) => id !== 'rb3'),
    'team-3': []
  };
  for (const [teamId, ids] of Object.entries(rosters)) {
    const team = await s.repos.teams.get(LEAGUE_ID, teamId);
    if (team === null) throw new Error(teamId);
    await s.repos.teams.update({ ...team, roster: ids });
  }
  await s.repos.lineups.put([]);
  return s;
}

let keys = 0;
async function allen(s: Setup, name: string, args: Record<string, unknown>) {
  const operation = s.registry.get(name);
  if (operation === undefined) throw new Error(name);
  const { idempotencyKey, ...input } = {
    leagueId: LEAGUE_ID,
    idempotencyKey: `allen-key-${++keys}-0000`,
    ...args
  };
  const res = await executeOperation({
    registry: s.registry,
    operation,
    ctx: createContext(s.services, ALLEN),
    input,
    idempotencyKey
  });
  const body = res.body as { data?: { trade: { id: string; status: string } }; error?: unknown };
  if (body.data === undefined) throw new Error(JSON.stringify(body));
  return body.data.trade;
}

function request(tradeId: string, eventId: string): AgentActionRequested {
  return {
    taskId: `trade_response.${eventId}`,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind: 'trade_response',
    trigger: { detailType: 'Trade Proposed', eventId, urgent: true },
    payload: { tradeId, fromTeamId: 'team-1' },
    requestedAt: START
  };
}

const status = async (s: Setup, tradeId: string) =>
  (await s.repos.trades.get(LEAGUE_ID, tradeId))?.trade.status;

describe('trade response task', () => {
  it('shapes the bar by archetype and counts its own counters in the chain', () => {
    expect(acceptBar(0.9)).toBe(-4);
    expect(acceptBar(0.4)).toBe(1);
    // The bar is the archetype's trade appetite from the core catalog.
    for (const a of ARCHETYPES) {
      const config = resolveAgentConfig({ personalityId: 'stats-nerd', difficulty: 'pro', archetype: a });
      expect(acceptBar(config.tradeFrequency)).toBe(tradeAppetite(config).acceptEdge);
    }
    expect([0, 1, 2, 3, 4].map(countersUsed)).toEqual([0, 0, 1, 1, 2]);
  });

  it('accepts an offer the trade value math likes (fake model default)', async () => {
    const s = await tradeLeague(PRO);
    const offer = await allen(s, 'propose_trade', {
      withTeamId: AGENT_TEAM,
      send: ['rb3'],
      receive: ['rb4']
    });
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), request(offer.id, 'e1'));
    expect(record).toMatchObject({ status: 'completed', finalAction: 'accept_trade' });
    expect(model.transcript[0]?.systemPrompt).toContain('Suggested: accept');
    expect(await status(s, offer.id)).toBe('in_review');
  });

  it('counters a weak offer, and the chain ends when the person accepts the counter', async () => {
    const s = await tradeLeague(PRO);
    const offer = await allen(s, 'propose_trade', { withTeamId: AGENT_TEAM, receive: ['rb4', 'wr4'] });
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), request(offer.id, 'e2'));
    expect(record).toMatchObject({ finalAction: 'counter_trade' });
    expect(await status(s, offer.id)).toBe('countered');
    const counter = (await s.repos.trades.list(LEAGUE_ID)).find((t) => t.trade.counterOf === offer.id);
    expect(counter?.trade.sides[0]).toMatchObject({ teamId: AGENT_TEAM, sends: ['wr4'] });
    const accepted = await allen(s, 'respond_to_trade', {
      tradeId: counter?.trade.tradeId,
      response: 'accept'
    });
    expect(accepted.status).toBe('in_review');
  });

  it('stops countering at the difficulty’s round limit and rejects', async () => {
    const s = await tradeLeague(ROOKIE);
    const offer = await allen(s, 'propose_trade', { withTeamId: AGENT_TEAM, receive: ['rb4', 'wr4'] });
    await runAgentAction(s.deps(new ScriptedModelClient()), request(offer.id, 'e3'));
    const counter = (await s.repos.trades.list(LEAGUE_ID)).find((t) => t.trade.counterOf === offer.id);
    if (counter === undefined) throw new Error('no counter');
    const again = await allen(s, 'counter_trade', {
      tradeId: counter.trade.tradeId,
      receive: ['rb4', 'wr4']
    });
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), request(again.id, 'e4'));
    expect(model.transcript[0]?.systemPrompt).toContain('You have 0 counter-offer(s) left');
    expect(record).toMatchObject({ finalAction: 'reject_trade' });
    expect(await status(s, again.id)).toBe('rejected');

    // A model that insists on countering with no rounds left still rejects.
    const third = await allen(s, 'propose_trade', { withTeamId: AGENT_TEAM, receive: ['rb4', 'wr4'] });
    await runAgentAction(s.deps(new ScriptedModelClient()), request(third.id, 'e5'));
    const c2 = (await s.repos.trades.list(LEAGUE_ID)).find((t) => t.trade.counterOf === third.id);
    const back = await allen(s, 'counter_trade', { tradeId: c2?.trade.tradeId, receive: ['rb4', 'wr4'] });
    const stubborn = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'Counter!', action: 'counter', send: ['wr4'] } })
    });
    expect(await runAgentAction(s.deps(stubborn), request(back.id, 'e6'))).toMatchObject({
      finalAction: 'reject_trade'
    });
  });

  it('rejects without a model, and does nothing for an offer that is no longer open', async () => {
    const s = await tradeLeague(PRO);
    const offer = await allen(s, 'propose_trade', {
      withTeamId: AGENT_TEAM,
      send: ['rb3'],
      receive: ['rb4']
    });
    const failing = new ScriptedModelClient({ fail: () => new Error('bedrock is down') });
    expect(await runAgentAction(s.deps(failing), request(offer.id, 'e7'))).toMatchObject({
      finalAction: 'reject_trade'
    });
    expect(await status(s, offer.id)).toBe('rejected');
    expect(await runAgentAction(s.deps(new ScriptedModelClient()), request(offer.id, 'e8'))).toMatchObject({
      finalAction: 'none'
    });
  });

  it('counters for their player, suggests drops, and rejects an offer that stopped being legal', async () => {
    const s = await tradeLeague(PRO);
    await s.repos.players.putMany(
      ['xdef', 'xk'].map((id) => ({
        id,
        name: id.toUpperCase(),
        firstName: 'X',
        lastName: id,
        team: 'SF',
        position: id === 'xk' ? ('K' as const) : ('DEF' as const),
        status: 'active' as const,
        injuryStatus: null,
        aliases: [],
        rank: null,
        updatedAt: START
      }))
    );
    const team = await s.repos.teams.get(LEAGUE_ID, 'team-1');
    if (team === null) throw new Error('team-1');
    await s.repos.teams.update({ ...team, roster: [...team.roster, 'xdef', 'xk'] });
    const weak = await allen(s, 'propose_trade', {
      withTeamId: AGENT_TEAM,
      send: ['xdef'],
      receive: ['rb4', 'wr4']
    });
    const model = new ScriptedModelClient();
    await runAgentAction(s.deps(model), request(weak.id, 'e9'));
    expect(model.transcript[0]?.systemPrompt).toMatch(/Suggested: counter \(send (rb4|wr4); receive xdef\)/);

    const big = await allen(s, 'propose_trade', { withTeamId: AGENT_TEAM, send: ['rb3', 'xdef', 'xk'] });
    const drops = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(drops), request(big.id, 'e10'));
    expect(drops.transcript[0]?.systemPrompt).toContain('Accepting needs drops; suggested:');
    expect(record).toMatchObject({ finalAction: 'accept_trade' });

    const stale = await allen(s, 'propose_trade', {
      withTeamId: AGENT_TEAM,
      send: ['xdef'],
      receive: ['k1']
    });
    const team1 = await s.repos.teams.get(LEAGUE_ID, 'team-1');
    if (team1 === null) throw new Error('team-1');
    await s.repos.teams.update({ ...team1, roster: team1.roster.filter((id) => id !== 'xdef') });
    const staleModel = new ScriptedModelClient();
    expect(await runAgentAction(s.deps(staleModel), request(stale.id, 'e11'))).toMatchObject({
      finalAction: 'reject_trade'
    });
    expect(staleModel.transcript[0]?.systemPrompt).toContain('It is not legal right now');
  });

  it('is triggered for the team an offer is made to', async () => {
    const s = await tradeLeague(PRO);
    const decisions = await routeEvent(
      { services: s.services, kinds: defaultTaskKinds },
      {
        id: 'evt-t',
        'detail-type': 'Trade Proposed',
        source: 'fantasy',
        detail: { leagueId: LEAGUE_ID, tradeId: 't1', fromTeamId: 'team-1', toTeamId: AGENT_TEAM }
      }
    );
    expect(decisions).toMatchObject([{ teamId: AGENT_TEAM, decision: 'requested', kind: 'trade_response' }]);
  });
});
