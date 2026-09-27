import type { Clock } from '@fantasy/core';

export type Sleep = (ms: number) => Promise<void>;

/** Timer-based sleep. Timers are not clock reads, and vitest fake timers control them. */
export const timerSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RateLimiter {
  /** Resolves when the caller may make one request. Callers are served first come, first served. */
  acquire(): Promise<void>;
}

export interface TokenBucketOptions {
  clock: Clock;
  /** Sustained requests per minute. Sleeper asks for well under 1,000; the default is 300. */
  perMinute?: number;
  /** Burst size (bucket capacity). Default 10. */
  burst?: number;
  sleep?: Sleep;
}

export const DEFAULT_SLEEPER_PER_MINUTE = 300;

/**
 * A token bucket: `burst` tokens, refilled continuously at `perMinute`. Time comes only from the
 * injected clock, so the simulator and fake timers control it.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  readonly perMinute: number;
  readonly burst: number;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  readonly #perMs: number;
  #tokens: number;
  #last: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: TokenBucketOptions) {
    this.perMinute = options.perMinute ?? DEFAULT_SLEEPER_PER_MINUTE;
    this.burst = options.burst ?? 10;
    if (!(this.perMinute > 0) || !(this.burst >= 1)) {
      throw new RangeError('perMinute must be > 0 and burst must be >= 1');
    }
    this.#clock = options.clock;
    this.#sleep = options.sleep ?? timerSleep;
    this.#perMs = this.perMinute / 60_000;
    this.#tokens = this.burst;
    this.#last = this.#clock.now().getTime();
  }

  acquire(): Promise<void> {
    const turn = this.#queue.then(() => this.#take());
    this.#queue = turn;
    return turn;
  }

  /** Tokens currently available (after refill). Exposed for tests and metrics. */
  available(): number {
    this.#refill();
    return this.#tokens;
  }

  async #take(): Promise<void> {
    for (;;) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      await this.#sleep(Math.max(1, Math.ceil((1 - this.#tokens) / this.#perMs)));
    }
  }

  #refill(): void {
    const now = this.#clock.now().getTime();
    const elapsed = now - this.#last;
    // A clock that moved backwards (the simulator rewinding) never mints tokens.
    if (elapsed > 0) {
      this.#tokens = Math.min(this.burst, this.#tokens + elapsed * this.#perMs);
    }
    this.#last = now;
  }
}
