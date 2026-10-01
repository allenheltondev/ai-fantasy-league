import { CHAT_COOLDOWNS, ScriptedModelClient, type FakeScript, type ModelRunRequest } from '@fantasy/agents';
import { SOCIAL_ACT_LIMITS } from '@fantasy/core';
import type { ChatMessage } from '@fantasy/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { RecordingModel } from '../scenarios/recording-model.js';
import { answers } from './trade-interest.js';
import { AGENT_TEAM, DM_ROOM, buildWorld, type AcceptanceWorld } from './world.js';

/**
 * Explicit question resolution (#215), end to end through the event loop on the simulated clock:
 *
 * 1. The person opens a DM and the agent answers at once; its reply cooldown starts.
 * 2. Inside the cooldown they ask two things. One deferred reply answers the newest and, as the
 *    model says, leaves the older question open (`leftOpen`).
 * 3. The agent's unrelated line in the DM (an outreach) does not count as an answer to it.
 * 4. Once the question's grace has passed, a check-in hands it on; that reply answers it, and
 *    every task delivered again answers nothing twice.
 */

const MINUTE = 60_000;
const COOLDOWN_MS = CHAT_COOLDOWNS.reply.agentMinutes * MINUTE;
const FLEX = 'who are you starting at flex this week';
const PRICE = 'what do you want for your WR2?';

/** Answers every chat reply, leaving the flex question open the first time it is in a burst. */
function questionsModel(): ScriptedModelClient {
  let leftOnce = false;
  return new ScriptedModelClient({
    script: (request: ModelRunRequest<unknown>): FakeScript | undefined => {
      const taskId = String((request.invocationState as { taskId?: string }).taskId ?? '');
      if (!taskId.startsWith('chat_reply.')) return undefined;
      const leave =
        !leftOnce && request.systemPrompt.includes(`(m1) `) && request.systemPrompt.includes(FLEX);
      if (leave) leftOnce = true;
      return {
        steps: [],
        decision: {
          summary: 'Answered.',
          message: leave ? 'A starter for WR2. Flex later.' : 'Answered, Allen.',
          ...(leave ? { leftOpen: ['m1'] } : {})
        }
      };
    }
  });
}

let w: AcceptanceWorld;
let opening: ChatMessage;
let flex: ChatMessage;
let price: ChatMessage;
let afterBurst: { flex: string[]; price: string[]; covered: string[] | undefined };
let afterCheckIn: { flex: string[]; price: string[] };
let linesBeforeReplays: number;
let linesAfterReplays: number;

const dmLines = async () =>
  (await w.repos.chat.list(w.league.id, DM_ROOM, { limit: 200 })).messages.filter((m) => m.kind === 'agent');

beforeAll(async () => {
  const model = new RecordingModel(questionsModel());
  w = await buildWorld({
    config: { personalityId: 'smug-veteran', difficulty: 'hall_of_famer', archetype: 'balanced' },
    model
  });
  model.clock = w.clock;

  // 1. The opening, answered at once.
  opening = await w.say('hey, got a minute');
  // 2. Two questions inside the cooldown; the deferred reply leaves the first open.
  await w.advance(15_000);
  flex = await w.say(FLEX);
  await w.advance(15_000);
  price = await w.say(PRICE);
  await w.advance(COOLDOWN_MS);
  const reply = (await dmLines()).find((m) => m.replyToId === price.id);
  afterBurst = {
    flex: await answers(w, flex),
    price: await answers(w, price),
    covered: reply?.answersMessageIds
  };
  // 3. An unrelated line of the agent's in the DM.
  await w.repos.chat.put(
    {
      id: 'outreach-1',
      leagueId: w.league.id,
      roomId: DM_ROOM,
      kind: 'agent',
      author: { teamId: AGENT_TEAM, teamName: 'Team 2', name: 'Agent' },
      text: 'Still looking for RB help, by the way.',
      mentionedTeamIds: [],
      event: null,
      createdAt: w.clock.now().toISOString()
    },
    { dmTeamIds: ['team-1', AGENT_TEAM] }
  );
  // 4. The check-in hands the open question on; then everything again.
  await w.advance(SOCIAL_ACT_LIMITS.questionGraceMs);
  await w.checkIn('afternoon');
  await w.advance(4 * 3_600_000);
  afterCheckIn = { flex: await answers(w, flex), price: await answers(w, price) };
  linesBeforeReplays = (await dmLines()).length;
  for (const r of w.requests().filter((q) => q.kind === 'chat_reply')) await w.rerun(r);
  linesAfterReplays = (await dmLines()).length;
}, 60_000);

describe('explicit question resolution (#215)', () => {
  it('answers the opening at once and the newest question of the burst in one deferred reply', async () => {
    expect(await answers(w, opening)).toHaveLength(1);
    expect(afterBurst.price).toEqual(['A starter for WR2. Flex later.']);
    // The question it left open is not named as answered.
    expect(afterBurst.flex).toEqual([]);
    expect(afterBurst.covered).toBeUndefined();
  });

  it('hands the open question on at a check-in, past the agent’s unrelated DM line', () => {
    expect(afterCheckIn.flex).toEqual(['Answered, Allen.']);
    expect(afterCheckIn.price).toHaveLength(1);
  });

  it('answers nothing twice when every reply task is delivered again', () => {
    expect(linesAfterReplays).toBe(linesBeforeReplays);
  });
});
