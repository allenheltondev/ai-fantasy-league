import { readFileSync } from 'node:fs';
import { FixedClock, systemClock } from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { newId } from '../context.js';
import { JOB_NAMES } from '../jobs/index.js';
import { JOB_SCHEDULE_EXPRESSIONS, nextRunFn, recurringJobs, seasonJobs } from '../jobs/schedules.js';
import { silentLogger } from '../log.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import { createServices } from '../services.js';
import type { BusEvent } from './bus.js';
import { EventLoop, type EventSubscriber, type LoopClock } from './loop.js';
import { InMemoryEventPublisher } from './publisher.js';
import { serverSubscribers } from './subscribers.js';

/** The publisher without the event contracts, so tests can publish arbitrary details. */
interface LoosePublisher {
  publish(detailType: string, detail: Record<string, unknown>): Promise<void>;
  scheduleAt(request: {
    at: Date;
    name?: string;
    whenPast?: 'send' | 'skip' | 'error';
    event: { detailType: string; detail: Record<string, unknown> };
  }): Promise<void>;
}
const loose = (publisher: InMemoryEventPublisher) => publisher as unknown as LoosePublisher;

/** A clock the loop can move, like the simulator's. */
class MovableClock implements LoopClock {
  constructor(private t: number) {}
  now(): Date {
    return new Date(this.t);
  }
  advanceTo(instant: Date): void {
    if (instant.getTime() < this.t) throw new Error('backwards');
    this.t = instant.getTime();
  }
}

const T0 = Date.parse('2025-09-01T00:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function recorder(detailTypes?: string[]) {
  const seen: { id: string; type: string; time: string | undefined }[] = [];
  const subscriber: EventSubscriber = {
    name: 'recorder',
    ...(detailTypes === undefined ? {} : { detailTypes }),
    handle: async (e: BusEvent) => {
      seen.push({ id: e.id, type: e['detail-type'], time: e.time });
    }
  };
  return { seen, subscriber };
}

describe('EventLoop', () => {
  it('delivers published events in order, breadth first, to matching subscribers', async () => {
    const publisher = new InMemoryEventPublisher();
    const clock = new MovableClock(T0);
    const all = recorder();
    const only = recorder(['Draft Pick Made']);
    const chain: EventSubscriber = {
      name: 'chain',
      detailTypes: ['League Created'],
      handle: async () => {
        await loose(publisher).publish('Draft Pick Made', { n: 1 });
      }
    };
    const loop = new EventLoop({ publisher, clock, subscribers: [chain, all.subscriber] });
    loop.subscribe(only.subscriber);
    await loose(publisher).publish('League Created', {});
    await loose(publisher).publish('Member Joined', {});
    expect(await loop.drain()).toBe(3);
    expect(all.seen.map((s) => [s.id, s.type])).toEqual([
      ['evt-0', 'League Created'],
      ['evt-1', 'Member Joined'],
      ['evt-2', 'Draft Pick Made']
    ]);
    expect(only.seen.map((s) => s.type)).toEqual(['Draft Pick Made']);
    expect(all.seen[0]?.time).toBe(at(0).toISOString());
    expect(loop.stats.delivered).toEqual({ 'League Created': 1, 'Member Joined': 1, 'Draft Pick Made': 1 });
  });

  it('holds deferred events until their time, moves renamed ones, and honors cancel and whenPast', async () => {
    const publisher = new InMemoryEventPublisher();
    const clock = new MovableClock(T0);
    const { seen, subscriber } = recorder();
    const failures: string[] = [];
    const loop = new EventLoop({
      publisher,
      clock,
      subscribers: [subscriber],
      idPrefix: 'x-',
      onFailure: (f) => failures.push(f.handler)
    });
    const schedule = (name: string | undefined, minutes: number, whenPast?: 'send' | 'skip' | 'error') =>
      loose(publisher).scheduleAt({
        at: at(minutes),
        ...(name === undefined ? {} : { name }),
        ...(whenPast === undefined ? {} : { whenPast }),
        event: { detailType: 'Lineup Lock Approaching', detail: { name: name ?? 'unnamed', minutes } }
      });
    await schedule('a', 30);
    await schedule('a', 20); // moved
    await schedule(undefined, 40);
    await schedule('b', 50);
    await publisher.cancelScheduled('b');
    await schedule('late', -5); // past, sent now
    await schedule('skipped', -5, 'skip');
    await schedule('refused', -5, 'error');
    publisher.events.push({ source: 'fantasy', detailType: 'Schedule Event', detail: { at: 'nope' } });
    await loop.drain();
    expect(seen.map((s) => s.type)).toEqual(['Lineup Lock Approaching']);
    expect(failures).toEqual(['scheduler', 'scheduler']);
    expect(loop.scheduled.map((s) => s.name)).toEqual(['a', 'unnamed-2']);

    await loop.runUntil(at(35));
    expect(clock.now()).toEqual(at(35));
    expect(seen.map((s) => s.time)).toEqual([at(0).toISOString(), at(20).toISOString()]);
    await loop.runUntil(at(60));
    expect(seen).toHaveLength(3);
    expect(seen[2]?.time).toBe(at(40).toISOString());
    expect(loop.stats.released).toBe(3);
  });

  it('runs jobs on their cadence, records failures, and keeps going', async () => {
    const publisher = new InMemoryEventPublisher();
    const clock = new MovableClock(T0);
    const runs: string[] = [];
    const loop = new EventLoop({
      publisher,
      clock,
      jobs: [
        {
          name: 'every10',
          next: nextRunFn('rate(10 minutes)'),
          run: async (now) => {
            runs.push(now.toISOString());
            await loose(publisher).publish('Scores Updated', {});
          }
        },
        {
          name: 'broken',
          next: nextRunFn('rate(30 minutes)'),
          run: async () => {
            throw new Error('boom');
          }
        }
      ]
    });
    const { subscriber, seen } = recorder();
    loop.subscribe({ ...subscriber, detailTypes: ['Scores Updated'] });
    loop.subscribe({ name: 'fails', handle: () => Promise.reject(new Error('handler')) });
    await loop.runUntil(at(30));
    expect(runs).toEqual([at(10), at(20), at(30)].map((d) => d.toISOString()));
    expect(seen).toHaveLength(3);
    expect(loop.stats.jobRuns).toEqual({ every10: 3, broken: 1 });
    expect(loop.stats.failures.map((f) => [f.handler, f.detailType])).toEqual([
      ['fails', 'Scores Updated'],
      ['fails', 'Scores Updated'],
      ['fails', 'Scores Updated'],
      ['broken', null]
    ]);
  });

  it('refuses to run a clock it cannot move, and stops handlers that feed each other', async () => {
    const publisher = new InMemoryEventPublisher();
    const fixed = new EventLoop({ publisher, clock: new FixedClock(at(0)) });
    await expect(fixed.runUntil(at(1))).rejects.toThrow(/advanceTo/);
    const loop = new EventLoop({
      publisher,
      clock: new MovableClock(T0),
      maxEventsPerDrain: 5,
      subscribers: [{ name: 'echo', handle: () => loose(publisher).publish('Scores Updated', {}) }]
    });
    await loose(publisher).publish('Scores Updated', {});
    await expect(loop.drain()).rejects.toThrow(/without settling/);
  });

  it('ticks on the wall clock until stopped', async () => {
    vi.useFakeTimers();
    try {
      const publisher = new InMemoryEventPublisher();
      const { seen, subscriber } = recorder();
      const errors: string[] = [];
      const log = { ...silentLogger, error: (m: string) => errors.push(m) };
      const loop = new EventLoop({ publisher, clock: systemClock, subscribers: [subscriber], log });
      loop.start(100);
      loop.start(100); // already running
      await loose(publisher).publish('League Created', {});
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toHaveLength(1);
      // A tick that throws is logged, and the loop keeps ticking.
      loop.subscribe({ name: 'loop', handle: () => loose(publisher).publish('League Created', {}) });
      await loose(publisher).publish('League Created', {});
      await vi.advanceTimersByTimeAsync(100);
      await loop.stop();
      expect(errors).toContain('event loop tick failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('job schedules', () => {
  it('match the EventBridge schedules in infra/template.yaml', () => {
    const template = readFileSync(new URL('../../../../infra/template.yaml', import.meta.url), 'utf8');
    const found: Record<string, string> = {};
    for (const m of template.matchAll(/ScheduleExpression: (.+)\n\s+Input: '\{"job":"(\w+)"\}'/g)) {
      found[m[2] as string] = (m[1] as string).trim();
    }
    expect(found).toEqual(JOB_SCHEDULE_EXPRESSIONS);
    expect(Object.keys(JOB_SCHEDULE_EXPRESSIONS).sort()).toEqual([...JOB_NAMES].sort());
  });

  it('computes the next run after a moment', () => {
    const twiceDaily = nextRunFn('cron(17 9,21 * * ? *)');
    expect(twiceDaily(new Date('2025-09-01T09:17:00.000Z')).toISOString()).toBe('2025-09-01T21:17:00.000Z');
    expect(twiceDaily(new Date('2025-09-01T22:00:00.000Z')).toISOString()).toBe('2025-09-02T09:17:00.000Z');
    expect(nextRunFn('rate(1 hour)')(new Date('2025-09-01T09:00:00.000Z')).toISOString()).toBe(
      '2025-09-01T10:00:00.000Z'
    );
    expect(nextRunFn('rate(2 days)')(new Date('2025-09-01T09:00:00.000Z')).getTime() % 172_800_000).toBe(0);
    expect(() => nextRunFn('cron(0 8 * * MON *)')).toThrow(/Unsupported/);
  });

  it('wraps the jobs for the loop, with cadence overrides', async () => {
    const repos = createInMemoryRepos();
    const events = new InMemoryEventPublisher();
    const deps = {
      repos,
      reference: createInMemoryReferenceStore(repos.players),
      events,
      log: silentLogger
    };
    const clock = new FixedClock(at(0));
    const season = seasonJobs(deps, clock);
    expect(season.map((j) => j.name)).toEqual(['advanceSeason', 'scoreLiveWeek', 'processWaivers']);
    for (const job of season) expect(await job.run(at(0))).toMatchObject({ status: expect.any(String) });
    const [waivers] = recurringJobs(
      { ...deps, provider: {} as never, directory: {} as never, news: {} as never },
      clock,
      ['processWaivers'],
      { processWaivers: 'rate(5 minutes)' }
    );
    expect(waivers?.next(at(0))).toEqual(at(5));
    expect(await waivers?.run(at(0))).toMatchObject({ status: 'ok', leagues: 0 });
  });
});

describe('server subscribers', () => {
  it('route the pick clock and system messages to their Lambda handlers', async () => {
    const repos = createInMemoryRepos();
    const events = new InMemoryEventPublisher();
    const services = createServices({ clock: new FixedClock(at(0)), repos, events, log: silentLogger });
    const [clock, messages] = serverSubscribers(services);
    expect(clock?.detailTypes).toEqual(['Draft Pick Deadline']);
    expect(messages?.detailTypes).toContain('Draft Completed');
    const base = { id: 'e', source: 'fantasy' };
    expect(
      await clock?.handle({
        ...base,
        'detail-type': 'Draft Pick Deadline',
        detail: { leagueId: 'lg', pick: 1 }
      })
    ).toEqual({ handled: true, outcome: 'ignored' });
    expect(
      await messages?.handle({ ...base, 'detail-type': 'Draft Completed', detail: { leagueId: 'lg' } })
    ).toEqual({
      status: 'skipped',
      reason: 'no_league'
    });
  });

  it('new ids come from the services id source when it has one', () => {
    const ids = { uuid: () => 'fixed' };
    const services = createServices({
      clock: systemClock,
      repos: createInMemoryRepos(),
      events: new InMemoryEventPublisher(),
      log: silentLogger,
      ids
    });
    expect(newId(services)).toBe('fixed');
    expect(newId({})).toMatch(/^[0-9a-f-]{36}$/);
  });
});
