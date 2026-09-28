import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { waiverHitRate, waiverPickupOutcome, type MoveLookups } from './moves.js';

const POINTS: Record<string, Record<number, number>> = {
  add: { 5: 12, 6: 20.5, 7: 3 },
  drop: { 5: 10, 6: 8, 7: 30 }
};
// team-1 rosters `add` in weeks 5 and 6, then drops him.
const lookups: MoveLookups = {
  rostered: (teamId, playerId, week) => teamId === 'team-1' && playerId === 'add' && week <= 6,
  points: (playerId, week) => POINTS[playerId]?.[week] ?? 0
};

describe('waiverPickupOutcome', () => {
  it('compares the pickup with the dropped player over the weeks he was rostered', () => {
    const outcome = waiverPickupOutcome(
      { teamId: 'team-1', week: 5, addPlayerId: 'add', dropPlayerId: 'drop' },
      7,
      lookups
    );
    expect(outcome).toMatchObject({
      weeks: [5, 6],
      addedPoints: 32.5,
      droppedPoints: 18,
      netPoints: 14.5,
      hit: true
    });
  });

  it('counts a pickup without a drop against zero, and a pickup never rostered as no hit', () => {
    const open = waiverPickupOutcome(
      { teamId: 'team-1', week: 6, addPlayerId: 'add', dropPlayerId: null },
      7,
      lookups
    );
    expect(open).toMatchObject({ weeks: [6], addedPoints: 20.5, droppedPoints: 0, hit: true });
    const gone = waiverPickupOutcome(
      { teamId: 'team-2', week: 5, addPlayerId: 'add', dropPlayerId: 'drop' },
      7,
      lookups
    );
    expect(gone).toMatchObject({ weeks: [], addedPoints: 0, hit: false });
    const swapped = waiverPickupOutcome(
      { teamId: 'team-1', week: 5, addPlayerId: 'drop', dropPlayerId: 'add' },
      7,
      { ...lookups, rostered: () => true }
    );
    expect(swapped).toMatchObject({ weeks: [5, 6, 7], addedPoints: 48, droppedPoints: 35.5, hit: true });
  });
});

describe('waiverHitRate', () => {
  it('rolls up judged pickups only', () => {
    const outcomes = [
      waiverPickupOutcome(
        { teamId: 'team-1', week: 5, addPlayerId: 'add', dropPlayerId: 'drop' },
        7,
        lookups
      ),
      waiverPickupOutcome({ teamId: 'team-1', week: 5, addPlayerId: 'add', dropPlayerId: null }, 4, lookups),
      waiverPickupOutcome({ teamId: 'team-1', week: 7, addPlayerId: 'add', dropPlayerId: 'drop' }, 7, {
        ...lookups,
        rostered: () => true
      })
    ];
    expect(waiverHitRate(outcomes)).toEqual({ claims: 2, hits: 1, hitRate: 0.5, netPoints: -12.5 });
    expect(waiverHitRate([])).toEqual({ claims: 0, hits: 0, hitRate: null, netPoints: 0 });
  });

  it('keeps hits within claims and the rate between 0 and 1', () => {
    const pickup = fc.record({
      week: fc.integer({ min: 1, max: 17 }),
      through: fc.integer({ min: 0, max: 17 }),
      withDrop: fc.boolean(),
      rostered: fc.array(fc.boolean(), { minLength: 18, maxLength: 18 }),
      added: fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 18, maxLength: 18 }),
      dropped: fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 18, maxLength: 18 })
    });
    fc.assert(
      fc.property(fc.array(pickup, { maxLength: 8 }), (pickups) => {
        const outcomes = pickups.map((p) =>
          waiverPickupOutcome(
            { teamId: 't', week: p.week, addPlayerId: 'a', dropPlayerId: p.withDrop ? 'd' : null },
            p.through,
            {
              rostered: (_t, _p, w) => p.rostered[w] === true,
              points: (id, w) => (id === 'a' ? p.added : p.dropped)[w] ?? 0
            }
          )
        );
        outcomes.forEach((o, i) => {
          const through = pickups[i]?.through ?? 0;
          expect(o.weeks.every((w) => w >= o.week && w <= through)).toBe(true);
          expect(o.hit).toBe(o.weeks.length > 0 && o.addedPoints > o.droppedPoints);
        });
        const rate = waiverHitRate(outcomes);
        expect(rate.hits).toBeLessThanOrEqual(rate.claims);
        if (rate.hitRate !== null) {
          expect(rate.hitRate).toBeGreaterThanOrEqual(0);
          expect(rate.hitRate).toBeLessThanOrEqual(1);
        } else expect(rate.claims).toBe(0);
      })
    );
  });
});
