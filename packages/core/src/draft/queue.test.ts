import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Position } from '../rules/positions.js';
import { yahooDefaultSettings } from '../rules/settings.js';
import {
  autopick,
  draftRosterIssue,
  queuedPick,
  type DraftablePlayer,
  type RosterNeeds
} from './autopick.js';
import { createDraft, currentPick, draftRoundsFor, isComplete, makePick, type DraftState } from './draft.js';

const settings = yahooDefaultSettings(4);
/** QB, K, and DEF starters and nothing else: three picks fill the roster. */
const tiny = { roster: { slots: { QB: 1, K: 1, DEF: 1 }, irEligibleStatuses: [] } } as unknown as RosterNeeds;

function draft(rounds = draftRoundsFor(settings), positionLimits: Partial<Record<Position, number>> = {}) {
  const r = createDraft({ teamIds: ['a', 'b', 'c', 'd'], rounds, pickSeconds: 60, positionLimits });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function take(d: DraftState, playerId: string, positions: readonly Position[]): DraftState {
  const slot = currentPick(d);
  if (slot === null) throw new Error('draft over');
  const r = makePick(d, slot.teamId, playerId, { positions });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.draft;
}

const pool: DraftablePlayer[] = [
  { playerId: 'qb1', positions: ['QB'] },
  { playerId: 'qb2', positions: ['QB'] },
  { playerId: 'rb1', positions: ['RB'] },
  { playerId: 'wr1', positions: ['WR'] },
  { playerId: 'k1', positions: ['K'] },
  { playerId: 'def1', positions: ['DEF'] }
];

describe('queuedPick', () => {
  it('takes the first queued player who is still available', () => {
    const d = take(draft(), 'rb1', ['RB']);
    // Team b is on the clock; rb1 is gone and "nobody" is not in the pool, so wr1 is next.
    expect(queuedPick(d, pool, ['rb1', 'nobody', 'wr1', 'qb1'], settings)).toEqual({
      playerId: 'wr1',
      positions: ['WR'],
      reason: 'queued'
    });
    expect(autopick(d, pool, ['qb1'], settings, ['wr1'])?.reason).toBe('queued');
  });

  it('skips a queued player at a position maximum', () => {
    let d = take(draft(draftRoundsFor(settings), { QB: 1 }), 'qb1', ['QB']);
    for (const id of ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7']) d = take(d, id, ['TE']);
    // Team a again: a second QB is over the limit.
    expect(currentPick(d)?.teamId).toBe('a');
    expect(queuedPick(d, pool, ['qb2', 'k1'], settings)?.playerId).toBe('k1');
  });

  it('skips a queued player who would leave a starting slot unfillable', () => {
    let d = take(draft(3), 'qb1', ['QB']);
    for (const id of ['x1', 'x2', 'x3', 'x4', 'x5', 'x6']) d = take(d, id, ['QB']);
    // Team a has 2 picks left with K and DEF open: a second QB would leave one of them empty.
    expect(currentPick(d)?.teamId).toBe('a');
    expect(draftRosterIssue(d, 'a', ['QB'], tiny)).not.toBeNull();
    expect(queuedPick(d, pool, ['qb2', 'def1'], tiny)?.playerId).toBe('def1');
    expect(queuedPick(d, pool, ['qb2'], tiny)).toBeNull();
  });

  it('returns null with an empty queue, no queued fit, or the draft over; autopick then falls back', () => {
    const d = draft();
    expect(queuedPick(d, pool, [], settings)).toBeNull();
    expect(queuedPick(d, pool, ['nobody'], settings)).toBeNull();
    expect(autopick(d, pool, ['rb1'], settings, ['nobody'])).toMatchObject({
      playerId: 'rb1',
      reason: 'starter_need'
    });
    let over = draft(1);
    for (const id of ['p1', 'p2', 'p3', 'p4']) over = take(over, id, ['QB']);
    expect(isComplete(over)).toBe(true);
    expect(queuedPick(over, pool, ['k1'], settings)).toBeNull();
  });
});

describe('queuedPick properties', () => {
  const positions: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const players = fc.uniqueArray(
    fc.record({ id: fc.integer({ min: 0, max: 400 }), pos: fc.constantFrom(...positions) }),
    { minLength: 80, maxLength: 160, selector: (p) => p.id }
  );

  it('a queued pick never makes a roster impossible to complete', () => {
    fc.assert(
      fc.property(players, fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 50 }), (list, queue) => {
        const available: DraftablePlayer[] = list.map((p) => ({ playerId: `p${p.id}`, positions: [p.pos] }));
        const ids = queue.map((q) => `p${q}`);
        let d = draft();
        while (!isComplete(d)) {
          const slot = currentPick(d) as NonNullable<ReturnType<typeof currentPick>>;
          const queued = queuedPick(d, available, ids, settings);
          if (queued !== null) {
            expect(ids).toContain(queued.playerId);
            expect(d.picks.some((p) => p.playerId === queued.playerId)).toBe(false);
            expect(draftRosterIssue(d, slot.teamId, queued.positions, settings)).toBeNull();
          }
          const choice = autopick(d, available, [], settings, ids);
          if (choice === null) return;
          d = take(d, choice.playerId, choice.positions);
        }
      }),
      { numRuns: 60 }
    );
  });
});
