import { describe, expect, it } from 'vitest';
import { ClockRewindError, SimClock } from './sim-clock.js';
import type { SimEvent } from './timeline.js';

const events: SimEvent[] = [
  { seq: 0, at: '2025-09-01T00:00:00.000Z', kind: 'draft', week: 1 },
  { seq: 1, at: '2025-09-03T00:00:00.000Z', kind: 'waiver_run', week: 1 },
  {
    seq: 2,
    at: '2025-09-05T00:20:00.000Z',
    kind: 'lineup_lock',
    week: 1,
    window: { kickoff: '2025-09-05T00:20:00.000Z', teams: ['DAL', 'PHI'] }
  },
  { seq: 3, at: '2025-09-05T04:20:00.000Z', kind: 'monday_night_final', week: 1 }
];

describe('SimClock', () => {
  it('starts one minute before the first event and steps through the timeline', () => {
    const clock = new SimClock(events);
    expect(clock.now().toISOString()).toBe('2025-08-31T23:59:00.000Z');
    expect(clock.timeline).toBe(events);
    expect(clock.remaining).toBe(4);
    expect(clock.peekEvent()?.kind).toBe('draft');
    expect(clock.nextEvent()?.kind).toBe('draft');
    expect(clock.now().toISOString()).toBe(events[0]?.at);
    expect(clock.nextEvent()?.kind).toBe('waiver_run');
    expect(clock.nextEvent()?.kind).toBe('lineup_lock');
    expect(clock.nextEvent()?.kind).toBe('monday_night_final');
    expect(clock.nextEvent()).toBeNull();
    expect(clock.peekEvent()).toBeNull();
    expect(clock.remaining).toBe(0);
  });

  it('returns copies of now, so callers cannot move time', () => {
    const clock = new SimClock(events);
    clock.now().setTime(0);
    expect(clock.now().toISOString()).toBe('2025-08-31T23:59:00.000Z');
  });

  it('advances forward, skipping events strictly before the new time but keeping events at it', () => {
    const clock = new SimClock(events, '2025-08-01T00:00:00.000Z');
    clock.advanceTo('2025-09-05T00:20:00.000Z');
    expect(clock.peekEvent()?.kind).toBe('lineup_lock');
    clock.advanceTo(new Date('2025-09-05T00:20:00.000Z'));
    expect(clock.nextEvent()?.kind).toBe('lineup_lock');
    expect(clock.now().toISOString()).toBe('2025-09-05T00:20:00.000Z');
  });

  it('refuses to move backwards or to invalid instants', () => {
    const clock = new SimClock(events);
    clock.nextEvent();
    expect(() => clock.advanceTo('2025-08-01T00:00:00.000Z')).toThrow(ClockRewindError);
    expect(() => clock.advanceTo('not a date')).toThrow(RangeError);
    expect(() => new SimClock(events, 'nope')).toThrow(RangeError);
  });

  it('skips events before an explicit start, and works with an empty timeline', () => {
    const clock = new SimClock(events, '2025-09-04T00:00:00.000Z');
    expect(clock.peekEvent()?.kind).toBe('lineup_lock');
    const empty = new SimClock([]);
    expect(empty.now().getTime()).toBe(0);
    expect(empty.nextEvent()).toBeNull();
  });

  it('never moves time backwards when an event is earlier than now', () => {
    const clock = new SimClock(events);
    // Skipping is only by advanceTo; a caller holding a stale reference cannot rewind via nextEvent.
    clock.advanceTo('2025-09-02T00:00:00.000Z');
    expect(clock.nextEvent()?.kind).toBe('waiver_run');
    expect(clock.now().toISOString()).toBe('2025-09-03T00:00:00.000Z');
  });
});
