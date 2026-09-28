import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { suggestFaabBid } from './bid.js';
import { nextWaiverRun, waiverRunAtOrAfter, waiverRunId } from './schedule.js';

describe('suggestFaabBid', () => {
  it('scales with the gain and the archetype aggressiveness', () => {
    expect(suggestFaabBid({ gain: 10, faabRemaining: 100, aggressiveness: 0.5 })).toBe(40);
    expect(suggestFaabBid({ gain: 10, faabRemaining: 100, aggressiveness: 1 })).toBe(60);
    expect(suggestFaabBid({ gain: 5, faabRemaining: 100, aggressiveness: 0 })).toBe(10);
    expect(suggestFaabBid({ gain: 50, faabRemaining: 100, aggressiveness: 0 })).toBe(20);
  });

  it('bids the minimum for no gain, and never more than the budget', () => {
    expect(suggestFaabBid({ gain: 0, faabRemaining: 100, aggressiveness: 1 })).toBe(0);
    expect(suggestFaabBid({ gain: -3, faabRemaining: 100, aggressiveness: 1, minBid: 1 })).toBe(1);
    expect(suggestFaabBid({ gain: 1, faabRemaining: 0, aggressiveness: 1, minBid: 1 })).toBe(0);
    expect(suggestFaabBid({ gain: Number.NaN, faabRemaining: 10, aggressiveness: 1 })).toBe(0);
    expect(suggestFaabBid({ gain: 4, faabRemaining: 100, aggressiveness: 0.5, noise: 0.5 })).toBe(8);
  });

  it('is a whole dollar amount within [minBid, budget] and grows with the gain', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -20, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        fc.integer({ min: 0, max: 1000 }),
        fc.double({ min: -1, max: 2, noNaN: true }),
        fc.integer({ min: 0, max: 1 }),
        (gain, extra, budget, aggressiveness, minBid) => {
          const bid = suggestFaabBid({ gain, faabRemaining: budget, aggressiveness, minBid });
          expect(Number.isInteger(bid)).toBe(true);
          expect(bid).toBeGreaterThanOrEqual(Math.min(minBid, budget));
          expect(bid).toBeLessThanOrEqual(budget);
          const more = suggestFaabBid({ gain: gain + extra, faabRemaining: budget, aggressiveness, minBid });
          expect(more).toBeGreaterThanOrEqual(bid);
        }
      )
    );
  });
});

describe('waiver run schedule', () => {
  it('runs daily at 08:00 UTC', () => {
    expect(waiverRunAtOrAfter('2026-10-06T07:00:00.000Z')).toBe('2026-10-06T08:00:00.000Z');
    expect(waiverRunAtOrAfter('2026-10-06T08:00:00.000Z')).toBe('2026-10-06T08:00:00.000Z');
    expect(waiverRunAtOrAfter('2026-10-06T09:00:00.000Z')).toBe('2026-10-07T08:00:00.000Z');
    expect(nextWaiverRun('2026-10-06T08:00:00.000Z')).toBe('2026-10-07T08:00:00.000Z');
    expect(nextWaiverRun(new Date('2026-10-06T07:59:00.000Z'), 3)).toBe('2026-10-07T03:00:00.000Z');
    expect(waiverRunId('2026-10-06T08:00:05.000Z')).toBe('2026-10-06');
  });
});
