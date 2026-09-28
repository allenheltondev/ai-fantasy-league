import type { Clock } from '@fantasy/core';
import type { SimEvent } from './timeline.js';

/** Thrown when something tries to move simulated time backwards. */
export class ClockRewindError extends Error {
  constructor(from: string, to: string) {
    super(`The simulated clock cannot move backwards (from ${from} to ${to}).`);
    this.name = 'ClockRewindError';
  }
}

/**
 * The simulator's clock. It implements core's `Clock`, so anything that takes a clock (the engine, the
 * data guard, server handlers later) lives in simulated time. Time only moves forward, and only when the
 * runner moves it: `advanceTo` for an arbitrary instant, `nextEvent` to step to the next timeline event.
 */
export class SimClock implements Clock {
  readonly #timeline: readonly SimEvent[];
  #now: number;
  #cursor = 0;

  /**
   * @param timeline Events sorted by time (see `buildTimeline`).
   * @param start Initial time. Defaults to one minute before the first event.
   */
  constructor(timeline: readonly SimEvent[], start?: Date | string) {
    this.#timeline = timeline;
    const first = timeline[0];
    const initial =
      start !== undefined ? new Date(start).getTime() : first ? Date.parse(first.at) - 60_000 : 0;
    if (!Number.isFinite(initial)) throw new RangeError(`Invalid start time: ${String(start)}`);
    this.#now = initial;
    this.#skipPast();
  }

  now(): Date {
    return new Date(this.#now);
  }

  /** The whole timeline, for reports and tests. */
  get timeline(): readonly SimEvent[] {
    return this.#timeline;
  }

  /**
   * Moves time forward to `instant`. Events strictly before it that were never returned by `nextEvent`
   * are skipped; events at exactly `instant` stay pending. Moving to the current time is a no-op; moving backwards throws `ClockRewindError`.
   */
  advanceTo(instant: Date | string): void {
    const t = new Date(instant).getTime();
    if (!Number.isFinite(t)) throw new RangeError(`Invalid instant: ${String(instant)}`);
    if (t < this.#now)
      throw new ClockRewindError(new Date(this.#now).toISOString(), new Date(t).toISOString());
    this.#now = t;
    this.#skipPast();
  }

  /** The next event not yet returned, without moving time. */
  peekEvent(): SimEvent | null {
    return this.#timeline[this.#cursor] ?? null;
  }

  /** Moves time to the next event and returns it, or null when the timeline is exhausted. */
  nextEvent(): SimEvent | null {
    const event = this.#timeline[this.#cursor];
    if (!event) return null;
    this.#now = Math.max(this.#now, Date.parse(event.at));
    this.#cursor++;
    return event;
  }

  /** Events still ahead. */
  get remaining(): number {
    return this.#timeline.length - this.#cursor;
  }

  #skipPast(): void {
    while (this.#cursor < this.#timeline.length) {
      const e = this.#timeline[this.#cursor] as SimEvent;
      if (Date.parse(e.at) >= this.#now) break;
      this.#cursor++;
    }
  }
}
