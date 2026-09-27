import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Position } from '../rules/positions.js';
import { yahooDefaultSettings } from '../rules/settings.js';
import { autopick, unfilledStarterSlots, type DraftablePlayer } from './autopick.js';
import {
  createDraft,
  currentPick,
  deadlineFor,
  draftOrder,
  draftRoundsFor,
  isComplete,
  makePick,
  pickSlot,
  picksUntilTurn,
  type DraftConfig,
  type DraftState
} from './draft.js';

function draft(config: Partial<DraftConfig> = {}): DraftState {
  const r = createDraft({ teamIds: ['a', 'b', 'c'], rounds: 3, pickSeconds: 60, ...config });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function pick(d: DraftState, teamId: string, playerId: string, positions: Position[] = ['WR'], now?: string) {
  const r = makePick(d, teamId, playerId, { positions, now });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.draft;
}

function codeOf(r: ReturnType<typeof makePick>): string | undefined {
  return r.ok ? undefined : r.issues[0]!.code;
}

describe('createDraft', () => {
  it('uses one round per active roster spot', () => {
    expect(draftRoundsFor(yahooDefaultSettings(8))).toBe(16);
  });

  it('rejects bad configurations', () => {
    const codes = (c: DraftConfig) => {
      const r = createDraft(c);
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    expect(codes({ teamIds: ['a'], rounds: 0, pickSeconds: 0 })).toEqual([
      'DRAFT_TOO_FEW_TEAMS',
      'DRAFT_INVALID_ROUNDS',
      'DRAFT_INVALID_PICK_TIME'
    ]);
    expect(codes({ teamIds: ['a', 'a'], rounds: 1, pickSeconds: 30 })).toEqual(['DRAFT_INVALID_TEAMS']);
  });
});

describe('snake order', () => {
  it('reverses every other round', () => {
    const d = draft();
    expect(draftOrder(d).map((s) => s.teamId)).toEqual(['a', 'b', 'c', 'c', 'b', 'a', 'a', 'b', 'c']);
    expect(pickSlot(d, 4)).toEqual({ overall: 4, round: 2, pick: 1, teamId: 'c' });
    expect(pickSlot(d, 0)).toBeNull();
    expect(pickSlot(d, 10)).toBeNull();
  });

  it('honours traded picks (future hook)', () => {
    const d = draft({ tradedPicks: [{ round: 2, originalTeamId: 'a', ownerTeamId: 'c' }] });
    expect(draftOrder(d).map((s) => s.teamId)).toEqual(['a', 'b', 'c', 'c', 'b', 'c', 'a', 'b', 'c']);
  });
});

describe('makePick', () => {
  it('records picks and advances the clock', () => {
    let d = draft();
    expect(currentPick(d)).toEqual({ overall: 1, round: 1, pick: 1, teamId: 'a' });
    const r = makePick(d, 'a', 'p1', {
      positions: ['RB'],
      now: new Date('2026-09-01T00:00:00Z'),
      auto: true
    });
    expect(r.ok && r.value.pick).toEqual({
      overall: 1,
      round: 1,
      pick: 1,
      teamId: 'a',
      playerId: 'p1',
      positions: ['RB'],
      madeAt: '2026-09-01T00:00:00.000Z',
      auto: true
    });
    expect(d.picks).toHaveLength(0);
    d = r.ok ? r.value.draft : d;
    expect(currentPick(d)?.teamId).toBe('b');
  });

  it('rejects out-of-turn picks with the number of picks to wait', () => {
    const d = draft();
    const r = makePick(d, 'c', 'p1');
    expect(codeOf(r)).toBe('NOT_YOUR_TURN');
    expect(!r.ok && r.issues[0]!.details).toEqual({ onTheClock: 'a', picksUntilYourTurn: 2 });
    expect(!r.ok && r.issues[0]!.fix).toMatch(/Wait 2 more pick/);
    const outsider = makePick(d, 'z', 'p1');
    expect(!r.ok && !outsider.ok && outsider.issues[0]!.fix).toMatch(/no picks left/);
  });

  it('rejects a player already drafted and names who took him', () => {
    const d = pick(draft(), 'a', 'p1');
    const r = makePick(d, 'b', 'p1');
    expect(codeOf(r)).toBe('PLAYER_ALREADY_DRAFTED');
    expect(!r.ok && r.issues[0]!.details).toMatchObject({ draftedBy: 'a', round: 1, pick: 1 });
  });

  it('enforces position maximums when the league sets them', () => {
    let d = draft({ positionLimits: { K: 1 } });
    d = pick(d, 'a', 'k1', ['K']);
    d = pick(d, 'b', 'p2');
    d = pick(d, 'c', 'p3');
    d = pick(d, 'c', 'p4');
    d = pick(d, 'b', 'p5');
    const r = makePick(d, 'a', 'k2', { positions: ['K'] });
    expect(codeOf(r)).toBe('ROSTER_POSITION_LIMIT');
    expect(makePick(d, 'a', 'x', {}).ok).toBe(true);
  });

  it('rejects picks after the draft is complete', () => {
    let d = draft({ teamIds: ['a', 'b'], rounds: 1 });
    d = pick(d, 'a', 'p1');
    d = pick(d, 'b', 'p2');
    expect(isComplete(d)).toBe(true);
    expect(currentPick(d)).toBeNull();
    expect(picksUntilTurn(d, 'a')).toBeNull();
    expect(codeOf(makePick(d, 'a', 'p3'))).toBe('DRAFT_COMPLETE');
  });
});

describe('deadlineFor', () => {
  it('counts from the draft start, then from each pick', () => {
    let d = draft();
    expect(deadlineFor(d, '2026-09-01T00:00:00Z')?.toISOString()).toBe('2026-09-01T00:01:00.000Z');
    d = pick(d, 'a', 'p1', ['WR'], '2026-09-01T00:00:30Z');
    expect(deadlineFor(d, new Date('2026-09-01T00:00:00Z'))?.toISOString()).toBe('2026-09-01T00:01:30.000Z');
    d = pick(d, 'b', 'p2');
    // No time on the previous pick: fall back to the start.
    expect(deadlineFor(d, '2026-09-01T00:00:00Z')?.toISOString()).toBe('2026-09-01T00:01:00.000Z');
    const done = pick(pick(draft({ teamIds: ['a', 'b'], rounds: 1 }), 'a', 'x'), 'b', 'y');
    expect(deadlineFor(done, '2026-09-01T00:00:00Z')).toBeNull();
  });
});

describe('autopick', () => {
  const settings = yahooDefaultSettings(8);
  const pool: DraftablePlayer[] = [
    { playerId: 'k1', positions: ['K'] },
    { playerId: 'rb1', positions: ['RB'] },
    { playerId: 'rb2', positions: ['RB'] },
    { playerId: 'wr1', positions: ['WR'] },
    { playerId: 'def1', positions: ['DEF'] },
    { playerId: 'qb1', positions: ['QB'] }
  ];

  it('takes the best-ranked player who fills a starting slot', () => {
    const d = draft();
    expect(autopick(d, pool, ['k1', 'rb1', 'wr1'], settings)).toEqual({
      playerId: 'k1',
      positions: ['K'],
      reason: 'starter_need'
    });
  });

  it('does not take a second K while starters are open', () => {
    let d = draft({ teamIds: ['a', 'b'], rounds: 4 });
    d = pick(d, 'a', 'k0', ['K']);
    d = pick(d, 'b', 'x1');
    d = pick(d, 'b', 'x2');
    expect(autopick(d, pool, ['k1', 'def1', 'rb1'], settings)?.playerId).toBe('def1');
    expect(autopick(d, pool, { k1: 1, rb1: 2 }, settings)?.playerId).toBe('rb1');
  });

  it('skips drafted players and position maximums, and breaks equal ranks by id', () => {
    let d = draft({ positionLimits: { RB: 1 } });
    d = pick(d, 'a', 'rb1', ['RB']);
    d = pick(d, 'b', 'wr1');
    d = pick(d, 'c', 'qb1', ['QB']);
    d = pick(d, 'c', 'x', ['TE']);
    d = pick(d, 'b', 'y', ['TE']);
    // Team a again: rb2 is at the RB limit; qb1 and wr1 are taken; k1 and def1 are unranked (tie by id).
    expect(autopick(d, pool, ['rb2'], settings)?.playerId).toBe('def1');
  });

  it('falls back to best available once starters are full, or null when nothing fits', () => {
    const tiny = {
      roster: { slots: { QB: 1, BN: 2 }, irEligibleStatuses: [] }
    } as unknown as typeof settings;
    let d = draft({ teamIds: ['a', 'b'], rounds: 3 });
    d = pick(d, 'a', 'qb1', ['QB']);
    d = pick(d, 'b', 'z');
    d = pick(d, 'b', 'zz');
    expect(autopick(d, pool, ['k1'], tiny)).toMatchObject({ playerId: 'k1', reason: 'best_available' });
    expect(autopick(d, [], [], tiny)).toBeNull();
    const done = pick(pick(draft({ teamIds: ['a', 'b'], rounds: 1 }), 'a', 'x'), 'b', 'y');
    expect(autopick(done, pool, [], settings)).toBeNull();
  });

  it('fills specific slots before flex', () => {
    expect(unfilledStarterSlots(settings, [['WR'], ['WR'], ['WR'], ['WR'], ['QB']]).sort()).toEqual(
      ['DEF', 'K', 'RB', 'RB', 'TE'].sort()
    );
    expect(unfilledStarterSlots(settings, [[]])).toHaveLength(10);
  });
});

describe('draft properties', () => {
  const config = fc.record({
    teams: fc.integer({ min: 2, max: 12 }),
    rounds: fc.integer({ min: 1, max: 16 }),
    seed: fc.integer()
  });

  it('a full draft gives every team exactly `rounds` picks, no player twice, in snake order', () => {
    fc.assert(
      fc.property(config, ({ teams, rounds, seed }) => {
        const teamIds = Array.from({ length: teams }, (_, i) => `t${i}`);
        const created = createDraft({ teamIds, rounds, pickSeconds: 30 });
        if (!created.ok) throw new Error('create failed');
        let d = created.value;
        let n = 0;
        const available: DraftablePlayer[] = Array.from({ length: teams * rounds + 5 }, (_, i) => ({
          playerId: `p${(i * 7919 + seed) % 100000}-${i}`,
          positions: [(['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const)[i % 6]!]
        }));
        while (!isComplete(d)) {
          const slot = currentPick(d)!;
          const choice = autopick(d, available, [], yahooDefaultSettings(8))!;
          // Every other team tries to jump the queue first and must be refused.
          const other = teamIds.find((t) => t !== slot.teamId)!;
          expect(makePick(d, other, choice.playerId).ok).toBe(false);
          const r = makePick(d, slot.teamId, choice.playerId, { positions: choice.positions });
          if (!r.ok) throw new Error(JSON.stringify(r.issues));
          d = r.value.draft;
          n++;
        }
        expect(n).toBe(teams * rounds);
        const ids = d.picks.map((p) => p.playerId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const t of teamIds) expect(d.picks.filter((p) => p.teamId === t)).toHaveLength(rounds);
        for (const p of d.picks) {
          const idx = teamIds.indexOf(p.teamId);
          expect(p.round % 2 === 1 ? idx : teams - 1 - idx).toBe(p.pick - 1);
          expect(p.overall).toBe((p.round - 1) * teams + p.pick);
        }
      }),
      { numRuns: 50 }
    );
  });
});
