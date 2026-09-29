import { FixedClock, resolveAgentConfig, type AgentSeatConfig } from '@fantasy/core';
import {
  agentPrincipal,
  createContext,
  executeOperation,
  invokeTool,
  type UserPrincipal
} from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { TaskUnavailableError } from '../src/tasks/lineup.js';
import type { TaskContext } from '../src/tasks/kinds.js';
import { SEALED_PROPOSAL, swapIdeas, tradeProposalTask } from '../src/tasks/trade-proposal.js';
import { SEALED_VOTE, tradeVoteTask } from '../src/tasks/trade-vote.js';
import { AGENT_TEAM, LEAGUE_ID, START, roster, setup, type Setup } from './support.js';

/**
 * Agents on their own in the trade market (issues #66, #122): proposing trades each week, and
 * voting on other teams' trades under league review. Fake-model tests through the real operations.
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const ALLEN: UserPrincipal = { type: 'user', sub: 'user-123', email: null, name: 'Allen' };
const HAPPY = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'trade_happy' } as const;
const CAUTIOUS = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'analytics_only' } as const;
const X_PLAYERS = ['xqb', 'xrb1', 'xrb2', 'xwr1', 'xwr2', 'xwr3', 'xwr4', 'xte', 'xk', 'xdef'];

let keys = 0;
async function op(s: Setup, name: string, input: Record<string, unknown>, principal = ALLEN) {
  const operation = s.registry.get(name);
  if (operation === undefined) throw new Error(name);
  const res = await executeOperation({
    registry: s.registry,
    operation,
    ctx: createContext(s.services, principal),
    input: { leagueId: LEAGUE_ID, ...input },
    idempotencyKey: operation.mutation ? `trade-agents-${++keys}-key` : null
  });
  const body = res.body as { data?: Record<string, unknown>; error?: unknown };
  if (body.data === undefined) throw new Error(JSON.stringify(body));
  return body.data;
}

/**
 * team-2 (the agent) has the support roster without rb3: qb1 (20 projected points) sits on its
 * bench behind qb2. team-3 has rb3 (30 points) on its bench and a replacement-level roster
 * otherwise. A qb1-for-rb3 swap helps both.
 */
async function market(config: AgentSeatConfig = HAPPY): Promise<Setup> {
  const s = await setup();
  await s.seat(AGENT_TEAM, config);
  await s.repos.players.putMany(
    X_PLAYERS.map((id) => ({
      id,
      name: id.toUpperCase(),
      firstName: 'X',
      lastName: id,
      team: 'SF',
      position: (id.startsWith('xqb')
        ? 'QB'
        : id.startsWith('xrb')
          ? 'RB'
          : id.startsWith('xwr')
            ? 'WR'
            : id === 'xte'
              ? 'TE'
              : id === 'xk'
                ? 'K'
                : 'DEF') as 'QB',
      status: 'active' as const,
      injuryStatus: null,
      aliases: [],
      rank: null,
      updatedAt: START
    }))
  );
  const rosters: Record<string, string[]> = {
    'team-1': [],
    [AGENT_TEAM]: roster()
      .map((r) => r.playerId)
      .filter((id) => id !== 'rb3'),
    'team-3': ['rb3', ...X_PLAYERS],
    'team-4': []
  };
  for (const [teamId, ids] of Object.entries(rosters)) {
    const team = await s.repos.teams.get(LEAGUE_ID, teamId);
    await s.repos.teams.update({ ...team!, roster: ids });
  }
  const line = (playerId: string, stats: Record<string, number>) => ({
    playerId,
    season: 2026,
    week: 5,
    stats
  });
  const lines = [
    line('qb1', { pass_yd: 750 }),
    line('qb2', { pass_yd: 625 }),
    line('xqb', { pass_yd: 500 }),
    line('rb1', { rush_yd: 200 }),
    line('rb2', { rush_yd: 150 }),
    line('rb3', { rush_yd: 300 }),
    ...['wr1', 'wr2', 'wr3', 'wr4'].map((id) => line(id, { rec_yd: 200 })),
    ...['xrb1', 'xrb2'].map((id) => line(id, { rush_yd: 290 })),
    ...['xwr1', 'xwr2', 'xwr3', 'xwr4'].map((id) => line(id, { rec_yd: 300 }))
  ];
  await s.services.data.reference.projections.putSnapshot(
    { season: 2026, week: 5, capturedAt: '2026-10-02T12:00:00.000Z', hash: 'market', count: lines.length },
    lines
  );
  return s;
}

function proposalRequest(eventId: string): AgentActionRequested {
  return {
    taskId: `trade_proposal.${eventId}`,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind: 'trade_proposal',
    trigger: { detailType: 'Week Rolled Over', eventId, urgent: false },
    payload: { week: 5 },
    requestedAt: START
  };
}

const proposed = async (s: Setup) =>
  (await s.repos.trades.list(LEAGUE_ID)).filter((t) => t.trade.sides[0].teamId === AGENT_TEAM);

describe('trade proposal task', () => {
  it('finds a swap that helps its roster and offers it (fake model default)', async () => {
    const s = await market();
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), proposalRequest('p1'));
    expect(record).toMatchObject({ status: 'completed', finalAction: 'propose_trade' });
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain('You may send up to 3 offer(s) this week, one per team.');
    expect(prompt).toMatch(
      /1\. To Team 3: your QB1 \(QB\) for their RB3 \(RB\)\. Value for you [\d.]+, for them [\d.-]+\./
    );
    const [offer] = await proposed(s);
    expect(offer?.trade).toMatchObject({
      status: 'proposed',
      sides: [
        { teamId: AGENT_TEAM, sends: ['qb1'] },
        { teamId: 'team-3', sends: ['rb3'] }
      ]
    });
    // Sealed in the activity log; remembered with the players and the value.
    expect(record.sealed).toEqual({
      summary: SEALED_PROPOSAL,
      trades: [{ tradeId: offer?.trade.tradeId, until: 'public' }],
      waiverClaims: []
    });
    const memory = await s.repos.agents.getMemory(LEAGUE_ID, AGENT_ID);
    expect(memory.trades).toEqual([
      expect.objectContaining({ outcome: 'proposed', sent: ['QB1'], received: ['RB3'], teamId: 'team-3' })
    ]);
    expect(memory.decisions.at(-1)?.summary).toMatch(
      /^Offered QB1 to team-3 for RB3 \(value for you [\d.]+\)\.$/
    );

    // A team with an offer pending from this agent gets no second one.
    const again = await runAgentAction(s.deps(new ScriptedModelClient()), proposalRequest('p2'));
    expect(again).toMatchObject({ status: 'skipped', fallbackReason: 'no_trade_found' });
  });

  it('sends at most one offer on the early look right after the draft', async () => {
    const s = await market();
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), {
      ...proposalRequest('early'),
      trigger: { detailType: 'Draft Completed', eventId: 'early', urgent: true },
      payload: { reason: 'draft_complete', week: 5 }
    });
    expect(record).toMatchObject({ status: 'completed', finalAction: 'propose_trade' });
    expect(model.transcript[0]?.systemPrompt).toContain(
      'The draft just ended and you like to deal: take an early look for a trade. You may send up to 1 offer(s) now.'
    );
    expect(await proposed(s)).toHaveLength(1);
  });

  it('proposes only vetted candidates, at most the action budget, and nothing when the model passes', async () => {
    const s = await market({ ...HAPPY, advanced: { levers: { actionsPerTrigger: 1 } } });
    const picky = new ScriptedModelClient({
      script: () => ({
        steps: [],
        decision: {
          summary: 'Numbers 9, 1, and 1 again.',
          offers: [{ candidate: 9 }, { candidate: 1, message: 'Your QB room needs help.' }, { candidate: 1 }]
        }
      })
    });
    const record = await runAgentAction(s.deps(picky), proposalRequest('p3'));
    expect(record.finalAction).toBe('propose_trade');
    expect(await proposed(s)).toHaveLength(1);
    expect((await proposed(s))[0]?.message).toBe('Your QB room needs help.');

    const quiet = await market();
    const pass = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'Standing pat.', offers: [] } })
    });
    expect(await runAgentAction(quiet.deps(pass), proposalRequest('p4'))).toMatchObject({
      status: 'completed',
      finalAction: 'none'
    });
    expect(await proposed(quiet)).toEqual([]);
    expect((await quiet.repos.agents.getMemory(LEAGUE_ID, AGENT_ID)).decisions).toEqual([]);
  });

  it('pitches a person by DM with its offer note (pro and up), but never an agent or a quiet offer', async () => {
    const note = 'Your RB3 rides your bench; my QB1 would start for you.';
    const withNote = () =>
      new ScriptedModelClient({
        script: () => ({
          steps: [],
          decision: { summary: 'Offer.', offers: [{ candidate: 1, message: note }] }
        })
      });
    const toPerson = async (config: AgentSeatConfig = HAPPY) => {
      const s = await market(config);
      const team3 = await s.repos.teams.get(LEAGUE_ID, 'team-3');
      await s.repos.teams.update({
        ...team3!,
        seatType: 'human',
        ownerUserId: 'user-777',
        ownerName: 'Tara'
      });
      return s;
    };
    const dm = async (s: Setup) =>
      (await s.repos.chat.list(LEAGUE_ID, 'dm-team-2-team-3', { limit: 5 })).messages.map((m) => [
        m.kind,
        m.text
      ]);

    const s = await toPerson();
    const record = await runAgentAction(s.deps(withNote()), proposalRequest('pitch1'));
    expect(record.toolsCalled.filter((c) => c.mutation).map((c) => c.name)).toEqual([
      'propose_trade',
      'post_message'
    ]);
    expect(await dm(s)).toEqual([['agent', `I just sent you a trade offer: my QB1 for your RB3. ${note}`]]);
    // The DM names the offer, so the activity log stays sealed as for any offer.
    expect(record.sealed?.summary).toBe(SEALED_PROPOSAL);

    // A rookie does not pitch; nor does anyone to an agent team, or with no note.
    const rookie = await toPerson({ ...HAPPY, difficulty: 'rookie' });
    await runAgentAction(rookie.deps(withNote()), proposalRequest('pitch2'));
    expect(await proposed(rookie)).toHaveLength(1);
    expect(await dm(rookie)).toEqual([]);
    const agentPartner = await market();
    await runAgentAction(agentPartner.deps(withNote()), proposalRequest('pitch3'));
    expect(await dm(agentPartner)).toEqual([]);
    const silent = await toPerson();
    await runAgentAction(silent.deps(new ScriptedModelClient()), proposalRequest('pitch4'));
    expect(await proposed(silent)).toHaveLength(1);
    expect(await dm(silent)).toEqual([]);
  });

  it('proposes nothing without a model, and records an offer the league refuses', async () => {
    const s = await market();
    const down = new ScriptedModelClient({ fail: () => new Error('bedrock is down') });
    expect(await runAgentAction(s.deps(down), proposalRequest('p5'))).toMatchObject({
      status: 'fallback',
      finalAction: 'none'
    });
    expect(await proposed(s)).toEqual([]);

    // The players' game kicks off while the model thinks: the offer is refused (PLAYER_LOCKED).
    const late = new ScriptedModelClient({
      script: (req) => {
        s.clock.set('2026-10-04T21:00:00.000Z');
        return req.fakeScript?.();
      }
    });
    const record = await runAgentAction(s.deps(late), proposalRequest('p6'));
    expect(record).toMatchObject({ finalAction: 'propose_trade_failed' });
    expect(record.reasoningSummary).toMatch(/Refused: team-3 \(PLAYER_LOCKED\)\.$/);
    expect(record.sealed).toBeUndefined();
  });

  it('stays out of the market after the deadline, and without a trade appetite', async () => {
    const s = await market();
    const league = await s.repos.leagues.get(LEAGUE_ID);
    await s.repos.leagues.update({ ...league!, week: league!.settings.trades.deadlineWeek + 1 });
    expect(await runAgentAction(s.deps(new ScriptedModelClient()), proposalRequest('p7'))).toMatchObject({
      status: 'skipped',
      fallbackReason: 'trades_closed'
    });
    const config = { ...resolveAgentConfig(HAPPY), tradeFrequency: 0 };
    await expect(tradeProposalTask.prepare({ config } as TaskContext, {})).rejects.toThrow(
      new TaskUnavailableError('no_trade_appetite')
    );
  });

  it('pairs a bench surplus with a player who beats a weak starter, when both sides gain', () => {
    const p = (id: string, position: string, slot: string, points: number | null) => ({
      player: { id, name: id, position },
      slot,
      projectedPoints: points
    });
    const mine = [
      p('q1', 'QB', 'QB', 20),
      p('q2', 'QB', 'BN', 18),
      p('r1', 'RB', 'RB', 5),
      p('k', 'K', 'BN', 9)
    ];
    const theirs = [
      p('tq', 'QB', 'QB', 8),
      p('tr', 'RB', 'BN', 15),
      p('ts', 'RB', 'RB', 16),
      p('ir', 'RB', 'IR', 30),
      p('tk', 'K', 'K', 1)
    ];
    // q2 for their bench back beats q2 for their starting back (losing a starter costs them).
    expect(swapIdeas(mine, theirs).map((i) => [i.send.player.id, i.receive.player.id])).toEqual([
      ['q2', 'tr'],
      ['q2', 'ts']
    ]);
    expect(swapIdeas(mine, [p('tq', 'QB', 'QB', 30), p('none', 'RB', 'BN', null)])).toEqual([]);
  });

  it('is triggered once per league week by the rollover, for every agent team', async () => {
    const s = await market();
    await s.seat('team-3', CAUTIOUS);
    const rollover = (id: string, detail: Record<string, unknown>) =>
      routeEvent(
        { services: s.services, kinds: defaultTaskKinds },
        { id, 'detail-type': 'Week Rolled Over', source: 'fantasy', detail }
      );
    const league = {
      leagueId: LEAGUE_ID,
      season: 2026,
      fromWeek: 5,
      week: 6,
      phase: 'regular_season',
      rolledOverAt: START
    };
    const trades = async (id: string) =>
      (await rollover(id, league)).filter((d) => d.kind === 'trade_proposal');
    expect(await trades('r1')).toMatchObject([
      { teamId: AGENT_TEAM, decision: 'requested', kind: 'trade_proposal' },
      { teamId: 'team-3', decision: 'requested', kind: 'trade_proposal' }
    ]);
    expect((await trades('r2')).map((d) => d.decision)).toEqual(['repeat', 'repeat']);
    // The NFL-wide rollover names no league.
    expect(await rollover('r3', { season: 2026, seasonType: 'regular', week: 6, kind: 'week' })).toEqual([]);
  });
});

/**
 * Votes: Allen (team-1) trades with team-3 (an agent), which accepts; team-2 and team-4 are agent
 * teams outside the trade. Only rb3 projects (30 points a week).
 */
async function voteLeague(): Promise<Setup> {
  const s = await setup();
  for (const teamId of [AGENT_TEAM, 'team-3', 'team-4']) await s.seat(teamId, CAUTIOUS);
  const rosters: Record<string, string[]> = {
    [AGENT_TEAM]: roster()
      .map((r) => r.playerId)
      .filter((id) => !['rb3', 'rb4', 'wr4', 'wr5'].includes(id)),
    'team-1': ['rb3', 'wr5'],
    'team-3': ['rb4', 'wr4'],
    'team-4': []
  };
  for (const [teamId, ids] of Object.entries(rosters)) {
    const team = await s.repos.teams.get(LEAGUE_ID, teamId);
    await s.repos.teams.update({ ...team!, roster: ids });
  }
  return s;
}

async function acceptedTrade(s: Setup, send: string, receive: string): Promise<string> {
  const { trade } = (await op(s, 'propose_trade', {
    withTeamId: 'team-3',
    send: [send],
    receive: [receive]
  })) as { trade: { id: string } };
  await invokeTool({
    registry: s.registry,
    services: s.services,
    principal: agentPrincipal({ agentId: `${LEAGUE_ID}.team-3`, teamId: 'team-3', leagueId: LEAGUE_ID }),
    name: 'respond_to_trade',
    args: { leagueId: LEAGUE_ID, tradeId: trade.id, response: 'accept', idempotencyKey: `accept-${trade.id}` }
  });
  return trade.id;
}

function voteRequest(tradeId: string, eventId: string): AgentActionRequested {
  return {
    taskId: `trade_vote.${eventId}`,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind: 'trade_vote',
    trigger: { detailType: 'Trade Accepted', eventId, urgent: true },
    payload: { tradeId },
    requestedAt: START
  };
}

describe('trade vote task', () => {
  it('vetoes a lopsided trade under league review; the model explains but cannot flip it', async () => {
    const s = await voteLeague();
    const tradeId = await acceptedTrade(s, 'rb3', 'rb4');
    expect((await s.repos.trades.get(LEAGUE_ID, tradeId))?.trade.status).toBe('in_review');
    const lenient = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'Looks fine to me, let it through!' } })
    });
    const record = await runAgentAction(s.deps(lenient), voteRequest(tradeId, 'v1'));
    expect(record).toMatchObject({ status: 'completed', finalAction: 'veto_trade' });
    expect(lenient.transcript[0]?.systemPrompt).toContain('You are voting to veto it; that is decided');
    expect(lenient.transcript[0]?.toolNames).not.toContain('vote_trade');
    expect((await s.repos.trades.get(LEAGUE_ID, tradeId))?.trade.vetoVotes).toEqual([AGENT_TEAM]);
    expect(record.sealed).toEqual({
      summary: SEALED_VOTE,
      trades: [{ tradeId, until: 'final' }],
      waiverClaims: []
    });

    // Without a model it still vetoes; once it has voted there is nothing left to do.
    const s2 = await voteLeague();
    const again = await acceptedTrade(s2, 'rb3', 'rb4');
    const down = new ScriptedModelClient({ fail: () => new Error('down') });
    expect(await runAgentAction(s2.deps(down), voteRequest(again, 'v2'))).toMatchObject({
      status: 'fallback',
      finalAction: 'veto_trade'
    });
    expect(await runAgentAction(s2.deps(down), voteRequest(again, 'v3'))).toMatchObject({
      status: 'skipped',
      fallbackReason: 'no_vote'
    });
  });

  it('lets a fair trade pass without a model call, sealed like a veto until the review ends', async () => {
    const s = await voteLeague();
    const tradeId = await acceptedTrade(s, 'wr5', 'wr4');
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), voteRequest(tradeId, 'v4'));
    expect(record).toMatchObject({ status: 'skipped', fallbackReason: 'vote_pass' });
    expect(model.transcript).toHaveLength(0);
    expect(record.sealed?.summary).toBe(SEALED_VOTE);
    const { tasks } = (await op(s, 'get_agent_activity', {})) as {
      tasks: { status: string; finalAction: string; redacted: boolean }[];
    };
    expect(tasks[0]).toMatchObject({ status: 'completed', finalAction: 'sealed', redacted: true });
    // An unknown trade has nothing to vote on.
    expect(await runAgentAction(s.deps(model), voteRequest('nope', 'v5'))).toMatchObject({
      fallbackReason: 'no_vote'
    });
  });

  it('is triggered for agent teams outside an accepted trade in a league-vote league', async () => {
    const s = await voteLeague();
    let n = 0;
    const accepted = (detail: Record<string, unknown>) =>
      routeEvent(
        { services: s.services, kinds: defaultTaskKinds },
        {
          id: `acc-${++n}`,
          'detail-type': 'Trade Accepted',
          source: 'fantasy',
          detail: { leagueId: LEAGUE_ID, tradeId: 't1', teamIds: ['team-1', 'team-3'], ...detail }
        }
      );
    expect(await accepted({ review: 'league_vote', status: 'in_review' })).toMatchObject([
      { teamId: AGENT_TEAM, kind: 'trade_vote', decision: 'requested' },
      { teamId: 'team-4', kind: 'trade_vote', decision: 'requested' }
    ]);
    expect(await accepted({ review: 'commissioner', status: 'in_review' })).toEqual([]);
    expect(await accepted({ review: 'league_vote', status: 'processed' })).toEqual([]);
  });
});

/** A task context whose tools answer from a script (tool name -> data, or an error code). */
function scripted(answers: Record<string, unknown>, config: AgentSeatConfig = HAPPY): TaskContext {
  const calls: string[] = [];
  return {
    taskId: 'scripted',
    config: resolveAgentConfig(config),
    clock: new FixedClock(START),
    calls,
    tools: {
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${JSON.stringify(args)}`);
        const answer = answers[name];
        if (typeof answer === 'function') return (answer as (a: unknown) => unknown)(args);
        if (typeof answer === 'string') return { error: { code: answer, message: answer, fix: 'x' } };
        return { data: answer, league: null, warnings: [] };
      }
    }
  } as unknown as TaskContext;
}

const ref = (id: string, name = id.toUpperCase()) => ({ id, name });
const listed = (yourActions: string[]) => ({
  trades: [
    {
      id: 't9',
      fromTeam: ref('team-1', 'Allen'),
      toTeam: ref('team-3', 'Bots'),
      fromSends: [ref('rb3')],
      toSends: [],
      yourActions
    }
  ]
});

describe('trade vote task with scripted tools', () => {
  it('names the side the math favors, and records a refused vote', async () => {
    const lopsided = (favors: string | null) => ({
      fairness: { favors, lineupGap: 90, valueGap: 0, lopsided: true }
    });
    for (const [favors, name] of [
      ['team-1', 'Allen'],
      ['team-3', 'Bots'],
      [null, 'neither side']
    ] as const) {
      const ctx = scripted({
        list_trades: listed(['vote']),
        preview_trade: lopsided(favors),
        vote_trade: 'VOTE_NOT_ALLOWED'
      });
      const task = await tradeVoteTask.prepare(ctx, { tradeId: 't9' });
      expect(task.instructions).toContain(`it favors ${name} and is lopsided.`);
      expect(task.instructions).toContain('RB3 for nothing');
      expect(task.fakeScript?.().decision).toEqual({
        summary: 'Too one-sided for this league (severity 3, my line 0.97).'
      });
      expect(await task.fallback()).toMatchObject({
        action: 'veto_trade_failed',
        summary:
          'Vetoed: the trade value math calls it too one-sided (severity 3). Refused: VOTE_NOT_ALLOWED.'
      });
    }
    await expect(
      tradeVoteTask.prepare(scripted({ list_trades: listed(['vote']), preview_trade: 'TRADE_NOT_FOUND' }), {
        tradeId: 't9'
      })
    ).rejects.toThrow('preview_failed:TRADE_NOT_FOUND');
    await expect(
      tradeVoteTask.prepare(scripted({ list_trades: 'LEAGUE_NOT_FOUND' }), { tradeId: 't9' })
    ).rejects.toThrow('no_vote');
  });
});

describe('trade proposal task with scripted tools', () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    week: 5,
    allowedActions: ['propose_trade'],
    yourTeam: { id: 'me' },
    teams: [ref('me'), ref('a', 'Alpha'), ref('b', 'Beta')],
    ...overrides
  });
  const entry = (id: string, position: string, slot: string, projectedPoints: number | null) => ({
    player: { id, name: id.toUpperCase(), position },
    slot,
    projectedPoints
  });
  const rosters: Record<string, unknown> = {
    me: { players: [entry('mq', 'QB', 'QB', 20), entry('mq2', 'QB', 'BN', 18), entry('mr', 'RB', 'RB', 5)] },
    a: { players: [entry('aq', 'QB', 'QB', 8), entry('ar', 'RB', 'BN', 15), entry('ar2', 'RB', 'BN', 14)] },
    b: { players: [entry('bq', 'QB', 'QB', 9), entry('br', 'RB', 'BN', 12)] }
  };
  const side = (lineupDelta: number, valueDelta = 0) => ({ lineupDelta, valueDelta });
  const preview = (mine: number, theirs: number, extra: Record<string, unknown> = {}) => ({
    valid: true,
    sides: [side(mine), side(theirs)],
    fairness: { lopsided: false },
    ...extra
  });

  it('vets every idea with the value math, keeps the best offer per team, and skips the rest', async () => {
    const previews: Record<string, unknown> = {
      'a:ar': preview(10, 5),
      'a:ar2': preview(12, 5),
      'b:br': preview(0.5, 5)
    };
    const ctx = scripted({
      get_league_state: state({ week: null }),
      list_trades: 'LEAGUE_NOT_FOUND',
      get_roster: (args: { teamId: string }) => ({ data: rosters[args.teamId], league: null, warnings: [] }),
      preview_trade: (args: { withTeamId: string; receive: string[] }) => ({
        data: previews[`${args.withTeamId}:${args.receive[0]}`],
        league: null,
        warnings: []
      })
    });
    const task = await tradeProposalTask.prepare(ctx, {});
    // Alpha's two backs are both worth offering for; only the better one stays. Beta's gains too little.
    expect(task.instructions).toMatch(
      /1\. To Alpha: your MQ2 \(QB\) for their AR2 \(RB\)\. Value for you 1[0-9.]+, for them 5\./
    );
    expect(task.instructions).not.toContain('Beta');
    expect((ctx as unknown as { calls: string[] }).calls.filter((c) => c.startsWith('get_roster'))).toEqual([
      'get_roster:{"teamId":"me"}',
      'get_roster:{"teamId":"a"}',
      'get_roster:{"teamId":"b"}'
    ]);

    // Illegal, lopsided, insulting, or unreadable previews are never offered.
    for (const bad of [
      preview(10, 5, { valid: false }),
      preview(10, 5, { fairness: { lopsided: true } }),
      preview(10, -20),
      undefined
    ]) {
      const none = scripted({
        get_league_state: state(),
        list_trades: { trades: [] },
        get_roster: (args: { teamId: string }) => ({
          data: rosters[args.teamId],
          league: null,
          warnings: []
        }),
        preview_trade: bad === undefined ? 'TRADE_INVALID' : bad
      });
      await expect(tradeProposalTask.prepare(none, {})).rejects.toThrow('no_trade_found');
    }
  });

  it('stays out when it cannot read the league or has no team', async () => {
    for (const s of ['LEAGUE_NOT_FOUND', state({ yourTeam: null }), state({ allowedActions: [] })]) {
      await expect(tradeProposalTask.prepare(scripted({ get_league_state: s }), {})).rejects.toThrow(
        'trades_closed'
      );
    }
    // A roster it cannot read has nothing to offer.
    const blind = scripted({
      get_league_state: state(),
      list_trades: { trades: [] },
      get_roster: 'FORBIDDEN'
    });
    await expect(tradeProposalTask.prepare(blind, {})).rejects.toThrow('no_trade_found');
  });
});
