import {
  FixedClock,
  ambientTurn,
  emptyMemory,
  emptySocialActs,
  recordSocialAct,
  resolveAgentConfig,
  type SocialActBook,
  type SocialActEntry
} from '@fantasy/core';
import type { ChatMessage } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { commitmentAccess } from '../src/commitments.js';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient, type FakeScript } from '../src/fake-model.js';
import { runAgentAction } from '../src/runner.js';
import type { CheckInLook, Run } from '../src/tasks/check-in.js';
import { NO_SOCIAL } from '../src/tasks/check-in-social.js';
import type { TaskContext } from '../src/tasks/kinds.js';
import {
  actInstructions,
  fakeActAction,
  lookOpportunities,
  socialActStep
} from '../src/tasks/social-acts.js';
import type { ProposalPrep } from '../src/tasks/trade-proposal.js';
import { market } from './market.js';
import { AGENT_TEAM, LEAGUE_ID, START } from './support.js';

/**
 * A purposeful question (#218, `ask_relevant_question`): an agent short a starter asks a person
 * whose player would fill it, in their DM, once; the person's next message there is read as the
 * answer, advancing that exchange (a takeaway becomes the #215 commitment); a goal that closes
 * cancels a question still waiting, so it is never chased or read as answered.
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const DM = 'dm-team-1-team-2';
const TENURE = '2026-09-01T00:00:00.000Z';
const GOAL = 'repair_position:W5:RB';
const HYPE = resolveAgentConfig({ personalityId: 'hype-man', difficulty: 'pro', archetype: 'balanced' });

/** A board-turn seed that passes for the loud manager. */
function turn(): string {
  for (let i = 0; ; i++) if (ambientTurn(HYPE.personality.chattiness, `turn-${i}`)) return `turn-${i}`;
}

const TRADE = {
  limit: 1,
  bar: 2,
  candidates: [
    {
      team: { id: 'team-1', name: 'Big Tuna' },
      send: { id: 'wr5', name: 'WR5', position: 'WR' },
      receive: { id: 'xrb1', name: 'XRB1', position: 'RB' },
      score: 3,
      partnerScore: 1
    }
  ]
} as unknown as ProposalPrep;

/** A check-in's context whose tools and stores answer from a script. */
function checkInCtx(options: { history?: SocialActBook; goals?: 'active' | 'none' } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let book = options.history ?? emptySocialActs();
  const ctx = {
    taskId: 'check_in.1',
    principal: { teamId: AGENT_TEAM },
    config: HYPE,
    league: { id: LEAGUE_ID, week: 5 },
    clock: new FixedClock(START),
    log: { info: () => undefined, warn: () => undefined },
    trigger: { eventId: 'evt', detailType: 'Manager Check-In' },
    agenda: {
      schemaVersion: 1,
      closed: false,
      observedAt: START,
      week: 5,
      goals:
        options.goals === 'none'
          ? []
          : [
              {
                id: GOAL,
                kind: 'repair_position',
                slot: 'RB',
                week: 5,
                missing: 1,
                status: 'active',
                createdAt: START,
                updatedAt: START,
                sourceTaskId: 't',
                audience: 'owner_decisions',
                reason: 'insufficient_available_starters'
              }
            ]
    },
    claimLimit: async () => true,
    claimShared: async () => true,
    socialActs: {
      tenure: async () => 'tenure',
      read: async () => book,
      update: async (_t: string, change: (b: SocialActBook) => SocialActBook) => {
        book = change(book);
        return book;
      }
    },
    commitments: {
      tenure: async () => 'tenure',
      read: async () => ({ schemaVersion: 1, commitments: [] })
    },
    recall: async () => emptyMemory(),
    tools: {
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const data: Record<string, unknown> = {
          get_league: {
            teams: [
              { id: 'team-1', name: 'Big Tuna', seatType: 'human', ownerName: 'Allen' },
              { id: AGENT_TEAM, name: 'Team 2', seatType: 'agent', ownerName: null },
              { id: 'team-3', name: 'Bot Three', seatType: 'agent', ownerName: null },
              { id: 'team-4', name: 'Open', seatType: 'human', ownerName: null }
            ]
          },
          get_chat: { messages: [] },
          post_message: { message: { id: 'q-1' } }
        };
        return name in data
          ? { data: data[name], league: null, warnings: [] }
          : { error: { code: 'NOT_FOUND', message: 'no', fix: 'x' } };
      }
    }
  } as unknown as TaskContext;
  return { ctx, calls, book: () => book };
}

const newRun = (): Run => ({
  actionsLeft: 3,
  done: [],
  lineupNeeded: false,
  added: false,
  waiverClaims: [],
  released: [],
  trades: [],
  memory: []
});

describe('asking at a check-in', () => {
  it('asks the person whose player fills its need, in their DM, and records what it waits for', async () => {
    const { ctx, calls, book } = checkInCtx();
    const found = await lookOpportunities(ctx, { rooms: [], postsLeft: 10, seed: turn(), trade: TRADE });
    expect(found.act?.candidate).toMatchObject({
      act: 'ask_relevant_question',
      reason: 'need_partner',
      roomId: DM,
      counterpartTeamId: 'team-1',
      agendaId: GOAL,
      expects: 'trade_interest'
    });
    const prompt = actInstructions(found.act as NonNullable<typeof found.act>);
    expect(prompt).toContain('your direct message with them');
    expect(prompt).toContain('[roster:team-1:xrb1] Big Tuna rosters XRB1 (RB).');
    expect(prompt).toContain('nothing about what you need or would pay');
    // An agent-run team and an open seat are never asked.
    const run = newRun();
    const look = {
      social: { ...NO_SOCIAL, act: found.act },
      waivers: { pickups: [] },
      trade: { prep: TRADE }
    };
    await socialActStep(ctx, look as unknown as CheckInLook, [fakeActAction(found.act as never)], run);
    expect(run.done).toEqual([{ action: 'social_act', line: 'Posted a question in our direct messages.' }]);
    const posted = calls.find((c) => c.name === 'post_message');
    expect(posted?.args).toEqual({
      roomId: DM,
      text: 'Straight question. Big Tuna rosters XRB1 (RB). Would you move him?'
    });
    expect(book().acts).toMatchObject([
      {
        act: 'ask_relevant_question',
        outcome: 'posted',
        messageId: 'q-1',
        agendaId: GOAL,
        expects: 'trade_interest',
        roomId: DM
      }
    ]);
    // While it waits, it asks nothing more, of anyone.
    const again = await lookOpportunities(ctx, { rooms: [], postsLeft: 10, seed: turn(), trade: TRADE });
    expect(again.act).toBeNull();
  });

  it('cancels a question still waiting once its goal closes, and does not ask again', async () => {
    const waiting = recordSocialAct(emptySocialActs(), askEntry());
    const { ctx, book } = checkInCtx({ history: waiting, goals: 'none' });
    const found = await lookOpportunities(ctx, { rooms: [], postsLeft: 10, seed: turn(), trade: TRADE });
    expect(found.act).toBeNull();
    expect(book().acts).toMatchObject([{ outcome: 'cancelled', detail: 'goal_closed' }]);
  });
});

function askEntry(over: Partial<SocialActEntry> = {}): SocialActEntry {
  return {
    id: 'check_in.0:ask_relevant_question',
    taskId: 'check_in.0',
    act: 'ask_relevant_question',
    reason: 'need_partner',
    topic: `ask:${GOAL}:team-1`,
    eventKey: 'ask:team-1',
    roomId: DM,
    counterpartTeamId: 'team-1',
    evidence: ['roster:team-1:xrb1'],
    commitmentId: null,
    at: START,
    outcome: 'posted',
    detail: null,
    messageId: 'q-1',
    agendaId: GOAL,
    expects: 'trade_interest',
    expiresAt: new Date(Date.parse(START) + 2 * 24 * 3_600_000).toISOString(),
    ...over
  };
}

describe('the answer', () => {
  /** The market, Allen (team-1, a person) holding team-3's players, and the agent's question in their DM. */
  async function asked(entry: SocialActEntry = askEntry()) {
    const s = await market();
    const allen = (await s.repos.teams.get(LEAGUE_ID, 'team-1'))!;
    const three = (await s.repos.teams.get(LEAGUE_ID, 'team-3'))!;
    await s.repos.teams.update({ ...three, roster: [] });
    await s.repos.teams.update({ ...allen, roster: three.roster });
    for (const team of await s.repos.teams.list(LEAGUE_ID))
      await s.repos.teams.update({ ...team, occupiedSince: TENURE });
    const dm = { dmTeamIds: ['team-1', AGENT_TEAM] as [string, string] };
    const base = { leagueId: LEAGUE_ID, roomId: DM, mentionedTeamIds: [], event: null };
    await s.repos.chat.put(
      {
        ...base,
        id: 'q-1',
        kind: 'agent',
        author: { teamId: AGENT_TEAM, teamName: 'Team 2', name: 'Hype' },
        text: 'Straight question. Big Tuna rosters XRB1 (RB). Would you move him?',
        createdAt: s.clock.now().toISOString()
      } as ChatMessage,
      dm
    );
    await s.repos.agents.updateSocialActs(LEAGUE_ID, AGENT_ID, TENURE, (book) =>
      recordSocialAct(book, entry)
    );
    s.clock.advance(60_000);
    let n = 0;
    const reply = async (text: string) => {
      s.clock.advance(60_000);
      const m = {
        ...base,
        id: `a-${++n}`,
        kind: 'user',
        author: { teamId: 'team-1', teamName: 'Big Tuna', name: 'Allen' },
        text,
        createdAt: s.clock.now().toISOString()
      } as ChatMessage;
      await s.repos.chat.put(m, dm);
      return m;
    };
    const request = (m: ChatMessage): AgentActionRequested => ({
      taskId: `chat_reply.${m.id}`,
      leagueId: LEAGUE_ID,
      teamId: AGENT_TEAM,
      agentId: AGENT_ID,
      kind: 'chat_reply',
      trigger: { detailType: 'Chat Mention', eventId: `evt-${m.id}`, urgent: false },
      payload: { messageId: m.id, roomId: DM, coalesce: true },
      requestedAt: s.clock.now().toISOString()
    });
    const acts = async () => (await s.repos.agents.getSocialActs(LEAGUE_ID, AGENT_ID, TENURE)).acts;
    const commitments = async () => {
      const access = commitmentAccess(s.services, LEAGUE_ID, AGENT_ID, AGENT_TEAM);
      const tenure = await access.tenure();
      return tenure === null ? [] : (await access.read(tenure)).commitments;
    };
    return { ...s, reply, request, acts, commitments };
  }

  const said = (decision: Record<string, unknown>) =>
    new ScriptedModelClient({ script: () => ({ steps: [], decision }) as FakeScript });

  it('reads their next message as the answer and moves the exchange on to a proper look', async () => {
    const s = await asked();
    const answer = await s.reply('Sure, XRB1 for your WR5 and he is yours');
    const model = said({
      summary: 'Answered.',
      message: 'Deal in principle. Let me run the numbers.',
      takeaway: { kind: 'trade', players: ['XRB1', 'WR5'] }
    });
    await runAgentAction(s.deps(model), s.request(answer));
    const prompt = model.transcript[0]?.systemPrompt ?? '';
    expect(prompt).toContain(
      'Earlier you asked them here: <<<Straight question. Big Tuna rosters XRB1 (RB). Would you move him?>>>'
    );
    expect(prompt).toContain('whether they would trade');
    expect(prompt).toContain('do not ask it again');
    expect(await s.acts()).toMatchObject([{ outcome: 'answered', answerId: answer.id }]);
    // The answer became the look the question was for.
    expect(await s.commitments()).toMatchObject([
      { source: { messageId: answer.id }, intent: { send: ['wr5'], receive: ['xrb1'] } }
    ]);
    // The next message is just a message: the question is not read into it again.
    const later = await s.reply('Also, nice win last week');
    const next = said({ summary: 'Answered.', message: 'Thanks.' });
    await runAgentAction(s.deps(next), s.request(later));
    expect(next.transcript[0]?.systemPrompt ?? '').not.toContain('Earlier you asked them');
  });

  it('never reads a message as the answer to a question that lapsed or whose look moved on', async () => {
    const lapsed = await asked(askEntry({ expiresAt: new Date(Date.parse(START) - 1).toISOString() }));
    const model = said({ summary: 'Answered.', message: 'Hey.' });
    await runAgentAction(lapsed.deps(model), lapsed.request(await lapsed.reply('Sure, why not')));
    expect(model.transcript[0]?.systemPrompt ?? '').not.toContain('Earlier you asked them');
    expect(await lapsed.acts()).toMatchObject([{ outcome: 'posted' }]);

    // A question about a declined pitch whose commitment is gone from the book is cancelled.
    const moved = await asked(askEntry({ commitmentId: 'trade_interest:gone', agendaId: null }));
    const other = said({ summary: 'Answered.', message: 'Hey.' });
    await runAgentAction(moved.deps(other), moved.request(await moved.reply('I could add a pick')));
    expect(other.transcript[0]?.systemPrompt ?? '').not.toContain('Earlier you asked them');
  });
});
