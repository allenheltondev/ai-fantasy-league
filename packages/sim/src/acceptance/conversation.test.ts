import { CHAT_COOLDOWNS } from '@fantasy/agents';
import { SOCIAL_ACT_LIMITS } from '@fantasy/core';
import type { AgentActionRequested } from '@fantasy/agents';
import type { BusEvent, ChatMessage } from '@fantasy/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { RecordingModel } from '../scenarios/recording-model.js';
import { acceptanceModel, answers, commitmentFor } from './trade-interest.js';
import { AGENT_TEAM, buildWorld, playerName, type AcceptanceWorld } from './world.js';

/**
 * Conversation continuity and bursts (#215), end to end through the event loop on the simulated
 * clock with the acceptance scenario's scripted model:
 *
 * 1. In the league room, the person tags the agent once and then goes back and forth without
 *    tagging it: every message gets its answer.
 * 2. Inside the agent's reply cooldown the person sends three quick messages, the last a trade
 *    pitch: nothing is dropped and nothing answers them one by one; when the cooldown ends, one
 *    reply answers the newest with the other two in view, and the pitch becomes one commitment.
 * 3. Every burst mention and every task is delivered again, and a check-in comes by later: the
 *    burst is not answered again.
 */

const ROOM = 'league';
const MINUTE = 60_000;
const COOLDOWN_MS = CHAT_COOLDOWNS.reply.agentMinutes * MINUTE;
const PITCH_TEXT = `would you trade your ${playerName('wr2')} for my ${playerName('p-rb3')}?`;

let w: AcceptanceWorld;
let model: RecordingModel;
let exchange: ChatMessage[];
let burst: ChatMessage[];
let burstAnswered: { first: string[]; second: string[]; newest: string[] };
let coalescedPrompt: string;
let deferred: AgentActionRequested[];
let lateOutcomes: (string | null)[];
let linesBeforeReplays: number;
let linesAfterReplays: number;
let linesAfterCheckIn: string[][];

const agentLines = async () =>
  (await w.repos.chat.list(w.league.id, ROOM, { limit: 200 })).messages.filter((m) => m.kind === 'agent');
const chatReplies = () => w.requests().filter((r) => r.kind === 'chat_reply');

beforeAll(async () => {
  model = new RecordingModel(acceptanceModel());
  w = await buildWorld({
    config: { personalityId: 'smug-veteran', difficulty: 'hall_of_famer', archetype: 'balanced' },
    model
  });
  model.clock = w.clock;

  // 1. One tag, then an untagged back-and-forth, each message past the last reply's cooldown.
  exchange = [await w.say(`@${AGENT_TEAM} how is your week going?`, ROOM)];
  for (const text of ['Mine is rough, my RB1 is banged up.', 'Any advice for a guy in my spot?']) {
    await w.advance(3 * MINUTE);
    exchange.push(await w.say(text, ROOM));
  }

  // 2. The burst, inside the cooldown of the last answer; then the cooldown runs out.
  burst = [];
  for (const text of ['Hello?', 'You still there?', PITCH_TEXT]) {
    await w.advance(15_000);
    burst.push(await w.say(text, ROOM));
  }
  await w.advance(COOLDOWN_MS);
  burstAnswered = {
    first: await answers(w, burst[0] as ChatMessage),
    second: await answers(w, burst[1] as ChatMessage),
    newest: await answers(w, burst[2] as ChatMessage)
  };
  deferred = chatReplies().filter((r) => r.payload.coalesce === true);
  coalescedPrompt =
    model.runs.find((r) => r.kind === 'chat_reply' && r.systemPrompt.includes('several messages'))
      ?.systemPrompt ?? '';

  // 3. Everything again, then a check-in once the questions' grace has passed.
  await w.advance(10 * MINUTE);
  linesBeforeReplays = (await agentLines()).length;
  const ids = new Set(burst.map((m) => m.id));
  const mentions = w.delivered.filter(
    (e) => e['detail-type'] === 'Chat Mention' && ids.has((e.detail as { messageId: string }).messageId)
  );
  for (const e of mentions) await w.redeliver(e as BusEvent);
  for (const r of chatReplies()) await w.rerun(r);
  linesAfterReplays = (await agentLines()).length;
  // A late redelivery may defer another reply; it finds the burst answered and posts nothing.
  const tasks = await w.repos.agents.listTasks(w.league.id, { limit: 200 });
  lateOutcomes = chatReplies()
    .filter((r) => r.payload.coalesce === true && r.taskId !== deferred[0]?.taskId)
    .map((r) => tasks.find((t) => t.taskId === r.taskId)?.fallbackReason ?? null);
  await w.advance(SOCIAL_ACT_LIMITS.questionGraceMs);
  await w.checkIn('afternoon');
  await w.advance(4 * 3_600_000);
  linesAfterCheckIn = [await answers(w, burst[0] as ChatMessage), await answers(w, burst[1] as ChatMessage)];
}, 60_000);

describe('conversation continuity (#215)', () => {
  it('answers an untagged back-and-forth with the agent in the league room', async () => {
    const [tagged, ...untagged] = exchange;
    expect(tagged?.mentionedTeamIds).toEqual([AGENT_TEAM]);
    for (const m of untagged) {
      // The message stays truthful about its mentions; the addressee is carried apart.
      expect(m).toMatchObject({ mentionedTeamIds: [], addressedTeamIds: [AGENT_TEAM] });
      const mention = w.delivered.find(
        (e) => e['detail-type'] === 'Chat Mention' && (e.detail as { messageId: string }).messageId === m.id
      );
      expect(mention?.detail).toMatchObject({ addressedBy: 'continuation', mentionedTeamIds: [AGENT_TEAM] });
    }
    for (const m of exchange) expect(await answers(w, m)).toHaveLength(1);
    const prompt =
      model.runs.find((r) => r.systemPrompt.includes('Any advice for a guy'))?.systemPrompt ?? '';
    expect(prompt).toContain('following up on your conversation without tagging you');
  });
});

describe('a burst inside the reply cooldown (#215)', () => {
  it('gets one reply when the cooldown ends, to the newest message, with the rest in view', () => {
    for (const m of burst) expect(m.addressedTeamIds).toEqual([AGENT_TEAM]);
    expect(burstAnswered.first).toEqual([]);
    expect(burstAnswered.second).toEqual([]);
    // The reply, and the commitment's own closing line once the look is done (#215).
    expect(burstAnswered.newest).toHaveLength(2);
    expect(burstAnswered.newest).toContain('Let me run the numbers on that.');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.payload.messageId).toBe(burst[0]?.id);
    expect(coalescedPrompt).toContain('Answer everything still pending in one message');
    expect(coalescedPrompt).toContain('Hello?');
    expect(coalescedPrompt).toContain('You still there?');
    expect(coalescedPrompt).toContain(`The message you are answering: <<<${PITCH_TEXT}>>>`);
  });

  it('turns the pitch in the burst into exactly one commitment', async () => {
    const commitment = await commitmentFor(w, burst[2] as ChatMessage);
    expect(commitment).toMatchObject({
      kind: 'trade_interest',
      source: { messageId: burst[2]?.id, visibility: 'room' },
      intent: { send: ['wr2'], receive: ['p-rb3'] }
    });
    for (const m of burst.slice(0, 2)) expect(await commitmentFor(w, m)).toBeNull();
  });

  it('is not answered again by a duplicate delivery or a later check-in', () => {
    expect(linesAfterReplays).toBe(linesBeforeReplays);
    for (const outcome of lateOutcomes) expect(outcome).toBe('already_answered');
    expect(linesAfterCheckIn).toEqual([[], []]);
  });
});
