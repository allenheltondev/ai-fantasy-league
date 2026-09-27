import { describe, expect, it } from 'vitest';
import { FixedClock, systemClock } from './clock.js';

describe('FixedClock', () => {
  it('returns copies so callers cannot mutate the clock', () => {
    const clock = new FixedClock('2025-09-07T17:00:00Z');
    const t = clock.now();
    t.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2025-09-07T17:00:00.000Z');
  });

  it('advances and can be set', () => {
    const clock = new FixedClock('2025-09-07T17:00:00Z');
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2025-09-07T17:01:00.000Z');
    clock.set('2025-12-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });
});

describe('systemClock', () => {
  it('returns the current time', () => {
    expect(Math.abs(systemClock.now().getTime() - new Date().getTime())).toBeLessThan(1000);
  });
});
