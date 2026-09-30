import { pendingQuestions, SOCIAL_ACT_LIMITS } from '@fantasy/core';
import { AGENT_CHAT_BUDGETS, type ChatMessage } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { commitmentAccess } from '../src/commitments.js';
import { AgentActionRequestedSchema, type AgentActionRequested, type BusEvent } from '../src/events.js';
import { ScriptedModelClient, type FakeScript } from '../src/fake-model.js';
import { routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { market } from './market.js';
import { AGENT_TEAM, LEAGUE_ID, type Setup } from './support.js';

/**
 * Explicit question resolution (#215): a reply answers the message it replies to and the burst
 * messages it names, and nothing else. A question the model left open, one that arrived while it
 * was writing, and one behind an unrelated line of the agent's stay pending until a reply names
 * them; a failed post gives its claims back; a corrected trade pitch opens one commitment on the
 * newest terms without erasing the other question.
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const DM = 'dm-team-1-team-2';
const TENURE = '2026-09-01T00:00:00.000Z';

/** The market, with Allen (team-1, a person) holding team-3's players. */
async function questionsSetup() {
  const s = await market();
  const allen = (await s.repos.teams.get(LEAGUE_ID, 'team-1'))!;
  const three = (await s.repos.teams.get(LEAGUE_ID, 'team-3'))!;
  await s.repos.teams.update({ ...three, roster: [] });
  await s.repos.teams.update({ ...allen, roster: three.roster });
  for (const team of await s.repos.teams.list(LEAGUE_ID))
    await s.repos.teams.update({ ...team, occupiedSince: TENURE });
  let n = 0;
  const message = (text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: `m-${++n}`,
    leagueId: LEAGUE_ID,
    roomId: DM,
    kind: 'user',
    author: { teamId: 'team-1', teamName: "Allen's Team", name: 'Allen' },
    text,
    mentionedTeamIds: [],
    event: null,
    createdAt: s.clock.now().toISOString(),
    ...over
  });
  /** Allen says something in the DM, ten seconds after the last thing. */
  const say = async (text: string): Promise<ChatMessage> => {
    s.clock.advance(10_000);
    const m = message(text);
    await s.repos.chat.put(m, { dmTeamIds: ['team-1', AGENT_TEAM] });
    return m;
  };
  const mention = (m: ChatMessage): BusEvent => ({
    id: `evt-${m.id}`,
    'detail-type': 'Chat Mention',
    source: 'fantasy',
    detail: {
      leagueId: LEAGUE_ID,
      roomId: DM,
      messageId: m.id,
      authorTeamId: 'team-1',
      authorType: 'user',
      mentionedTeamIds: [AGENT_TEAM],
      addressedBy: 'dm',
      replyToAgentDepth: 0
    }
  });
  const reply = (m: ChatMessage, taskId = `chat_reply.${m.id}`): AgentActionRequested => ({
    taskId,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind: 'chat_reply',
    trigger: { detailType: 'Chat Mention', eventId: `evt-${m.id}`, urgent: false },
    payload: { messageId: m.id, roomId: DM, coalesce: true },
    requestedAt: s.clock.now().toISOString()
  });
  const room = async () => (await s.repos.chat.list(LEAGUE_ID, DM, { limit: 50 })).messages;
  const agentLines = async () => (await room()).filter((m) => m.kind === 'agent');
  const pending = async () => {
    s.clock.advance(SOCIAL_ACT_LIMITS.questionGraceMs + 60_000);
    return pendingQuestions(
      await room(),
      { roomId: DM, dm: true },
      AGENT_TEAM,
      s.clock.now().toISOString()
    ).map((q) => q.messageId);
  };
  const commitments = async () => {
    const access = commitmentAccess(s.services, LEAGUE_ID, AGENT_ID, AGENT_TEAM);
    const tenure = await access.tenure();
    return tenure === null ? [] : (await access.read(tenure)).commitments;
  };
  return { ...s, message, say, mention, reply, room, agentLines, pending, commitments };
}

const said = (decision: Record<string, unknown>, onRun?: () => void) =>
  new ScriptedModelClient({
    script: () => {
      onRun?.();
      return { steps: [], decision } as FakeScript;
    }
  });

const run = (s: Setup, model: ScriptedModelClient, request: AgentActionRequested) =>
  runAgentAction(s.deps(model), request);

describe('one reply to a burst of questions', () => {
  it('names every message it answers, so none is answered again', async () => {
    const s = await questionsSetup();
    const burst = [
      await s.say('You there'),
      await s.say('who are you starting at flex this week'),
      await s.say('Also, what do you want for your WR5?')
    ];
    const model = said({ summary: 'Answered.', message: 'Here, Allen. XWR1 at flex; WR5 is not cheap.' });
    expect(await run(s, model, s.reply(burst[0] as ChatMessage))).toMatchObject({
      finalAction: 'post_message'
    });
    const [line] = await s.agentLines();
    // It answers the newest, and names the two before it.
    expect(line).toMatchObject({ replyToId: burst[2]?.id, answersMessageIds: [burst[0]?.id, burst[1]?.id] });
    expect(model.transcript[0]?.systemPrompt).toContain('(m1) ');
    expect(model.transcript[0]?.systemPrompt).toContain('(m2) ');
    expect(await s.pending()).toEqual([]);
  });

  it('keeps a question the model left open pending, and a later hand-off answers only that one', async () => {
    const s = await questionsSetup();
    const flex = await s.say('who are you starting at flex this week');
    const price = await s.say('what do you want for your WR5?');
    await run(
      s,
      said({ summary: 'Answered.', message: 'WR5 costs a starter.', leftOpen: ['m1', 'bogus'] }),
      s.reply(flex)
    );
    const [first] = await s.agentLines();
    expect(first).toMatchObject({ replyToId: price.id });
    expect(first?.answersMessageIds).toBeUndefined();
    // Still pending, for the check-in's hand-off (coalesced: it finds the one still open).
    expect(await s.pending()).toEqual([flex.id]);
    const handOff = said({ summary: 'Answered.', message: 'Flex is XWR1.' });
    await run(s, handOff, s.reply(flex, 'chat_reply.hand-off'));
    expect((await s.agentLines()).map((m) => m.replyToId)).toEqual([flex.id, price.id]);
    expect(await s.pending()).toEqual([]);
  });

  it('never counts an unrelated line of the agent in the DM as an answer', async () => {
    const s = await questionsSetup();
    const question = await s.say('what do you want for your WR5?');
    // An outreach line, or a closing line on something else: not a reply to the question.
    s.clock.advance(10_000);
    await s.repos.chat.put(
      s.message('Still thinking about that RB of yours.', {
        kind: 'agent',
        author: { teamId: AGENT_TEAM, teamName: 'Team 2', name: 'Bot' }
      }),
      { dmTeamIds: ['team-1', AGENT_TEAM] }
    );
    expect(await s.pending()).toEqual([question.id]);
    await run(s, said({ summary: 'Answered.', message: 'A starter.' }), s.reply(question));
    expect((await s.agentLines())[0]).toMatchObject({ replyToId: question.id });
    expect(await s.pending()).toEqual([]);
  });

  it('leaves a message that arrives while the reply is written for the next reply', async () => {
    const s = await questionsSetup();
    const first = await s.say('what do you want for your WR5?');
    const route = (e: BusEvent) => routeEvent({ services: s.services, kinds: defaultTaskKinds }, e);
    expect(await route(s.mention(first))).toMatchObject([{ decision: 'requested' }]);
    let late: ChatMessage | null = null;
    const model = said({ summary: 'Answered.', message: 'A starter.' }, () => {
      // The person writes again while the model is still at it.
      late = s.message('and would you take XRB1 for him');
      void s.repos.chat.put(late, { dmTeamIds: ['team-1', AGENT_TEAM] });
    });
    const request = s.events.events
      .filter((e) => e.detailType === 'Agent Action Requested')
      .map((e) => AgentActionRequestedSchema.parse(e.detail))[0] as AgentActionRequested;
    await run(s, model, request);
    const lateId = (late as ChatMessage | null)?.id as string;
    expect((await s.agentLines())[0]).toMatchObject({ replyToId: first.id });
    expect((await s.agentLines())[0]?.answersMessageIds).toBeUndefined();
    // Its own mention, inside the cooldown, is deferred rather than dropped; that reply answers it.
    const deferred = await route(s.mention((await s.room()).find((m) => m.id === lateId) as ChatMessage));
    expect(deferred).toMatchObject([{ decision: 'requested' }]);
    const scheduled = s.events.events.filter((e) => e.detailType === 'Schedule Event').at(-1)?.detail as {
      at: string;
      event: { detail: unknown };
    };
    s.clock.set(new Date(scheduled.at));
    await run(
      s,
      said({ summary: 'Answered.', message: 'Maybe.' }),
      AgentActionRequestedSchema.parse(scheduled.event.detail)
    );
    expect((await s.agentLines()).map((m) => m.replyToId)).toEqual([lateId, first.id]);
    expect(await s.pending()).toEqual([]);
  });

  it('gives its claims back when the post fails, so the question stays answerable', async () => {
    const s = await questionsSetup();
    const earlier = await s.say('who are you starting at flex this week');
    const question = await s.say('what do you want for your WR5?');
    // The agent's daily budget runs out while the model writes: the post is refused.
    const spend = () => {
      for (let i = 0; i < AGENT_CHAT_BUDGETS.agentPerDay; i++)
        void s.repos.chat.put(
          s.message(`line ${i}`, {
            roomId: 'league',
            kind: 'agent',
            author: { teamId: AGENT_TEAM, teamName: 'Team 2', name: 'Bot' }
          })
        );
    };
    const record = await run(
      s,
      said({ summary: 'Answered.', message: 'A starter.' }, spend),
      s.reply(question)
    );
    expect(record).toMatchObject({ finalAction: 'post_message_failed' });
    expect(await s.agentLines()).toEqual([]);
    for (const m of [earlier, question]) {
      const free = await s.services.repos.agents.admitTrigger(LEAGUE_ID, {
        slot: `${AGENT_ID}#once#reply#${m.id}`,
        owner: 'another-task',
        now: s.clock.now(),
        windowMs: 60_000
      });
      expect(free).toBe(true);
    }
    expect(await s.pending()).toEqual([question.id, earlier.id]);
  });
});

describe('a corrected trade pitch inside a burst', () => {
  it('opens one commitment on the newest terms without erasing the other question', async () => {
    const s = await questionsSetup();
    const stale = await s.say('XRB1 for your WR5?');
    const flex = await s.say('also who are you starting at flex');
    const fixed = await s.say('actually make it XRB2 for WR5 instead');
    await run(
      s,
      said({
        summary: 'Answered.',
        message: 'XWR1 at flex. XRB2 for WR5, I will look at it.',
        takeaway: { kind: 'trade', players: ['XRB2', 'WR5'] }
      }),
      s.reply(stale)
    );
    const book = await s.commitments();
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ source: { messageId: fixed.id }, intent: { receive: ['xrb2'] } });
    expect((await s.agentLines())[0]).toMatchObject({
      replyToId: fixed.id,
      answersMessageIds: [stale.id, flex.id]
    });
    expect(await s.pending()).toEqual([]);
  });

  it('takes the takeaway from the earlier message the model names', async () => {
    const s = await questionsSetup();
    const pitch = await s.say('XRB1 for your WR5?');
    await s.say('also who are you starting at flex');
    await run(
      s,
      said({
        summary: 'Answered.',
        message: 'XWR1 at flex. XRB1 for WR5, I will look.',
        takeaway: { kind: 'trade', players: ['XRB1', 'WR5'], ref: 'm1' }
      }),
      s.reply(pitch)
    );
    expect(await s.commitments()).toMatchObject([{ source: { messageId: pitch.id } }]);
  });
});
