import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, wallClock } from '../../test/helpers.js';
import { DEFAULT_SLEEPER_PER_MINUTE, TokenBucketRateLimiter, timerSleep } from './rate-limiter.js';

describe('TokenBucketRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2025-09-07T17:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to 300/min with a burst of 10, well under Sleeper’s 1,000/min', () => {
    const limiter = new TokenBucketRateLimiter({ clock: wallClock });
    expect(limiter.perMinute).toBe(DEFAULT_SLEEPER_PER_MINUTE);
    expect(limiter.perMinute).toBeLessThan(1000);
    expect(limiter.burst).toBe(10);
    expect(limiter.available()).toBe(10);
  });

  it('serves the burst immediately, then paces at the refill rate', async () => {
    const limiter = new TokenBucketRateLimiter({ clock: wallClock, perMinute: 60, burst: 2 });
    const done: number[] = [];
    const start = Date.now();
    const all = [0, 1, 2, 3].map((i) =>
      limiter.acquire().then(() => {
        done.push(i);
        return Date.now() - start;
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await Promise.all(all)).toEqual([0, 0, 1000, 2000]);
  });

  it('never exceeds the configured rate over a minute of sustained demand', async () => {
    const limiter = new TokenBucketRateLimiter({ clock: wallClock, perMinute: 300, burst: 10 });
    let granted = 0;
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++) pending.push(limiter.acquire().then(() => void granted++));
    await vi.advanceTimersByTimeAsync(60_000);
    // burst + 300 refilled over 60s
    expect(granted).toBeLessThanOrEqual(310);
    expect(granted).toBeGreaterThanOrEqual(300);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await Promise.all(pending);
    expect(granted).toBe(1000);
  });

  it('refills up to, but never beyond, the burst size', async () => {
    const limiter = new TokenBucketRateLimiter({ clock: wallClock, perMinute: 600, burst: 3 });
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.available()).toBeCloseTo(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(limiter.available()).toBe(3);
  });

  it('does not mint tokens when the clock moves backwards', async () => {
    let now = Date.parse('2025-09-07T17:00:00Z');
    const clock = { now: () => new Date(now) };
    const limiter = new TokenBucketRateLimiter({ clock, perMinute: 60, burst: 1 });
    await limiter.acquire();
    now -= 3_600_000;
    expect(limiter.available()).toBe(0);
    now += 1000;
    expect(limiter.available()).toBeCloseTo(1);
  });

  it('uses the injected sleep', async () => {
    const sleeps: number[] = [];
    let now = 0;
    const limiter = new TokenBucketRateLimiter({
      clock: { now: () => new Date(now) },
      perMinute: 60,
      burst: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      }
    });
    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toEqual([1000]);
  });

  it('rejects invalid configuration', () => {
    expect(
      () => new TokenBucketRateLimiter({ clock: fixedClock('2025-01-01T00:00:00Z'), perMinute: 0 })
    ).toThrow(RangeError);
    expect(() => new TokenBucketRateLimiter({ clock: wallClock, burst: 0 })).toThrow(RangeError);
  });

  it('timerSleep resolves after the delay', async () => {
    let resolved = false;
    const p = timerSleep(50).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
  });
});
