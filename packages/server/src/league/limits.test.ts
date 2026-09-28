import { FixedClock } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, limitsFromEnv } from '../context.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { silentLogger } from '../log.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createServices } from '../services.js';

describe('league limits from the environment', () => {
  it('defaults to 3 leagues per user and no admins', () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS).toEqual({ leaguesPerUser: 3, unlimitedUsers: [] });
  });

  it('reads the quota and the admin allowlist', () => {
    expect(
      limitsFromEnv({ LEAGUE_QUOTA: '5', LEAGUE_QUOTA_ADMINS: ' Allen@Example.com , sub-1,, ' })
    ).toEqual({
      leaguesPerUser: 5,
      unlimitedUsers: ['allen@example.com', 'sub-1']
    });
    expect(limitsFromEnv({ LEAGUE_QUOTA: '0' }).leaguesPerUser).toBe(0);
  });

  it('ignores a quota that is not a whole, non-negative number', () => {
    for (const value of ['', 'many', '-1', '2.5']) {
      expect(limitsFromEnv({ LEAGUE_QUOTA: value }).leaguesPerUser, value).toBe(3);
    }
  });

  it('wires limits and an NFL state source into the services', () => {
    const base = {
      clock: new FixedClock('2026-09-10T00:00:00Z'),
      repos: createInMemoryRepos(),
      events: new InMemoryEventPublisher(),
      log: silentLogger
    };
    const nflState = { getNflState: async () => ({ season: 2026, seasonType: 'pre' as const, week: 1 }) };
    const services = createServices({ ...base, nflState, limits: { leaguesPerUser: 9, unlimitedUsers: [] } });
    expect(services.data.nflState).toBe(nflState);
    expect(services.limits.leaguesPerUser).toBe(9);
    const defaults = createServices(base);
    expect(defaults.data.nflState).toBeUndefined();
    expect(defaults.limits).toEqual(DEFAULT_LIMITS);
  });
});
