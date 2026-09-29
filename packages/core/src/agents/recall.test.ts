import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { emptyMemory, estimateTokens, rememberEvent, type MemoryEvent } from './memory.js';
import { CHAT_RESERVE_SHARE, summarizeMemory } from './recall.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-13T12:00:00.000Z');
const on = (days: number) => new Date(T0 + days * DAY).toISOString();
const cost = (lines: readonly string[]) => lines.reduce((sum, l) => sum + estimateTokens(l) + 1, 0);

const note = (text: string, days: number): MemoryEvent => ({ type: 'note', text, at: on(days) });

describe('recall (#210)', () => {
  it('skips an entry too big for a tight budget and keeps recalling the rest', () => {
    let m = emptyMemory();
    // The newest (so highest scoring) note is huge; the older ones are short and still useful.
    m = rememberEvent(m, note('Bench Mob always overpays for tight ends.', 0));
    m = rememberEvent(m, note('Keep an eye on rb3.', 1));
    m = rememberEvent(m, note('x'.repeat(270), 2));
    const lines = summarizeMemory(m, { tokenBudget: 50, now: on(2) });
    expect(lines.some((l) => l.includes('xxxx'))).toBe(false);
    expect(lines).toEqual([
      'Your own note (a belief, written 2026-09-14): Keep an eye on rb3.',
      'Your own note (a belief, written 2026-09-13): Bench Mob always overpays for tight ends.'
    ]);
    expect(cost(lines)).toBeLessThanOrEqual(50);
  });

  it('recalls what it has with the current counterpart first', () => {
    let m = emptyMemory();
    for (const [i, team] of ['a', 'b', 'c', 'd', 'e', 'f'].entries()) {
      m = rememberEvent(m, {
        type: 'trade',
        teamId: team,
        tradeId: `t-${team}`,
        outcome: 'rejected',
        direction: 'incoming',
        summary: `An offer from ${team} was rejected.`,
        at: on(10 + i)
      });
    }
    // The oldest memory in the list, but about the team this task deals with.
    m = rememberEvent(m, {
      type: 'relationship',
      teamId: 'a',
      note: 'Allen trash talks but deals fair.',
      at: on(0)
    });
    const focus = { role: 'chat' as const, kind: 'chat_reply', teamIds: ['a'] };
    const lines = summarizeMemory(m, { tokenBudget: 60, now: on(16), focus });
    expect(lines[0]).toBe('Trade with a (rejected; record): An offer from a was rejected.');
    // The chat line about them predates the latest record with them, and says so.
    expect(lines[1]).toBe(
      'Your read on a (a belief from chat, 2026-09-13; written before your latest record with them): Allen trash talks but deals fair.'
    );
    // Without the focus, the newest trades win the budget instead.
    const unfocused = summarizeMemory(m, { tokenBudget: 60, now: on(16) });
    expect(unfocused[0]).toContain('Trade with f');
    expect(unfocused.join('\n')).not.toContain('Allen trash talks');
  });

  it('puts its own decisions of the same kind and trade history first for the matching task', () => {
    let m = emptyMemory();
    m = rememberEvent(m, {
      type: 'decision',
      kind: 'lineup',
      action: 'set_lineup',
      summary: 'Benched rb2.',
      at: on(5)
    });
    m = rememberEvent(m, {
      type: 'decision',
      kind: 'waivers',
      action: 'claim',
      summary: 'Bid $3 on k1.',
      at: on(1)
    });
    const waivers = summarizeMemory(m, { now: on(5), focus: { role: 'decision', kind: 'waivers' } });
    expect(waivers[0]).toContain('Bid $3 on k1.');
    const lineup = summarizeMemory(m, { now: on(5), focus: { role: 'decision', kind: 'lineup' } });
    expect(lineup[0]).toContain('Benched rb2.');
  });

  it('keeps room for the recent conversation in a chat task, newest messages first', () => {
    let m = emptyMemory();
    for (let i = 0; i < 12; i++) m = rememberEvent(m, note(`note number ${i} with some length to it`, i));
    m = rememberEvent(m, {
      type: 'chat',
      roomId: 'r',
      at: on(12),
      messages: Array.from({ length: 8 }, (_, i) => ({
        author: `P${i}`,
        text: `message ${i} `.repeat(4),
        at: on(12)
      }))
    });
    const budget = 120;
    const lines = summarizeMemory(m, { tokenBudget: budget, now: on(12), focus: { role: 'chat' } });
    const chat = lines.at(-1) ?? '';
    expect(chat).toMatch(/^Recent conversation here/);
    expect(chat).toContain('P7: message 7');
    expect(chat).not.toContain('P0:');
    expect(estimateTokens(chat) + 1).toBeLessThanOrEqual(Math.floor(budget * CHAT_RESERVE_SHARE));
    expect(lines.length).toBeGreaterThan(1);
    expect(cost(lines)).toBeLessThanOrEqual(budget);
    // A decision task never gets it, even if a snapshot slipped through.
    expect(summarizeMemory(m, { tokenBudget: budget, focus: { role: 'decision' } }).join('\n')).not.toContain(
      'Recent conversation'
    );
    // A message longer than the reserve leaves the conversation out rather than blowing the budget.
    const huge = rememberEvent(emptyMemory(), {
      type: 'chat',
      roomId: 'r',
      at: on(0),
      messages: [{ author: 'P', text: 'y'.repeat(280), at: on(0) }]
    });
    expect(summarizeMemory(huge, { tokenBudget: 40, focus: { role: 'chat' } })).toEqual([]);
  });

  it('never exceeds its budget and replays the same (property)', () => {
    const event: fc.Arbitrary<MemoryEvent> = fc.oneof(
      fc.tuple(fc.string({ maxLength: 300 }), fc.integer({ min: 0, max: 60 })).map(([t, d]) => note(t, d)),
      fc
        .tuple(
          fc.constantFrom('a', 'b', 'c'),
          fc.integer({ min: 1, max: 17 }),
          fc.integer({ min: 0, max: 60 })
        )
        .map(([t, w, d]) => ({
          type: 'matchup' as const,
          opponentTeamId: t,
          week: w,
          pointsFor: 100,
          pointsAgainst: 90 + w,
          at: on(d)
        })),
      fc
        .tuple(fc.constantFrom('a', 'b', 'c'), fc.string({ maxLength: 200 }), fc.integer({ min: 0, max: 60 }))
        .map(([t, n, d]) => ({ type: 'relationship' as const, teamId: t, note: n, at: on(d) }))
    );
    fc.assert(
      fc.property(
        fc.array(event, { maxLength: 30 }),
        fc.integer({ min: 0, max: 500 }),
        fc.subarray(['a', 'b', 'c']),
        (events, budget, teamIds) => {
          const m = events.reduce(rememberEvent, emptyMemory());
          const options = { tokenBudget: budget, now: on(70), focus: { role: 'chat' as const, teamIds } };
          const lines = summarizeMemory(m, options);
          expect(cost(lines)).toBeLessThanOrEqual(budget);
          expect(summarizeMemory(events.reduce(rememberEvent, emptyMemory()), options)).toEqual(lines);
        }
      )
    );
  });
});
