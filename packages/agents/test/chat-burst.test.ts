import { pendingQuestions, SOCIAL_ACT_LIMITS } from '@fantasy/core';
import { scheduleName, type ChatMessage } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { AgentActionRequestedSchema, type AgentActionRequested, type BusEvent } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { burstTaskId, CHAT_BURST, CHAT_COOLDOWNS, routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { addressedTo, burstOf } from '../src/tasks/chat.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup } from './support.js';

/**
 * Bursts of a person's messages to an agent (#215): the router defers one reply past the reply
 * cooldown instead of dropping the messages, the rest of the burst joins it, and that one reply
 * answers the newest message with the burst in view. Neither a duplicate delivery nor a check-in's
 * hand-off answers the burst again.
 */

const SEAT = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;
const ROOM = 'trash-talk';
const DM = 'dm-team-1-team-2';
const COOLDOWN_MS = CHAT_COOLDOWNS.reply.agentMinutes * 60_000;

async function burstSetup() {
  const s = await setup();
  await s.seat(AGENT_TEAM, SEAT);
  const model = new ScriptedModelClient();
  const route = (e: BusEvent) => routeEvent({ services: s.services, kinds: defaultTaskKinds }, e);
  const run = (request: AgentActionRequested) => runAgentAction(s.deps(model), request);
  const published = () =>
    s.events.events
      .filter((e) => e.detailType === 'Agent Action Requested')
      .map((e) => AgentActionRequestedSchema.parse(e.detail));
  const scheduled = () =>
    s.events.events
      .filter((e) => e.detailType === 'Schedule Event')
      .map((e) => e.detail as { at: string; name: string; event: { detail: unknown } });
  const replies = async (roomId = ROOM) =>
    (await s.repos.chat.list(LEAGUE_ID, roomId, { limit: 100 })).messages.filter((m) => m.kind === 'agent');
  let n = 0;
  /** The person says something in a room, and its Chat Mention (if the server would send one). */
  const say = async (
    text: string,
    options: { roomId?: string; mention?: boolean; continued?: boolean } = {}
  ): Promise<{ message: ChatMessage; event: BusEvent }> => {
    const roomId = options.roomId ?? ROOM;
    const message: ChatMessage = {
      id: `m-${++n}`,
      leagueId: LEAGUE_ID,
      roomId,
      kind: 'user',
      author: { teamId: 'team-1', teamName: "Allen's Team", name: 'Allen' },
      text,
      mentionedTeamIds: options.mention === true ? [AGENT_TEAM] : [],
      ...(options.continued === true ? { addressedTeamIds: [AGENT_TEAM] } : {}),
      event: null,
      createdAt: s.clock.now().toISOString()
    };
    await s.repos.chat.put(message, roomId === DM ? { dmTeamIds: ['team-1', AGENT_TEAM] } : {});
    const addressedBy = roomId === DM ? 'dm' : options.continued === true ? 'continuation' : 'mention';
    return {
      message,
      event: {
        id: `evt-${message.id}`,
        'detail-type': 'Chat Mention',
        source: 'fantasy',
        detail: {
          leagueId: LEAGUE_ID,
          roomId,
          messageId: message.id,
          authorTeamId: 'team-1',
          authorType: 'user',
          mentionedTeamIds: [AGENT_TEAM],
          addressedBy,
          replyToAgentDepth: 0
        }
      }
    };
  };
  return { ...s, model, route, run, published, scheduled, replies, say };
}

describe('a burst of messages inside the reply cooldown', () => {
  it('gets exactly one deferred reply, to the newest message, with the burst in view', async () => {
    const s = await burstSetup();
    // The person opens with a mention; the agent answers at once and its cooldown starts.
    const opening = await s.say('@Team 2 you up?', { mention: true });
    expect(await s.route(opening.event)).toMatchObject([{ decision: 'requested', delayMs: 0 }]);
    await s.run(s.published()[0] as AgentActionRequested);
    expect(await s.replies()).toHaveLength(1);

    // Three quick follow-ups, none of them tagged, all inside the cooldown.
    const burst = [];
    for (const text of ['Hello?', 'Did you see my RB went down', 'So what do you want for your WR2?']) {
      s.clock.advance(10_000);
      burst.push(await s.say(text, { continued: true }));
    }
    const decisions = [];
    for (const b of burst) decisions.push(...(await s.route(b.event)));
    const deferredId = burstTaskId(burst[0]?.event.id as string, AGENT_TEAM, 'chat_reply');
    expect(decisions).toEqual([
      {
        teamId: AGENT_TEAM,
        leagueId: LEAGUE_ID,
        decision: 'requested',
        kind: 'chat_reply',
        taskId: deferredId,
        // When the cooldown the opening reply started ends.
        delayMs: COOLDOWN_MS - 30_000
      },
      { teamId: AGENT_TEAM, leagueId: LEAGUE_ID, decision: 'coalesced', kind: 'chat_reply' },
      { teamId: AGENT_TEAM, leagueId: LEAGUE_ID, decision: 'coalesced', kind: 'chat_reply' }
    ]);
    // Delivered again, the burst schedules nothing more.
    for (const b of burst) await s.route(b.event);
    expect(s.scheduled()).toHaveLength(1);
    const schedule = s.scheduled()[0];
    expect(schedule).toMatchObject({
      at: new Date(Date.parse(START) + COOLDOWN_MS).toISOString(),
      name: scheduleName('agent-task', deferredId)
    });
    const deferred = AgentActionRequestedSchema.parse(schedule?.event.detail);
    expect(deferred.payload).toMatchObject({ messageId: burst[0]?.message.id, coalesce: true });

    // It runs when the cooldown ends: one reply, to the newest message, the earlier ones listed.
    s.clock.set(new Date(schedule?.at as string));
    const record = await s.run(deferred);
    expect(record).toMatchObject({ status: 'completed', finalAction: 'post_message' });
    const prompt = s.model.transcript.at(-1)?.systemPrompt ?? '';
    expect(prompt).toContain('Allen sent you several messages');
    expect(prompt).toContain('Answer everything still pending in one message');
    expect(prompt).toContain("Allen (Allen's Team): Hello?");
    expect(prompt).toContain("Allen (Allen's Team): Did you see my RB went down");
    expect(prompt).toContain('The message you are answering: <<<So what do you want for your WR2?>>>');
    const replies = await s.replies();
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({
      replyToId: burst[2]?.message.id,
      answersMessageIds: [burst[0]?.message.id, burst[1]?.message.id]
    });

    // A duplicate delivery of the deferred task, or a late one for the same burst, adds nothing.
    expect(await s.run(deferred)).toMatchObject({ status: 'completed' });
    const late = await s.run({ ...deferred, taskId: 'chat_reply.late' });
    expect(late).toMatchObject({ status: 'skipped', fallbackReason: 'already_answered' });
    expect(await s.replies()).toHaveLength(2);

    // A later check-in finds nothing pending, and its hand-off of an earlier message stays quiet.
    s.clock.advance(SOCIAL_ACT_LIMITS.questionGraceMs + 60_000);
    const room = (await s.repos.chat.list(LEAGUE_ID, ROOM, { limit: 50 })).messages;
    expect(
      pendingQuestions(room, { roomId: ROOM, dm: false }, AGENT_TEAM, s.clock.now().toISOString())
    ).toEqual([]);
    const handOff = await s.run({
      ...deferred,
      taskId: 'chat_reply.hand-off',
      payload: { messageId: burst[1]?.message.id, roomId: ROOM }
    });
    expect(handOff).toMatchObject({ status: 'skipped', fallbackReason: 'already_answered' });
    expect(await s.replies()).toHaveLength(2);
  });

  it('keeps a DM and a public room apart: each gets its own reply, one cooldown after the other', async () => {
    const s = await burstSetup();
    const opening = await s.say('@Team 2 you up?', { mention: true });
    await s.route(opening.event);
    await s.run(s.published()[0] as AgentActionRequested);
    s.clock.advance(10_000);
    const inRoom = await s.say('Well?', { continued: true });
    s.clock.advance(10_000);
    const inDm = await s.say('psst, about that trade', { roomId: DM });
    const room = await s.route(inRoom.event);
    const dm = await s.route(inDm.event);
    expect(room).toMatchObject([{ decision: 'requested', delayMs: COOLDOWN_MS - 20_000 }]);
    // The DM is not swallowed by the room's reply: it waits one more cooldown.
    expect(dm).toMatchObject([{ decision: 'requested', delayMs: 2 * COOLDOWN_MS - 20_000 }]);
    const [first, second] = s.scheduled().map((e) => AgentActionRequestedSchema.parse(e.event.detail));
    s.clock.set(new Date(Date.parse(START) + COOLDOWN_MS));
    await s.run(first as AgentActionRequested);
    s.clock.set(new Date(Date.parse(START) + 2 * COOLDOWN_MS));
    await s.run(second as AgentActionRequested);
    expect((await s.replies()).map((m) => m.replyToId)).toEqual([inRoom.message.id, opening.message.id]);
    expect((await s.replies(DM)).map((m) => m.replyToId)).toEqual([inDm.message.id]);
  });

  it('frees the burst for the next message when every deferral loses the chat slot', async () => {
    const s = await burstSetup();
    const opening = await s.say('@Team 2 you up?', { mention: true });
    await s.route(opening.event);
    await s.run(s.published()[0] as AgentActionRequested);
    const agents = s.services.repos.agents;
    const reserve = agents.reserveDispatch.bind(agents);
    let reservations = 0;
    agents.reserveDispatch = async () => {
      reservations++;
      return { status: 'gated' };
    };
    s.clock.advance(10_000);
    const lost = await s.say('Well?', { continued: true });
    expect(await s.route(lost.event)).toMatchObject([{ decision: 'cooldown' }]);
    // The immediate try, then every deferral attempt; nothing was scheduled.
    expect(reservations).toBe(1 + CHAT_BURST.attempts);
    expect(s.scheduled()).toEqual([]);

    // The contention clears: the person's next message is not coalesced into a reply that never
    // existed. It gets its own deferred reply, which answers it with the lost one in view.
    agents.reserveDispatch = reserve;
    s.clock.advance(10_000);
    const next = await s.say('Anyone home?', { continued: true });
    expect(await s.route(next.event)).toMatchObject([
      { decision: 'requested', delayMs: COOLDOWN_MS - 20_000 }
    ]);
    const schedule = s.scheduled()[0];
    s.clock.set(new Date(schedule?.at as string));
    await s.run(AgentActionRequestedSchema.parse(schedule?.event.detail));
    expect((await s.replies()).map((m) => m.replyToId)).toEqual([next.message.id, opening.message.id]);
    expect(s.model.transcript.at(-1)?.systemPrompt).toContain("Allen (Allen's Team): Well?");
  });

  it('leaves agent banter to its own cooldown: a retort inside it is still dropped', async () => {
    const s = await burstSetup();
    await s.seat('team-3', SEAT);
    const jab = (id: string): BusEvent => ({
      id,
      'detail-type': 'Chat Mention',
      source: 'fantasy',
      detail: {
        leagueId: LEAGUE_ID,
        roomId: ROOM,
        messageId: id,
        authorTeamId: 'team-3',
        authorType: 'agent',
        mentionedTeamIds: [AGENT_TEAM],
        replyToAgentDepth: 0
      }
    });
    const decisions = [...(await s.route(jab('j1'))), ...(await s.route(jab('j2')))].map((d) => d.decision);
    expect(decisions.filter((d) => d === 'requested').length).toBeLessThanOrEqual(1);
    expect(decisions).not.toContain('coalesced');
    expect(s.scheduled()).toEqual([]);
  });
});

describe('burstOf', () => {
  const msg = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    leagueId: LEAGUE_ID,
    roomId: ROOM,
    kind: 'user',
    author: { teamId: 'team-1', teamName: null, name: 'Allen' },
    text: id,
    mentionedTeamIds: [],
    addressedTeamIds: [AGENT_TEAM],
    event: null,
    createdAt: `2026-10-04T15:0${id.slice(-1)}:00.000Z`,
    ...over
  });

  it('answers the newest message the person addressed to the agent, with the unanswered rest', () => {
    const newestFirst = [
      msg('m6', { author: { teamId: 'team-4', teamName: null, name: 'Bo' } }),
      msg('m5', { addressedTeamIds: [], mentionedTeamIds: ['team-3'] }),
      msg('m4'),
      msg('m3', { addressedTeamIds: undefined, mentionedTeamIds: [AGENT_TEAM] }),
      msg('m2', {
        kind: 'agent',
        author: { teamId: AGENT_TEAM, teamName: null, name: 'Bot' },
        replyToId: 'm1',
        addressedTeamIds: undefined
      }),
      msg('m1')
    ];
    const { target, burst } = burstOf(newestFirst, newestFirst[3] as ChatMessage, AGENT_TEAM, false);
    expect(target.id).toBe('m4');
    // m1 was answered already; m5 is to someone else; m6 is someone else's.
    expect(burst.map((m) => m.id)).toEqual(['m3']);
    // Nothing newer: the message itself.
    expect(burstOf(newestFirst, newestFirst[0] as ChatMessage, AGENT_TEAM, false).target.id).toBe('m6');
  });

  it('reads a DM message, a mention, and a continued talk as addressed to the agent', () => {
    expect(addressedTo(msg('m1', { addressedTeamIds: undefined }), AGENT_TEAM, true)).toBe(true);
    expect(addressedTo(msg('m1', { addressedTeamIds: undefined }), AGENT_TEAM, false)).toBe(false);
    expect(addressedTo(msg('m1'), AGENT_TEAM, false)).toBe(true);
    expect(addressedTo(msg('m1', { kind: 'agent' }), AGENT_TEAM, false)).toBe(false);
    expect(
      addressedTo(msg('m1', { author: { teamId: AGENT_TEAM, teamName: null, name: 'Me' } }), AGENT_TEAM, true)
    ).toBe(false);
  });
});
