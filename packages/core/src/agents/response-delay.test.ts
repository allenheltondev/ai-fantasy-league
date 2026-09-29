import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DIFFICULTIES,
  DIFFICULTY_TIERS,
  IMMEDIATE_RESPONSE,
  RESPONSE_DELAY_CLASSES,
  RESPONSE_DELAY_PROFILES,
  deadlineLimitMs,
  responseDelay,
  type ResponseDelayLever
} from './index.js';

const NOW = new Date('2026-10-04T15:00:00.000Z');
const PRO = DIFFICULTY_TIERS.pro.levers.responseDelay;

const lever = fc.record({
  multiplier: fc.double({ min: 0, max: 5, noNaN: true }),
  immediateChance: fc.double({ min: 0, max: 1, noNaN: true })
});
const eventClass = fc.constantFrom(...RESPONSE_DELAY_CLASSES);
/** A deadline somewhere from an hour ago to two days ahead, or none. */
const deadline = fc.option(
  fc.integer({ min: -60 * 60_000, max: 48 * 60 * 60_000 }).map((ms) => new Date(NOW.getTime() + ms)),
  { nil: undefined }
);

describe('responseDelay', () => {
  it('stays in [0, cap × multiplier], never past the deadline clamp, and replays the same', () => {
    fc.assert(
      fc.property(
        eventClass,
        fc.string(),
        lever,
        deadline,
        fc.boolean(),
        (cls, seed, l: ResponseDelayLever, at, quick) => {
          const input = { eventClass: cls, seed, lever: l, now: NOW, deadline: at, quick };
          const { delayMs, reason } = responseDelay(input);
          expect(Number.isInteger(delayMs)).toBe(true);
          expect(delayMs).toBeGreaterThanOrEqual(0);
          expect(delayMs).toBeLessThanOrEqual(RESPONSE_DELAY_PROFILES[cls].capMs * l.multiplier);
          expect(delayMs).toBeLessThanOrEqual(deadlineLimitMs(cls, NOW, at));
          if (at !== undefined)
            expect(NOW.getTime() + delayMs).toBeLessThanOrEqual(Math.max(NOW.getTime(), at.getTime()));
          if (reason === 'immediate') expect(delayMs).toBe(0);
          expect(responseDelay({ ...input, deadline: at?.toISOString() })).toEqual({ delayMs, reason });
        }
      )
    );
  });

  it('answers at once about as often as immediateChance says', () => {
    for (const chance of [0, 0.05, 0.25, 0.6, 1]) {
      const l = { multiplier: 1, immediateChance: chance };
      let immediate = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) {
        if (
          responseDelay({ eventClass: 'trade', seed: `evt-${i}:team-2`, lever: l, now: NOW }).reason ===
          'immediate'
        )
          immediate++;
      }
      expect(Math.abs(immediate / n - chance)).toBeLessThan(0.03);
    }
  });

  it('is right-skewed around the class median, scaled by the multiplier', () => {
    const samples = (l: ResponseDelayLever) =>
      Array.from(
        { length: 2001 },
        (_, i) => responseDelay({ eventClass: 'chat', seed: `m${i}`, lever: l, now: NOW }).delayMs
      ).sort((a, b) => a - b);
    const base = samples({ multiplier: 1, immediateChance: 0 });
    const median = base[1000] as number;
    const mean = base.reduce((a, b) => a + b, 0) / base.length;
    expect(median).toBeGreaterThan(30_000);
    expect(median).toBeLessThan(60_000);
    expect(mean).toBeGreaterThan(median);
    expect(base.at(-1)).toBe(RESPONSE_DELAY_PROFILES.chat.capMs);
    const slow = samples({ multiplier: 2, immediateChance: 0 });
    expect(slow[1000]).toBeGreaterThan(median * 1.8);
  });

  it('keeps a direct message to the lower end', () => {
    const quick = responseDelay({
      eventClass: 'chat',
      seed: 's',
      lever: { ...PRO, immediateChance: 0 },
      now: NOW,
      quick: true
    });
    const slow = responseDelay({
      eventClass: 'chat',
      seed: 's',
      lever: { ...PRO, immediateChance: 0 },
      now: NOW
    });
    expect(quick.delayMs).toBeLessThan(slow.delayMs);
  });

  it('clamps to a share of the time left: half before a trade expires, 40% of the pick clock', () => {
    const l = { multiplier: 5, immediateChance: 0 };
    const expires = new Date(NOW.getTime() + 60 * 60_000);
    const trade = responseDelay({ eventClass: 'trade', seed: 'x', lever: l, now: NOW, deadline: expires });
    expect(trade).toEqual({ delayMs: 30 * 60_000, reason: 'deadline' });
    const pick = responseDelay({
      eventClass: 'deadline',
      seed: 'x',
      lever: l,
      now: NOW,
      deadline: new Date(NOW.getTime() + 20_000)
    });
    expect(pick.delayMs).toBeLessThanOrEqual(8_000);
    // A deadline already past: no wait at all.
    const late = responseDelay({
      eventClass: 'roster',
      seed: 'x',
      lever: l,
      now: NOW,
      deadline: '2026-10-04T14:00:00.000Z'
    });
    expect(late).toEqual({ delayMs: 0, reason: 'deadline' });
    // An unreadable deadline is ignored; the class cap still holds.
    expect(deadlineLimitMs('trade', NOW, 'soon')).toBe(Number.POSITIVE_INFINITY);
    expect(deadlineLimitMs('trade', NOW, null)).toBe(Number.POSITIVE_INFINITY);
  });

  it('reports a capped sample', () => {
    const l = { multiplier: 1, immediateChance: 0 };
    const reasons = new Set(
      Array.from(
        { length: 500 },
        (_, i) => responseDelay({ eventClass: 'roster', seed: `c${i}`, lever: l, now: NOW }).reason
      )
    );
    expect(reasons).toEqual(new Set(['sampled', 'capped']));
  });

  it('is immediate for the deadline class without a deadline, and when turned off', () => {
    for (const d of DIFFICULTIES) {
      const l = DIFFICULTY_TIERS[d].levers.responseDelay;
      expect(responseDelay({ eventClass: 'deadline', seed: 'lock', lever: l, now: NOW }).delayMs).toBe(0);
    }
    for (const cls of RESPONSE_DELAY_CLASSES) {
      expect(responseDelay({ eventClass: cls, seed: 'dev', lever: IMMEDIATE_RESPONSE, now: NOW })).toEqual({
        delayMs: 0,
        reason: 'immediate'
      });
      expect(
        responseDelay({
          eventClass: cls,
          seed: 'dev',
          lever: { multiplier: 0, immediateChance: 0 },
          now: NOW
        }).delayMs
      ).toBe(0);
    }
  });
});
