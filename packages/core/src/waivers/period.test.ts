import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings } from '../rules/settings.js';
import { isOnWaivers, waiverClearsAt } from './period.js';

const settings = yahooDefaultSettings();
const games = { KC: { kickoff: '2026-10-04T17:00:00Z' } };

describe('waiverClearsAt', () => {
  it('adds the waiver period to the drop time', () => {
    expect(waiverClearsAt(settings, { droppedAt: '2026-10-01T12:00:00Z' })).toBe('2026-10-03T12:00:00.000Z');
  });

  it('clears immediately with a 0-day period', () => {
    const s = { waivers: { ...settings.waivers, waiverPeriodDays: 0 } };
    expect(waiverClearsAt(s, { droppedAt: new Date('2026-10-01T12:00:00Z') })).toBe(
      '2026-10-01T12:00:00.000Z'
    );
  });

  it('starts the period when locks lift for a player whose game has kicked off', () => {
    const input = {
      droppedAt: '2026-10-04T18:00:00Z',
      player: { nflTeam: 'KC' },
      games,
      locksReleaseAt: '2026-10-06T08:00:00Z'
    };
    expect(waiverClearsAt(settings, input)).toBe('2026-10-08T08:00:00.000Z');
    // Before kickoff the player is not locked.
    expect(waiverClearsAt(settings, { ...input, droppedAt: '2026-10-04T16:00:00Z' })).toBe(
      '2026-10-06T16:00:00.000Z'
    );
    // A player on bye never locks.
    expect(waiverClearsAt(settings, { ...input, player: { nflTeam: 'BUF' } })).toBe(
      '2026-10-06T18:00:00.000Z'
    );
  });
});

describe('isOnWaivers', () => {
  it('is true until the clear time and false for free agents', () => {
    const player = { waiverClearsAt: '2026-10-03T12:00:00Z' };
    expect(isOnWaivers(player, '2026-10-03T11:59:59Z')).toBe(true);
    expect(isOnWaivers(player, '2026-10-03T12:00:00Z')).toBe(false);
    expect(isOnWaivers({ waiverClearsAt: null }, '2026-10-01T00:00:00Z')).toBe(false);
    expect(isOnWaivers({}, '2026-10-01T00:00:00Z')).toBe(false);
  });
});
