import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { zonedDate, zonedParts, zonedTimeToUtc } from '../time.js';
import {
  CHECK_INS_PER_WEEK,
  CHECK_IN_HOURS,
  CHECK_IN_SLOTS,
  CHECK_IN_TIME_ZONE,
  STRATEGY_ARCHETYPES,
  checkInMoment,
  checkInTradeChance
} from './index.js';

const ET = CHECK_IN_TIME_ZONE;
/** Any instant from 2024 through 2028 (both DST changes of every year included). */
const instant = fc
  .integer({ min: Date.parse('2024-01-01T00:00:00Z'), max: Date.parse('2028-12-31T00:00:00Z') })
  .map((ms) => new Date(ms));

describe('zoned time', () => {
  it('reads and writes US Eastern wall-clock times across daylight saving', () => {
    // Daylight time (UTC-4) in September, standard time (UTC-5) in December.
    expect(zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 9, minute: 0 }, ET).toISOString()).toBe(
      '2026-09-29T13:00:00.000Z'
    );
    expect(zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 20, minute: 0 }, ET).toISOString()).toBe(
      '2026-12-02T01:00:00.000Z'
    );
    // Days roll over the month's end.
    expect(zonedTimeToUtc({ year: 2026, month: 9, day: 31, hour: 9, minute: 0 }, ET).toISOString()).toBe(
      '2026-10-01T13:00:00.000Z'
    );
    expect(zonedParts(new Date('2026-11-01T05:59:00Z'), ET)).toEqual({
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 59
    });
    expect(zonedDate(new Date('2026-10-02T03:30:00Z'), ET)).toBe('2026-10-01');
  });

  it('round-trips every wall-clock time the zone has', () => {
    fc.assert(
      fc.property(instant, (at) => {
        const whole = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
        const parts = zonedParts(whole, ET);
        const back = zonedTimeToUtc(parts, ET);
        // An hour repeated when clocks fall back may resolve to either of its two instants.
        expect(zonedParts(back, ET)).toEqual(parts);
        expect(Math.abs(back.getTime() - whole.getTime()) % 3_600_000).toBe(0);
      })
    );
  });
});

describe('checkInMoment', () => {
  it('names the slot and local date of the latest check-in, and the next one', () => {
    // 09:00 EDT is 13:00 UTC.
    expect(checkInMoment(new Date('2026-09-29T13:00:00Z'))).toEqual({
      slot: 'morning',
      date: '2026-09-29',
      at: new Date('2026-09-29T13:00:00Z'),
      nextAt: new Date('2026-09-29T18:00:00Z')
    });
    expect(checkInMoment(new Date('2026-09-29T19:30:00Z'))).toMatchObject({
      slot: 'afternoon',
      nextAt: new Date('2026-09-30T00:00:00Z')
    });
    // Just after midnight UTC is still the evening of the 29th in New York.
    expect(checkInMoment(new Date('2026-09-30T00:05:00Z'))).toMatchObject({
      slot: 'evening',
      date: '2026-09-29',
      nextAt: new Date('2026-09-30T13:00:00Z')
    });
    // Before 9 AM belongs to the previous evening.
    expect(checkInMoment(new Date('2026-09-30T11:00:00Z'))).toMatchObject({
      slot: 'evening',
      date: '2026-09-29'
    });
  });

  it('is always the latest check-in at or before now, at its local hour, with the next one after now', () => {
    fc.assert(
      fc.property(instant, (now) => {
        const m = checkInMoment(now);
        expect(CHECK_IN_SLOTS).toContain(m.slot);
        expect(m.at.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(m.nextAt.getTime()).toBeGreaterThan(now.getTime());
        // Three a day: never more than 13 hours apart (20:00 to 09:00), give or take a DST hour.
        expect(m.nextAt.getTime() - m.at.getTime()).toBeLessThanOrEqual(14 * 3_600_000);
        expect(zonedParts(m.at, ET)).toMatchObject({ hour: CHECK_IN_HOURS[m.slot], minute: 0 });
        expect(zonedDate(m.at, ET)).toBe(m.date);
        // The next check-in is a check-in too, and the moment right before it still belongs to this one.
        expect(checkInMoment(m.nextAt).at).toEqual(m.nextAt);
        expect(checkInMoment(new Date(m.nextAt.getTime() - 1)).at).toEqual(m.at);
      })
    );
  });

  it('counts three check-ins a day, 21 a week', () => {
    expect(CHECK_INS_PER_WEEK).toBe(21);
  });
});

describe('checkInTradeChance', () => {
  it('grows with trade appetite, from never to about two check-ins in five', () => {
    expect(checkInTradeChance(0)).toBe(0);
    expect(checkInTradeChance(Number.NaN)).toBe(0);
    expect(checkInTradeChance(1)).toBe(0.5);
    expect(checkInTradeChance(STRATEGY_ARCHETYPES.trade_happy.tradeFrequency)).toBe(0.41);
    expect(checkInTradeChance(STRATEGY_ARCHETYPES.waiver_hawk.tradeFrequency)).toBe(0.02);
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(checkInTradeChance(lo)).toBeLessThanOrEqual(checkInTradeChance(hi));
          expect(checkInTradeChance(hi)).toBeLessThanOrEqual(0.5);
        }
      )
    );
  });
});
