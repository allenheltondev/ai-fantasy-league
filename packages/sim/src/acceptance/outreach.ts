import type { AgentSeatConfig, AgendaGoal, Commitment, SocialActEntry } from '@fantasy/core';
import type { ModelClient } from '@fantasy/agents';
import type { ChatMessage, TradeRecord } from '@fantasy/server';
import { RecordingModel } from '../scenarios/recording-model.js';
import { acceptanceModel, commitmentFor, goals } from './trade-interest.js';
import {
  AGENT_TEAM,
  DM_ROOM,
  HOUR,
  PERSON_TEAM,
  buildWorld,
  playerName,
  type AcceptanceWorld
} from './world.js';

/**
 * Agent-initiated, goal-tied outreach (#247), end to end through the real runtime on the simulated
 * clock. Unlike the pitch scenario, nobody says anything first:
 *
 * 1. The agent's RB1 is ruled out: its check-ins keep one RB goal (#214).
 * 2. On a board turn, a check-in picks a person whose bench back would fill it and asks them in their
 *    DM, one question, linked to the goal (#218 `ask_relevant_question`).
 * 3. The person answers with a swap; the reply reads it as the answer, and the takeaway becomes a
 *    commitment (#215) whose look decides.
 * 4. The person accepts an offer if one came, the review runs out, and the RB goal closes.
 * 5. Check-ins go on: no further outreach for that goal. (Trading the flex receiver opens a flex
 *    goal of its own; a question for it, if any, is a new exchange, reported apart.)
 */

export interface OutreachRun {
  config: AgentSeatConfig;
  goalAfterInjury: AgendaGoal | null;
  /** The agent's first DM line, if it reached out; and whether anyone had written there before. */
  question: ChatMessage | null;
  quietBefore: boolean;
  ask: SocialActEntry | null;
  answer: ChatMessage | null;
  commitment: Commitment | null;
  trades: TradeRecord[];
  goalsAtEnd: AgendaGoal[];
  /** When the question's goal closed (null if it never did). */
  closedAt: string | null;
  /** Questions posted for the question's goal, in all (one, never chased). */
  asksForGoal: SocialActEntry[];
  /** Questions posted after that goal closed, for any goal. */
  asksAfterClose: SocialActEntry[];
  dm: ChatMessage[];
}

const SLOTS = ['morning', 'afternoon', 'evening'] as const;

async function tenure(w: AcceptanceWorld): Promise<string> {
  const team = await w.repos.teams.get(w.league.id, AGENT_TEAM);
  /* v8 ignore next -- the world created the team */
  return team?.occupiedSince ?? team?.createdAt ?? '';
}

async function dmLines(w: AcceptanceWorld): Promise<ChatMessage[]> {
  return (await w.repos.chat.list(w.league.id, DM_ROOM, { limit: 200 })).messages.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
}

async function asks(w: AcceptanceWorld): Promise<SocialActEntry[]> {
  return (await w.repos.agents.getSocialActs(w.league.id, w.agentId, await tenure(w))).acts.filter(
    (a) => a.act === 'ask_relevant_question'
  );
}

/**
 * The swap the person answers with: their spare back for the agent's flex receiver. Fair enough
 * both ways for the value math, so the look sends it (a spare quarterback or kicker for a starting
 * back is lopsided; a starting receiver leaves the WR slots short).
 */
export const OUTREACH_SWAP = { send: 'wr4', receive: 'p-rb3' } as const;

export async function runOutreachScenario(
  config: AgentSeatConfig,
  inner: ModelClient = acceptanceModel(),
  swap: { send: string; receive: string } = OUTREACH_SWAP
): Promise<OutreachRun> {
  const model = new RecordingModel(inner);
  const w = await buildWorld({ config, model });
  model.clock = w.clock;

  // 1. The injury.
  await w.advance(HOUR);
  await w.injure(['rb1'], 'Out');

  // 2. Check-ins until the agent reaches out (at most three days).
  let question: ChatMessage | null = null;
  for (let i = 0; i < 9 && question === null; i++) {
    await w.checkIn(SLOTS[i % 3] as (typeof SLOTS)[number]);
    question = (await dmLines(w)).find((m) => m.kind === 'agent') ?? null;
    await w.advance(5 * HOUR);
  }
  const goalAfterInjury = (await goals(w)).find((g) => g.status === 'active') ?? null;
  const quietBefore =
    question !== null &&
    (await dmLines(w)).every((m) => m.kind === 'agent' || m.createdAt > question.createdAt);

  // 3. The person answers, with a swap.
  const answer =
    question === null
      ? null
      : await w.say(
          `Could be. Would you trade your ${playerName(swap.send)} for my ${playerName(swap.receive)}?`
        );
  const commitment = answer === null ? null : await commitmentFor(w, answer);

  // 4. An offer, if one came, is accepted; the days go by until the goal closes.
  const offered =
    commitment === null ? null : ((await commitmentFor(w, answer as ChatMessage))?.tradeId ?? null);
  if (offered !== null)
    await w.attempt('respond_to_trade', { tradeId: offered, teamId: PERSON_TEAM, response: 'accept' });
  const goalId = goalAfterInjury?.id ?? null;
  let closedAt: string | null = null;
  for (let day = 0; day < 5; day++)
    for (const slot of SLOTS) {
      await w.advance(slot === 'morning' ? 14 * HOUR : 5 * HOUR);
      await w.checkIn(slot);
      const goal = (await goals(w)).find((g) => g.id === goalId);
      if (closedAt === null && goal !== undefined && goal.status !== 'active')
        closedAt = w.clock.now().toISOString();
    }

  const dm = await dmLines(w);
  const posted = (await asks(w)).filter((a) => a.messageId !== undefined);
  const ask = posted[0] ?? null;
  return {
    config,
    goalAfterInjury,
    question,
    quietBefore,
    ask,
    answer,
    commitment: answer === null ? null : await commitmentFor(w, answer),
    trades: await w.repos.trades.list(w.league.id),
    goalsAtEnd: await goals(w),
    closedAt,
    asksForGoal: posted.filter((a) => a.agendaId === goalId),
    asksAfterClose: closedAt === null ? [] : posted.filter((a) => a.at > (closedAt as string)),
    dm
  };
}
