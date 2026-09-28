import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_GRADES,
  draftGrade,
  draftRecap,
  formatDraftRecap,
  notablePick,
  RECAP_REASON_MAX,
  RECAP_TOP,
  valueMargin,
  type RecapPick
} from './recap.js';

const base = { overall: 20, round: 3, adp: 20, position: 'RB' as const, byAgent: false, teamCount: 8 };

describe('notablePick', () => {
  it('flags a player who fell well past his ADP as a steal and one taken well ahead as a reach', () => {
    // At pick 20 of an 8-team draft the margin is max(8, 8) = 8.
    expect(valueMargin(20, 8)).toBe(8);
    expect(notablePick({ ...base, adp: 12 })).toBe('steal');
    expect(notablePick({ ...base, adp: 13 })).toBeNull();
    expect(notablePick({ ...base, adp: 28 })).toBe('reach');
    expect(notablePick({ ...base, adp: 27 })).toBeNull();
  });

  it('needs a wider gap later in the draft', () => {
    expect(valueMargin(100, 8)).toBe(40);
    expect(notablePick({ ...base, overall: 100, round: 13, adp: 70 })).toBeNull();
    expect(notablePick({ ...base, overall: 100, round: 13, adp: 60 })).toBe('steal');
  });

  it('never rates kickers, defenses, or unranked players by value', () => {
    expect(notablePick({ ...base, position: 'K', adp: 200 })).toBeNull();
    expect(notablePick({ ...base, position: 'DEF', adp: 1 })).toBeNull();
    expect(notablePick({ ...base, adp: null })).toBeNull();
  });

  it("flags an agent's first-round pick, unless it is a steal or reach", () => {
    expect(notablePick({ ...base, overall: 3, round: 1, adp: 3, byAgent: true })).toBe('first_round');
    expect(notablePick({ ...base, overall: 3, round: 1, adp: 3, byAgent: false })).toBeNull();
    expect(notablePick({ ...base, overall: 3, round: 1, adp: 30, byAgent: true })).toBe('reach');
    expect(notablePick({ ...base, overall: 9, round: 2, adp: 9, byAgent: true })).toBeNull();
  });

  it('is never both a steal and a reach, and a pick at ADP is never either', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 300 }),
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 4, max: 16 }),
        (overall, adp, teamCount) => {
          const kind = notablePick({ ...base, overall, round: 2, adp, teamCount });
          if (kind === 'steal') expect(overall - adp).toBeGreaterThanOrEqual(teamCount);
          if (kind === 'reach') expect(adp - overall).toBeGreaterThanOrEqual(teamCount);
          expect(notablePick({ ...base, overall, round: 2, adp: overall, teamCount })).toBeNull();
        }
      )
    );
  });
});

const pick = (
  overall: number,
  teamId: string,
  adp: number | null,
  extra: Partial<RecapPick> = {}
): RecapPick => ({
  overall,
  round: Math.ceil(overall / 4),
  teamId,
  playerId: `p${overall}`,
  position: 'WR',
  adp,
  reason: null,
  byAgent: false,
  ...extra
});

describe('draftRecap', () => {
  const picks = [
    pick(1, 't1', 1),
    pick(2, 't2', 2, { byAgent: true, reason: 'Best back on the board.' }),
    pick(3, 't3', 3, { byAgent: true }),
    pick(6, 't2', 6, { byAgent: true, reason: 'A later pick.' }),
    pick(20, 't1', 5),
    pick(21, 't1', 9),
    pick(22, 't2', 60),
    pick(23, 't3', 2),
    pick(24, 't4', 1),
    pick(25, 't4', 70)
  ];

  it('lists the biggest steals and reaches and each agent team first pick with its reasoning', () => {
    const recap = draftRecap([...picks].reverse(), 4);
    expect(recap.picks).toBe(10);
    expect(recap.steals.map((e) => [e.overall, e.value])).toEqual([
      [24, 23],
      [23, 21],
      [20, 15]
    ]);
    expect(recap.steals).toHaveLength(RECAP_TOP);
    expect(recap.reaches.map((e) => [e.overall, e.value])).toEqual([
      [25, -45],
      [22, -38]
    ]);
    expect(recap.agentPicks.map((e) => [e.teamId, e.overall, e.reason])).toEqual([
      ['t2', 2, 'Best back on the board.'],
      ['t3', 3, null]
    ]);
  });

  it('reads as one chat line, clipping long reasoning', () => {
    const long = 'x'.repeat(RECAP_REASON_MAX + 20);
    const recap = draftRecap([pick(1, 't1', 1, { byAgent: true, reason: long }), pick(9, 't2', 1)], 4);
    const text = formatDraftRecap(recap, { team: (id) => id.toUpperCase(), player: (id) => `Player ${id}` });
    expect(text).toContain('Draft recap: 2 picks.');
    expect(text).toContain('Steals: T2 took Player p9 at pick 9 (ADP 1).');
    expect(text).toContain(`T1 took Player p1 at pick 1: "${'x'.repeat(RECAP_REASON_MAX - 1)}…"`);
    expect(text).not.toContain('Reaches');
    const quiet = formatDraftRecap(draftRecap([pick(5, 't1', null, { byAgent: true })], 4), {
      team: (id) => id,
      player: (id) => id
    });
    expect(quiet).toBe('Draft recap: 1 pick. t1 took p5 at pick 5.');
  });
});

describe('draftGrade', () => {
  const graded = (overall: number, adp: number | null, position: 'RB' | 'K' = 'RB') => ({
    overall,
    adp,
    position
  });

  it('grades a draft of steals high and a draft of reaches low', () => {
    // 8 teams: at picks 10 and 30 the steal margins are 8 and 12.
    expect(draftGrade([graded(10, 2), graded(30, 18)], 8)).toBe('A');
    expect(draftGrade([graded(10, 10), graded(30, 30)], 8)).toBe('C');
    expect(draftGrade([graded(10, 18), graded(30, 42)], 8)).toBe('F');
    expect(draftGrade([graded(10, 9), graded(30, 28)], 8)).toBe('B');
    expect(draftGrade([graded(10, 12), graded(30, 33)], 8)).toBe('D');
  });

  it('leaves kickers, defenses, and unranked players out, and caps one wild pick', () => {
    expect(draftGrade([graded(100, 1, 'K'), graded(20, null)], 8)).toBeNull();
    expect(draftGrade([], 8)).toBeNull();
    // A 150-pick steal counts as two steals, not twelve.
    expect(draftGrade([graded(160, 10), graded(10, 18), graded(20, 28)], 8)).toBe('C');
  });

  it('never grades a team lower when one of its picks came cheaper (property)', () => {
    const rank = (g: string | null) => DRAFT_GRADES.indexOf(g as (typeof DRAFT_GRADES)[number]);
    const pickArb = fc.record({
      overall: fc.integer({ min: 1, max: 200 }),
      adp: fc.integer({ min: 1, max: 300 })
    });
    fc.assert(
      fc.property(fc.array(pickArb, { minLength: 1, maxLength: 16 }), fc.nat({ max: 50 }), (picks, gain) => {
        const all = picks.map((p) => graded(p.overall, p.adp));
        const [first, ...rest] = all as [ReturnType<typeof graded>, ...ReturnType<typeof graded>[]];
        const cheaper = [{ ...first, adp: Math.max(1, (first.adp as number) - gain) }, ...rest];
        expect(DRAFT_GRADES).toContain(draftGrade(all, 10));
        expect(rank(draftGrade(cheaper, 10))).toBeLessThanOrEqual(rank(draftGrade(all, 10)));
      })
    );
  });
});
