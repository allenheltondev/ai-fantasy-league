import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deadlineScheduleName } from '../league/draft.js';
import { lineupLockName } from '../season/cycle.js';
import { offerExpiryName, reviewEndName, tradeDeadlineName } from '../trades/lifecycle.js';
import { InMemoryEventPublisher } from './publisher.js';
import { isValidScheduleName, SCHEDULE_NAME_MAX, scheduleName } from './schedule-name.js';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
/** The longest league id the API accepts (`LeagueIdSchema`: 64 characters). */
const LONGEST_LEAGUE_ID = 'l'.repeat(64);

describe('scheduleName', () => {
  it('keeps a name that already fits unchanged', () => {
    expect(scheduleName('draft', 'lg-1', 12)).toBe('draft-lg-1-12');
    expect(scheduleName('lineup-lock', UUID, 'W05', 1)).toBe(`lineup-lock-${UUID}-W05-1`);
  });

  it('replaces characters Scheduler does not allow', () => {
    expect(scheduleName('trade deadline', 'lg#1/x')).toBe('trade-deadline-lg-1-x');
  });

  it('shortens a long name to a readable prefix and a stable hash of the whole', () => {
    const name = scheduleName('trade-expiry', UUID, OTHER_UUID);
    expect(name).toHaveLength(SCHEDULE_NAME_MAX);
    expect(name.startsWith(`trade-expiry-${UUID}`.slice(0, 47))).toBe(true);
    expect(scheduleName('trade-expiry', UUID, OTHER_UUID)).toBe(name);
    // Names that share their first 64 characters stay distinct (rsc-core alone would cut both to one).
    expect(scheduleName('trade-expiry', UUID, UUID)).not.toBe(name);
  });

  it('refuses an empty name', () => {
    expect(() => scheduleName('')).toThrow('non-empty');
  });

  it('always fits Scheduler and never collides for distinct parts', () => {
    const part = fc.oneof(fc.string({ maxLength: 80 }), fc.nat());
    fc.assert(
      fc.property(fc.array(part, { minLength: 1, maxLength: 4 }), (parts) => {
        fc.pre(parts.map(String).join('-').length > 0);
        expect(isValidScheduleName(scheduleName(...parts))).toBe(true);
      })
    );
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (a, b) => {
        fc.pre(a !== b);
        expect(scheduleName('trade-expiry', 'lg', a)).not.toBe(scheduleName('trade-expiry', 'lg', b));
      })
    );
  });
});

describe('every schedule name the code produces (#123)', () => {
  it('fits EventBridge Scheduler for the longest ids', () => {
    const leagueIds = [LONGEST_LEAGUE_ID, UUID, 'lg-1'];
    const names = leagueIds.flatMap((leagueId) => [
      offerExpiryName(leagueId, OTHER_UUID),
      reviewEndName(leagueId, OTHER_UUID),
      tradeDeadlineName(leagueId),
      deadlineScheduleName(leagueId, 240),
      lineupLockName(leagueId, 18, 12)
    ]);
    for (const name of names) expect(isValidScheduleName(name), name).toBe(true);
    // Offer expiry and review end for the same trade are different schedules.
    expect(offerExpiryName(UUID, OTHER_UUID)).not.toBe(reviewEndName(UUID, OTHER_UUID));
    expect(new Set(names).size).toBe(names.length);
  });

  it('is enforced by the in-memory publisher every test, the local loop, and the replay use', async () => {
    const events = new InMemoryEventPublisher();
    const request = {
      at: new Date('2026-10-01T00:00:00.000Z'),
      event: { detailType: 'Agent Action Requested' as const, detail: {} }
    };
    await expect(
      events.scheduleAt({ ...request, name: `trade-expiry-${UUID}-${OTHER_UUID}` })
    ).rejects.toThrow('scheduleName');
    await expect(events.cancelScheduled('bad name')).rejects.toThrow('scheduleName');
    await events.scheduleAt({ ...request, name: offerExpiryName(UUID, OTHER_UUID) });
    await events.scheduleAt(request);
    expect(events.events).toHaveLength(2);
  });
});
