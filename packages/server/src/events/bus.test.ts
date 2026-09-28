import { describe, expect, it } from 'vitest';
import { canonicalEvent, type BusEvent } from './bus.js';

const event: BusEvent = {
  id: 'transport-1',
  source: 'fantasy',
  'detail-type': 'Week Provisionally Final',
  time: '2026-10-06T13:00:00Z',
  detail: { leagueId: 'league', eventKey: 'week:1', occurredAt: '2026-10-06T12:00:00Z' }
};
describe('recovery event identity', () => {
  it('survives a new delivery id and time, without conflating event kinds or leagues', () => {
    const first = canonicalEvent(event);
    expect(canonicalEvent({ ...event, id: 'transport-2', time: '2026-10-06T14:00:00Z' })).toEqual(first);
    expect(first.time).toBe('2026-10-06T12:00:00.000Z');
    expect(canonicalEvent({ ...event, 'detail-type': 'Season Completed' }).id).not.toBe(first.id);
    expect(
      canonicalEvent({ ...event, detail: { ...(event.detail as object), leagueId: 'other' } }).id
    ).not.toBe(first.id);
  });
  it.each([null, [], {}, { eventKey: '' }, { eventKey: 'key' }, { eventKey: 'key', occurredAt: 'invalid' }])(
    'preserves legacy/malformed envelopes: %j',
    (detail) => {
      const original = { ...event, detail };
      expect(canonicalEvent(original)).toBe(original);
    }
  );
  it('does not canonicalize another source', () => {
    const original = { ...event, source: 'other' };
    expect(canonicalEvent(original)).toBe(original);
  });
});
