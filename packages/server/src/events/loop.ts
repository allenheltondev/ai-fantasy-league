import type { Clock } from '@fantasy/core';
import { silentLogger, type Logger } from '../log.js';
import type { BusEvent } from './bus.js';
import {
  CANCEL_SCHEDULED_EVENT,
  SCHEDULE_EVENT,
  type EventDetail,
  type FantasyEventType,
  type InMemoryEventPublisher
} from './publisher.js';

/**
 * An in-process stand-in for EventBridge, the rsc-core deferred-event scheduler, and EventBridge
 * Scheduler. It reads what handlers publish to an `InMemoryEventPublisher` and delivers it to the
 * same handler functions the Lambdas run (the draft clock, system chat messages, the agent router
 * and task runner, ...). The season replay simulator drives it with a simulated clock; the local
 * dev server drives it with the wall clock.
 *
 * - `publish`ed events are delivered right away, in order, to every subscriber of their detail type.
 *   Events a handler publishes are queued behind the current ones (breadth first).
 * - `Schedule Event` requests wait until the clock reaches their `at`, then publish their event.
 *   Re-scheduling a name moves it; `Cancel Scheduled Event` drops it. A request whose time has
 *   already passed follows `whenPast` (default `send`).
 * - Recurring jobs run at their cadence (see `jobs/schedules.ts`).
 *
 * Each delivered event gets a stable id (`<idPrefix><n>`, its position in the publisher's log) and
 * the clock's time, so a replay with the same inputs produces the same ids.
 */

/** A clock the loop can move forward. Without `advanceTo`, time moves by itself (the wall clock). */
export interface LoopClock extends Clock {
  advanceTo?(instant: Date): void;
}

export interface EventSubscriber {
  name: string;
  /** Detail types delivered to it; every event when omitted. */
  detailTypes?: readonly string[];
  handle(event: BusEvent): Promise<unknown>;
}

export interface RecurringJob {
  name: string;
  /** The first run time strictly after `after`. */
  next(after: Date): Date;
  run(now: Date): Promise<unknown>;
}

export interface LoopFailure {
  at: string;
  /** The subscriber or job that failed. */
  handler: string;
  eventId: string | null;
  detailType: string | null;
  error: unknown;
}

export interface LoopStats {
  /** Events delivered, by detail type. */
  delivered: Record<string, number>;
  /** Deferred events released when their time came. */
  released: number;
  /** Job runs, by job name. */
  jobRuns: Record<string, number>;
  failures: LoopFailure[];
}

export interface EventLoopOptions {
  publisher: InMemoryEventPublisher;
  clock: LoopClock;
  subscribers?: readonly EventSubscriber[];
  jobs?: readonly RecurringJob[];
  log?: Logger;
  /** Prefix of delivered event ids (default `evt-`). */
  idPrefix?: string;
  /** A drain that delivers more than this many events stops with an error (handlers feeding each other). */
  maxEventsPerDrain?: number;
  /** Called on every handler failure, after it is recorded. Throw from it to stop the loop. */
  onFailure?: (failure: LoopFailure) => void;
}

interface Pending {
  key: string;
  at: number;
  seq: number;
  detailType: string;
  detail: EventDetail;
}

const DEFAULT_MAX_EVENTS = 50_000;

export class EventLoop {
  readonly #publisher: InMemoryEventPublisher;
  readonly #clock: LoopClock;
  readonly #subscribers: EventSubscriber[];
  readonly #jobs: { job: RecurringJob; nextAt: number }[];
  readonly #log: Logger;
  readonly #idPrefix: string;
  readonly #maxEvents: number;
  readonly #onFailure: ((failure: LoopFailure) => void) | undefined;
  readonly #scheduled = new Map<string, Pending>();
  #cursor = 0;
  #seq = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking: Promise<void> | null = null;
  readonly stats: LoopStats = { delivered: {}, released: 0, jobRuns: {}, failures: [] };

  constructor(options: EventLoopOptions) {
    this.#publisher = options.publisher;
    this.#clock = options.clock;
    this.#subscribers = [...(options.subscribers ?? [])];
    const now = this.#clock.now();
    this.#jobs = (options.jobs ?? []).map((job) => ({ job, nextAt: job.next(now).getTime() }));
    this.#log = options.log ?? silentLogger;
    this.#idPrefix = options.idPrefix ?? 'evt-';
    this.#maxEvents = options.maxEventsPerDrain ?? DEFAULT_MAX_EVENTS;
    this.#onFailure = options.onFailure;
  }

  subscribe(subscriber: EventSubscriber): void {
    this.#subscribers.push(subscriber);
  }

  /** Deferred events still waiting, soonest first. */
  get scheduled(): { name: string; at: string; detailType: string }[] {
    return [...this.#scheduled.values()]
      .sort((a, b) => a.at - b.at || a.seq - b.seq)
      .map((p) => ({ name: p.key, at: new Date(p.at).toISOString(), detailType: p.detailType }));
  }

  /**
   * Delivers everything published so far, and every deferred event that is due now, until nothing
   * is left. Returns the number of events delivered.
   */
  async drain(): Promise<number> {
    let delivered = 0;
    for (;;) {
      const record = this.#publisher.events[this.#cursor];
      if (record === undefined) {
        if (this.#releaseDue(this.#clock.now().getTime()) === 0) return delivered;
        continue;
      }
      const index = this.#cursor++;
      if (record.detailType === SCHEDULE_EVENT) {
        this.#schedule(record.detail, index);
      } else if (record.detailType === CANCEL_SCHEDULED_EVENT) {
        this.#scheduled.delete(String(record.detail.name));
      } else {
        if (++delivered > this.#maxEvents) {
          throw new Error(
            `The event loop delivered more than ${this.#maxEvents} events without settling; handlers are feeding each other.`
          );
        }
        await this.#deliver({
          id: `${this.#idPrefix}${index}`,
          'detail-type': record.detailType,
          source: record.source,
          time: this.#clock.now().toISOString(),
          detail: record.detail
        });
      }
    }
  }

  /**
   * Moves the clock forward to `target`, stopping at every deferred event and job run on the way,
   * in time order (at one instant: deferred events, then jobs in the order given). Needs a clock
   * with `advanceTo`.
   */
  async runUntil(target: Date): Promise<void> {
    const advanceTo = this.#clock.advanceTo?.bind(this.#clock);
    if (advanceTo === undefined) throw new Error('runUntil needs a clock the loop can move (advanceTo).');
    const end = target.getTime();
    await this.drain();
    for (;;) {
      const next = this.#nextStop();
      if (next === null || next > end) break;
      if (next > this.#clock.now().getTime()) advanceTo(new Date(next));
      await this.#step();
    }
    if (end > this.#clock.now().getTime()) advanceTo(target);
    await this.drain();
  }

  /** One pass at the current time: due deferred events, due jobs, then everything they publish. */
  async tick(): Promise<void> {
    await this.drain();
    await this.#step();
  }

  /** Ticks every `intervalMs` of wall time (local dev). */
  start(intervalMs = 1000): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      if (this.#ticking !== null) return;
      this.#ticking = this.tick()
        .catch((error: unknown) => this.#log.error('event loop tick failed', { error }))
        .finally(() => {
          this.#ticking = null;
        });
    }, intervalMs);
  }

  /** Stops ticking and waits for a tick in flight. */
  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#ticking;
  }

  async #step(): Promise<void> {
    const now = this.#clock.now();
    this.#releaseDue(now.getTime());
    await this.drain();
    for (const entry of this.#jobs) {
      if (entry.nextAt > now.getTime()) continue;
      entry.nextAt = entry.job.next(now).getTime();
      this.stats.jobRuns[entry.job.name] = (this.stats.jobRuns[entry.job.name] ?? 0) + 1;
      try {
        await entry.job.run(now);
      } catch (error) {
        this.#fail({ handler: entry.job.name, eventId: null, detailType: null, error });
      }
      await this.drain();
    }
  }

  #nextStop(): number | null {
    let next: number | null = null;
    for (const p of this.#scheduled.values()) if (next === null || p.at < next) next = p.at;
    for (const j of this.#jobs) if (next === null || j.nextAt < next) next = j.nextAt;
    return next;
  }

  /** Publishes every deferred event due by `now`, in time order. Returns how many. */
  #releaseDue(now: number): number {
    const due = [...this.#scheduled.values()]
      .filter((p) => p.at <= now)
      .sort((a, b) => a.at - b.at || a.seq - b.seq);
    for (const p of due) {
      this.#scheduled.delete(p.key);
      this.stats.released++;
      void this.#publisher.publish(p.detailType as FantasyEventType, p.detail);
    }
    return due.length;
  }

  #schedule(detail: EventDetail, index: number): void {
    const at = Date.parse(String(detail.at));
    const event = detail.event as { detailType: string; detail: EventDetail } | undefined;
    if (event === undefined || Number.isNaN(at)) {
      this.#fail({
        handler: 'scheduler',
        eventId: null,
        detailType: SCHEDULE_EVENT,
        error: new Error(`Malformed Schedule Event: ${JSON.stringify(detail)}`)
      });
      return;
    }
    const key = typeof detail.name === 'string' ? detail.name : `unnamed-${index}`;
    const whenPast = detail.whenPast ?? 'send';
    if (at <= this.#clock.now().getTime() && whenPast !== 'send') {
      if (whenPast === 'error') {
        this.#fail({
          handler: 'scheduler',
          eventId: null,
          detailType: event.detailType,
          error: new Error(`Scheduled ${event.detailType} (${key}) for a time that has passed.`)
        });
      }
      this.#scheduled.delete(key);
      return;
    }
    this.#scheduled.set(key, { key, at, seq: this.#seq++, detailType: event.detailType, detail: event.detail });
  }

  async #deliver(event: BusEvent): Promise<void> {
    const type = event['detail-type'];
    this.stats.delivered[type] = (this.stats.delivered[type] ?? 0) + 1;
    for (const subscriber of this.#subscribers) {
      if (subscriber.detailTypes !== undefined && !subscriber.detailTypes.includes(type)) continue;
      try {
        await subscriber.handle(event);
      } catch (error) {
        this.#fail({ handler: subscriber.name, eventId: event.id, detailType: type, error });
      }
    }
  }

  #fail(failure: Omit<LoopFailure, 'at'>): void {
    const recorded = { at: this.#clock.now().toISOString(), ...failure };
    this.stats.failures.push(recorded);
    this.#log.error('event loop handler failed', recorded);
    this.#onFailure?.(recorded);
  }
}
