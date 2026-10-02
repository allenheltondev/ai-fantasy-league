import { beforeAll, describe, expect, it } from 'vitest';
import { runOutreachScenario, type OutreachRun } from './outreach.js';

/** Agent-initiated, goal-tied outreach (#247; see outreach.ts for the story). */

let run: OutreachRun;

beforeAll(async () => {
  run = await runOutreachScenario({ personalityId: 'hype-man', difficulty: 'pro', archetype: 'trade_happy' });
}, 120_000);

describe('autonomous goal-tied outreach (#247)', () => {
  it('opens the conversation itself, with one question tied to its RB goal', () => {
    expect(run.goalAfterInjury).toMatchObject({ kind: 'repair_position', slot: 'RB', status: 'active' });
    expect(run.question?.text).toMatch(/Would you move him\?$/);
    // Nobody had written in the DM before the agent did.
    expect(run.quietBefore).toBe(true);
    expect(run.ask).toMatchObject({
      reason: 'need_partner',
      agendaId: run.goalAfterInjury?.id,
      expects: 'trade_interest',
      messageId: run.question?.id
    });
  });

  it('reads the answer into the same exchange, and the look it leads to decides', () => {
    expect(run.ask).toMatchObject({ outcome: 'answered', answerId: run.answer?.id });
    expect(run.commitment).toMatchObject({
      source: { messageId: run.answer?.id, visibility: 'dm' },
      agendaId: run.goalAfterInjury?.id,
      intent: { send: ['wr4'], receive: ['p-rb3'] }
    });
  });

  it('closes the goal once the need is met, and stops reaching out for it', () => {
    expect(run.commitment).toMatchObject({ status: 'fulfilled', decision: { reason: 'partner_accepted' } });
    expect(run.trades.map((t) => t.trade.status)).toEqual(['processed']);
    expect(run.goalsAtEnd.find((g) => g.id === run.goalAfterInjury?.id)?.status).toBe('completed');
    expect(run.closedAt).not.toBeNull();
    // One question for the goal, never chased, and none once it closed.
    expect(run.asksForGoal).toHaveLength(1);
    expect(run.asksAfterClose.filter((a) => a.agendaId === run.goalAfterInjury?.id)).toEqual([]);
  });
});
