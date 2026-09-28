import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AgentLeagueMemorySchema,
  MEMORY_LIMITS,
  emptyMemory,
  estimateTokens,
  rememberEvent,
  summarizeMemory,
  type MemoryEvent
} from './memory.js';

const AT = '2026-10-12T12:00:00.000Z';

describe('agent league memory', () => {
  it('parses stored memory written before the structured fields existed', () => {
    expect(AgentLeagueMemorySchema.parse({ notes: ['old note'] })).toEqual({
      ...emptyMemory(),
      notes: ['old note']
    });
  });

  it('builds grudges from matchup results, trades, and keeps the biggest first', () => {
    let m = emptyMemory();
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-3',
      week: 1,
      pointsFor: 80,
      pointsAgainst: 120,
      at: AT
    });
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-4',
      week: 2,
      pointsFor: 100,
      pointsAgainst: 90,
      at: AT
    });
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-5',
      week: 3,
      pointsFor: 90,
      pointsAgainst: 95,
      at: AT
    });
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-6',
      week: 4,
      pointsFor: 90,
      pointsAgainst: 90,
      at: AT
    });
    expect(m.rivals.map((r) => [r.teamId, r.grudge])).toEqual([
      ['team-3', 3],
      ['team-5', 2],
      ['team-4', 1],
      ['team-6', 1]
    ]);
    expect(m.rivals[0]?.reason).toBe('Week 1: lost to them 80-120.');
    expect(m.rivals.find((r) => r.teamId === 'team-6')?.reason).toContain('tied');

    m = rememberEvent(m, {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't1',
      outcome: 'proposed',
      summary: 'Asked for their WR1.',
      at: AT
    });
    expect(m.rivals.find((r) => r.teamId === 'team-4')?.grudge).toBe(1);
    m = rememberEvent(m, {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't1',
      outcome: 'vetoed',
      summary: 'League vetoed it.',
      at: AT
    });
    expect(m.trades).toEqual([expect.objectContaining({ tradeId: 't1', outcome: 'vetoed' })]);
    expect(m.rivals.find((r) => r.teamId === 'team-4')?.grudge).toBe(3);
  });

  it('keeps notes, decisions, and the chat snapshot bounded and clipped', () => {
    let m = emptyMemory();
    for (let i = 0; i < 30; i++) {
      m = rememberEvent(m, { type: 'note', text: `note ${i}` });
      m = rememberEvent(m, {
        type: 'decision',
        kind: 'lineup',
        action: 'set_lineup',
        summary: `d${i}`,
        at: AT
      });
    }
    m = rememberEvent(m, { type: 'note', text: '   ' });
    expect(m.notes).toHaveLength(MEMORY_LIMITS.notes);
    expect(m.notes.at(-1)).toBe('note 29');
    expect(m.decisions).toHaveLength(MEMORY_LIMITS.decisions);
    const long = 'x'.repeat(1000);
    m = rememberEvent(m, {
      type: 'chat',
      messages: Array.from({ length: 12 }, (_, i) => ({
        author: `A${i}`,
        text: i === 11 ? long : 'hi',
        at: AT
      }))
    });
    expect(m.chat).toHaveLength(MEMORY_LIMITS.chat);
    expect(m.chat.at(-1)?.text.length).toBe(MEMORY_LIMITS.text);
    expect(AgentLeagueMemorySchema.safeParse(m).success).toBe(true);
  });

  it('summarizes the most useful memories first, within the token budget', () => {
    let m = emptyMemory();
    m = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'team-3',
      week: 1,
      pointsFor: 80,
      pointsAgainst: 120,
      at: AT
    });
    m = rememberEvent(m, {
      type: 'trade',
      teamId: 'team-4',
      tradeId: 't1',
      outcome: 'processed',
      summary: 'Got their RB.',
      at: AT
    });
    m = rememberEvent(m, { type: 'note', text: 'I like rb3.' });
    m = rememberEvent(m, {
      type: 'decision',
      kind: 'waivers',
      action: 'claim_waiver',
      summary: 'Bid $12 on wr9.',
      at: AT
    });
    m = rememberEvent(m, {
      type: 'chat',
      messages: [{ author: 'Allen', text: 'Your kicker stinks.', at: AT }]
    });
    const names = (id: string) => ({ 'team-3': 'Bench Mob', 'team-4': 'Taco Corp' })[id] ?? id;
    const all = summarizeMemory(m, { teamName: names });
    expect(all).toEqual([
      'Rivalry with Bench Mob (grudge 3): Week 1: lost to them 80-120.',
      'Rivalry with Taco Corp (grudge 1): Trade processed: Got their RB.',
      'Trade with Taco Corp (processed): Got their RB.',
      'Your note: I like rb3.',
      'You did waivers -> claim_waiver: Bid $12 on wr9.',
      'Last chat you were in: Allen: Your kicker stinks.'
    ]);
    const tight = summarizeMemory(m, { tokenBudget: 30 });
    expect(tight.length).toBeLessThan(all.length);
    expect(tight[0]).toContain('team-3');
    expect(summarizeMemory(emptyMemory())).toEqual([]);
  });

  it('never exceeds its budget or its limits (property)', () => {
    const event: fc.Arbitrary<MemoryEvent> = fc.oneof(
      fc.record({ type: fc.constant('note' as const), text: fc.string({ maxLength: 400 }) }),
      fc.record({
        type: fc.constant('decision' as const),
        kind: fc.constantFrom('lineup', 'waivers'),
        action: fc.string({ maxLength: 20 }),
        summary: fc.string({ maxLength: 400 }),
        at: fc.constant(AT)
      }),
      fc.record({
        type: fc.constant('matchup' as const),
        opponentTeamId: fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'),
        week: fc.integer({ min: 1, max: 17 }),
        pointsFor: fc.integer({ min: 0, max: 200 }),
        pointsAgainst: fc.integer({ min: 0, max: 200 }),
        at: fc.constant(AT)
      }),
      fc.record({
        type: fc.constant('trade' as const),
        teamId: fc.constantFrom('t1', 't2', 't3'),
        tradeId: fc.string({ minLength: 1, maxLength: 4 }),
        outcome: fc.constantFrom('proposed', 'rejected', 'processed', 'vetoed' as const),
        summary: fc.string({ maxLength: 400 }),
        at: fc.constant(AT)
      })
    );
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), fc.integer({ min: 0, max: 600 }), (events, budget) => {
        const m = events.reduce(rememberEvent, emptyMemory());
        expect(AgentLeagueMemorySchema.safeParse(m).success).toBe(true);
        expect(m.rivals.length).toBeLessThanOrEqual(MEMORY_LIMITS.rivals);
        expect(m.trades.length).toBeLessThanOrEqual(MEMORY_LIMITS.trades);
        const lines = summarizeMemory(m, { tokenBudget: budget });
        expect(lines.reduce((sum, l) => sum + estimateTokens(l) + 1, 0)).toBeLessThanOrEqual(budget);
      })
    );
  });
});
