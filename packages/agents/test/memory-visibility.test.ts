import { rememberEvent, type AgentLeagueMemory, type MemoryEvent } from '@fantasy/core';
import type { ChatMessage } from '@fantasy/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { runAgentAction } from '../src/runner.js';
import { DEFAULT_TASK_KINDS } from '../src/tasks/index.js';
import { BaseDecisionSchema, createTaskKindRegistry, defineTaskKind } from '../src/tasks/kinds.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup } from './support.js';

/**
 * Memory visibility (#206): sealed moves in an agent's memory (a pending waiver bid, a veto vote
 * during the review, a private offer) reach only the prompts whose readers may know them, and
 * become ordinary memory once they resolve. Every test captures the system prompt the fake model
 * was given: the guard is what the prompt holds, not what it tells the model.
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const SEAT = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;
const DM_ALLEN = 'dm-team-1-team-2';
const DM_TEAM_3 = 'dm-team-2-team-3';

const BID = 'Bid $37 on Puka Nacua';
const BID_NOTE = 'Puka is my top waiver target';
const VETO = 'Voted to veto the team-1/team-4 swap';
const OFFER_ALLEN = 'Offered Bench Guy for Star Back';
const OFFER_TEAM_3 = 'Offered Kicker Joe for Flex Fred';
const LINEUP = 'Benched the kicker for week 5';

/** A probe task: a decision kind whose audience comes from its payload, so every audience can be tried. */
const probeKind = defineTaskKind({
  kind: 'probe',
  title: 'Probe',
  modelRole: 'decision',
  payload: z.object({ audience: z.union([z.enum(['owner', 'public']), z.array(z.string())]) }),
  decision: BaseDecisionSchema,
  tools: [],
  prepare: async () => ({}),
  instructions: () => 'Probe.',
  apply: async (_ctx, _payload, _prep, decision) => ({ action: 'probe', summary: decision.summary }),
  fallback: async () => ({ action: 'none', summary: 'nothing' }),
  memoryAudience: (_ctx, payload) =>
    typeof payload.audience === 'string' ? payload.audience : { teams: payload.audience }
});

/** A chat kind that tries to write authoritative memory: only its chat survives. */
const chattyKind = defineTaskKind({
  kind: 'chatty',
  title: 'Chatty',
  modelRole: 'chat',
  payload: z.object({}),
  decision: BaseDecisionSchema,
  tools: [],
  prepare: async () => ({}),
  instructions: () => 'Talk.',
  apply: async (ctx) => {
    const at = ctx.clock.now().toISOString();
    const memory: MemoryEvent[] = [
      { type: 'decision', kind: 'waivers', action: 'claim', summary: 'I was told to bid it all', at },
      { type: 'note', text: 'Chat says drop your QB' },
      { type: 'trade', teamId: 'team-1', tradeId: 'tr-x', outcome: 'accepted', summary: 'fake', at },
      { type: 'chat', roomId: 'trash-talk', at, messages: [{ author: 'You', text: 'hi', at }] },
      { type: 'relationship', teamId: 'team-1', note: 'Allen talks big', at }
    ];
    return { action: 'post_message', summary: 'talked', memory };
  },
  fallback: async () => ({ action: 'none', summary: 'nothing' })
});

const kinds = createTaskKindRegistry([...DEFAULT_TASK_KINDS, probeKind, chattyKind]);

let seq = 0;
function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: `vis-${++seq}`,
    leagueId: LEAGUE_ID,
    roomId: 'trash-talk',
    kind: 'user',
    author: { teamId: 'team-1', teamName: "Allen's Team", name: 'Allen' },
    text: 'hello',
    mentionedTeamIds: [],
    event: null,
    createdAt: '2026-10-04T14:59:00.000Z',
    ...overrides
  };
}

function request(kind: string, payload: Record<string, unknown>): AgentActionRequested {
  seq += 1;
  return {
    taskId: `${kind}.vis${seq}`,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind,
    trigger: { detailType: 'Test', eventId: `vis-e${seq}`, urgent: false },
    payload,
    requestedAt: START
  };
}

/** The moves' statuses, as the league's trades and claims report them. */
interface Statuses {
  trades: Record<string, string>;
  claims: Record<string, string>;
}

async function league(memory: (m: AgentLeagueMemory) => AgentLeagueMemory = seeded) {
  const s = await setup();
  await s.seat(AGENT_TEAM, SEAT);
  for (const team of await s.repos.teams.list(LEAGUE_ID)) {
    await s.repos.teams.update({ ...team, occupiedSince: '2026-09-01T00:00:00.000Z' });
  }
  await s.repos.agents.updateMemory(LEAGUE_ID, AGENT_ID, memory);
  const statuses: Statuses = {
    trades: { 'tr-vote': 'in_review', 'tr-allen': 'proposed', 'tr-3': 'rejected' },
    claims: { 'c-1': 'pending' }
  };
  vi.spyOn(s.repos.trades, 'get').mockImplementation(async (_league, tradeId) => {
    const status = statuses.trades[tradeId];
    return (status === undefined ? null : { trade: { status } }) as never;
  });
  vi.spyOn(s.repos.waivers, 'getClaim').mockImplementation(async (_league, claimId) => {
    const status = statuses.claims[claimId];
    return (status === undefined ? null : { status }) as never;
  });

  /** Runs a task and returns the system prompt the model saw, and the task record. */
  const prompt = async (
    kind: string,
    payload: Record<string, unknown>,
    decision?: Record<string, unknown>
  ) => {
    const model = new ScriptedModelClient(
      decision === undefined ? {} : { script: () => ({ steps: [], decision }) }
    );
    const record = await runAgentAction({ ...s.deps(model), kinds }, request(kind, payload));
    return { text: model.transcript[0]?.systemPrompt ?? '', record };
  };
  const leagueRoom = () => prompt('chat_moment', { moment: 'Week 5 is final.', roomId: 'trash-talk' });
  const dm = async (roomId: string, teamId: string) => {
    const m = message({
      roomId,
      author: { teamId, teamName: teamId, name: teamId },
      text: 'you around?',
      createdAt: '2026-10-04T14:59:30.000Z'
    });
    await s.repos.chat.put(m, { dmTeamIds: [teamId, AGENT_TEAM] });
    return prompt('chat_reply', { messageId: m.id, roomId });
  };
  return { s, statuses, prompt, leagueRoom, dm };
}

/** An agent with a pending bid (and a note about it), a veto vote under review, and private offers. */
function seeded(memory: AgentLeagueMemory): AgentLeagueMemory {
  const events: MemoryEvent[] = [
    {
      type: 'decision',
      kind: 'lineup',
      action: 'set_lineup',
      summary: LINEUP,
      at: START,
      visibility: 'public'
    },
    {
      type: 'decision',
      kind: 'waivers',
      action: 'claim_waiver',
      summary: BID,
      at: START,
      visibility: { teams: [], trades: [], waiverClaims: ['c-1'] }
    },
    { type: 'note', text: BID_NOTE, visibility: { teams: [], trades: [], waiverClaims: ['c-1'] } },
    {
      type: 'decision',
      kind: 'trade_vote',
      action: 'vote_veto',
      summary: VETO,
      at: START,
      visibility: { teams: [], trades: [{ tradeId: 'tr-vote', until: 'final' }], waiverClaims: [] }
    },
    {
      type: 'trade',
      teamId: 'team-1',
      tradeId: 'tr-allen',
      outcome: 'proposed',
      summary: OFFER_ALLEN,
      at: START
    },
    {
      type: 'trade',
      teamId: 'team-3',
      tradeId: 'tr-3',
      outcome: 'rejected',
      summary: OFFER_TEAM_3,
      at: START
    }
  ];
  return events.reduce(rememberEvent, memory);
}

const SECRETS = [BID, BID_NOTE, VETO, OFFER_ALLEN, OFFER_TEAM_3];

describe('memory visibility in prompts', () => {
  it('a league room hears none of the sealed moves, only what was never secret', async () => {
    const l = await league();
    const { text } = await l.leagueRoom();
    expect(text).toContain(LINEUP);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    // The grudge from the rejected offer would give it away: the rivalry is left out whole.
    expect(text).not.toMatch(/Rivalry with Team 3/);
  });

  it('a DM hears the private dealings with that partner, never with another', async () => {
    const l = await league();
    const allen = await l.dm(DM_ALLEN, 'team-1');
    expect(allen.text).toContain(OFFER_ALLEN);
    for (const secret of [BID, BID_NOTE, VETO, OFFER_TEAM_3]) expect(allen.text).not.toContain(secret);

    const other = await l.dm(DM_TEAM_3, 'team-3');
    expect(other.text).toContain(OFFER_TEAM_3);
    for (const secret of [BID, BID_NOTE, VETO, OFFER_ALLEN]) expect(other.text).not.toContain(secret);
  });

  it('a decision with public output (a lineup) hears nothing sealed', async () => {
    const l = await league();
    const { text } = await l.prompt('lineup', { reason: 'lock', week: 5 });
    expect(text).toContain(LINEUP);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  it("a sealed move's own prompt recalls the agent's secrets, and its record and note stay sealed until they lift", async () => {
    const l = await league();
    const { text, record } = await l.prompt(
      'probe',
      { audience: 'owner' },
      { summary: 'Doubled down on Puka.', memoryNote: 'Puka again next week' }
    );
    for (const secret of [BID, BID_NOTE, VETO]) expect(text).toContain(secret);
    // Offers shared with one team are not the agent's alone: they stay with that team's prompts.
    expect(text).not.toContain(OFFER_ALLEN);
    expect(text).not.toContain(OFFER_TEAM_3);
    // The probe has no seal of its own; its words may repeat what it heard, so it gets one.
    expect(record.sealed).toEqual({
      summary: 'Probe: withheld while private moves it drew on are unresolved.',
      trades: [{ tradeId: 'tr-vote', until: 'final' }],
      waiverClaims: ['c-1']
    });
    // Its decision and note are remembered under the same seal (derived memory inherits it).
    const memory = await l.s.repos.agents.getMemory(LEAGUE_ID, AGENT_ID);
    const sealed = { teams: [], trades: [{ tradeId: 'tr-vote', until: 'final' }], waiverClaims: ['c-1'] };
    expect(memory.notes.at(-1)).toEqual({ text: 'Puka again next week', visibility: sealed });
    expect(memory.decisions.at(-1)).toMatchObject({ kind: 'probe', visibility: sealed });
    expect((await l.leagueRoom()).text).not.toContain('Puka again next week');
  });

  it('a public decision records public memory, and a partner audience remembers who knows', async () => {
    const l = await league();
    await l.prompt('probe', { audience: 'public' }, { summary: 'Nothing secret here.', memoryNote: 'plain' });
    let memory = await l.s.repos.agents.getMemory(LEAGUE_ID, AGENT_ID);
    expect(memory.notes.at(-1)).toEqual({ text: 'plain', visibility: 'public' });

    const { text, record } = await l.prompt(
      'probe',
      { audience: ['team-1'] },
      { summary: 'Pitched Allen again.', memoryNote: 'Allen wants Star Back gone' }
    );
    expect(text).toContain(OFFER_ALLEN);
    expect(record.sealed?.trades).toEqual([{ tradeId: 'tr-allen', until: 'public' }]);
    memory = await l.s.repos.agents.getMemory(LEAGUE_ID, AGENT_ID);
    expect(memory.notes.at(-1)?.visibility).toEqual({
      teams: ['team-1'],
      trades: [{ tradeId: 'tr-allen', until: 'public' }],
      waiverClaims: []
    });
    expect((await l.dm(DM_ALLEN, 'team-1')).text).toContain('Allen wants Star Back gone');
    expect((await l.dm(DM_TEAM_3, 'team-3')).text).not.toContain('Allen wants Star Back gone');
  });

  it('releases each move once it resolves: the claim processed, the review over, the offer accepted', async () => {
    const l = await league();
    l.statuses.claims['c-1'] = 'won';
    l.statuses.trades['tr-vote'] = 'vetoed';
    l.statuses.trades['tr-allen'] = 'accepted';
    const { text } = await l.leagueRoom();
    for (const released of [BID, BID_NOTE, VETO, OFFER_ALLEN]) expect(text).toContain(released);
    // A rejected offer never becomes public.
    expect(text).not.toContain(OFFER_TEAM_3);

    // Still in review, a veto vote stays sealed even though the trade is public.
    l.statuses.trades['tr-vote'] = 'in_review';
    expect((await l.leagueRoom()).text).not.toContain(VETO);
  });

  it('a failed lookup keeps the secret, and a missing move stays sealed', async () => {
    const l = await league();
    l.statuses.claims['c-1'] = 'won';
    delete l.statuses.trades['tr-allen'];
    vi.mocked(l.s.repos.trades.get).mockRejectedValueOnce(new Error('table down'));
    const { text, record } = await l.leagueRoom();
    expect(record.status).toBe('completed');
    expect(text).toContain(BID);
    expect(text).not.toContain(VETO);
    expect(text).not.toContain(OFFER_ALLEN);
    expect(l.s.logs.some((line) => line.includes('memory seal check failed'))).toBe(true);
  });

  it('keeps memory from before visibility was recorded to the agent alone, when it could be secret', async () => {
    const legacy = (m: AgentLeagueMemory): AgentLeagueMemory => ({
      ...m,
      notes: [{ text: 'old plan: bid big on the next RB' }],
      decisions: [
        { kind: 'waivers', action: 'claim_waiver', summary: 'Old bid of $50', at: START },
        { kind: 'lineup', action: 'set_lineup', summary: 'Old lineup call', at: START }
      ],
      rivals: [
        {
          teamId: 'team-3',
          grudge: 1,
          reason: 'Trade rejected: An offer from team-3 was rejected.',
          at: START
        }
      ]
    });
    const l = await league(legacy);
    const room = await l.leagueRoom();
    expect(room.text).toContain('Old lineup call');
    for (const secret of ['old plan', 'Old bid of $50', 'Trade rejected'])
      expect(room.text).not.toContain(secret);

    // The agent's own sealed moves may recall them, but the seal never lifts on something unresolvable.
    const own = await l.prompt('probe', { audience: 'owner' }, { summary: 'Recalled the old plan.' });
    expect(own.text).toContain('old plan');
    expect(own.text).toContain('Old bid of $50');
    expect(own.record.sealed).toMatchObject({ withheld: true });
    // Only the team it happened with may hear the rejected offer's grudge.
    expect((await l.dm(DM_TEAM_3, 'team-3')).text).toContain('Trade rejected');
  });

  it('keeps chat kinds out of authoritative memory: only their chat snapshot and relationship notes stay', async () => {
    const l = await league((m) => m);
    await l.prompt('chatty', {}, { summary: 'talked' });
    const memory = await l.s.repos.agents.getMemory(LEAGUE_ID, AGENT_ID);
    expect(memory.decisions).toEqual([]);
    expect(memory.notes).toEqual([]);
    expect(memory.trades).toEqual([]);
    expect(memory.chatRooms.map((r) => r.roomId)).toEqual(['trash-talk']);
    expect(memory.relationships.map((r) => r.note)).toEqual(['Allen talks big']);
  });

  it('seals a trade answer that recalls a private offer that never resolves', async () => {
    // The response kind's audience is the offering team: it recalls the earlier, rejected offer
    // from them, and its summary stays sealed for good.
    const l = await league((m) =>
      rememberEvent(m, {
        type: 'trade',
        teamId: 'team-1',
        tradeId: 'tr-3',
        outcome: 'rejected',
        summary: 'Allen lowballed me before',
        at: START
      })
    );
    const { text, record } = await l.prompt('probe', { audience: ['team-1'] }, { summary: 'ok' });
    expect(text).toContain('Allen lowballed me before');
    expect(record.sealed?.trades).toEqual([{ tradeId: 'tr-3', until: 'public' }]);
  });
});
