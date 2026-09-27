import { describe, expect, it } from 'vitest';
import { fixtureRoute, mockFetch, text, wallClock, type Route } from '../../test/helpers.js';
import { NflverseClient } from '../nflverse/client.js';
import type { CrosswalkReport } from '../nflverse/crosswalk.js';
import { SleeperClient } from '../sleeper/client.js';
import { LiveDataProvider } from './live.js';

const asOf = new Date('2025-09-03T12:00:00Z');

function live(route: Route = fixtureRoute, crosswalk?: boolean) {
  const m = mockFetch(route);
  const reports: CrosswalkReport[] = [];
  const provider = new LiveDataProvider({
    sleeper: new SleeperClient({
      clock: wallClock,
      fetch: m.fetch,
      limiter: { acquire: async () => undefined }
    }),
    nflverse: new NflverseClient({ fetch: m.fetch, sleep: async () => undefined }),
    ...(crosswalk !== undefined && { crosswalk }),
    onCrosswalkReport: (r) => reports.push(r)
  });
  return { provider, calls: m.calls, reports };
}

describe('LiveDataProvider (mocked Sleeper + nflverse)', () => {
  it('normalizes players, fills gsis ids from the crosswalk, and adds bye weeks', async () => {
    const { provider, reports } = live();
    const players = await provider.getPlayers(asOf);
    expect(players.find((p) => p.id === '90001')).toMatchObject({ gsisId: '00-0041239', byeWeek: 9 });
    expect(players.find((p) => p.id === '4046')).toMatchObject({ gsisId: '00-0033873', byeWeek: 10 });
    expect(players.find((p) => p.id === '90003')?.byeWeek).toBeUndefined();
    expect(reports[0]?.unmapped.map((u) => u.sleeperId)).toEqual(['90003']);
  });

  it('can skip the crosswalk fetch', async () => {
    const { provider, calls } = live(fixtureRoute, false);
    const players = await provider.getPlayers(asOf);
    expect(players.find((p) => p.id === '90001')?.gsisId).toBeUndefined();
    expect(calls.some((c) => c.includes('db_playerids'))).toBe(false);
  });

  it('serves state, stats, projections, and trending from Sleeper', async () => {
    const { provider } = live();
    expect((await provider.getNflState(asOf)).week).toBe(1);
    expect(
      (await provider.getWeekStats(2025, 1, asOf)).find((l) => l.playerId === '4046')?.stats.pass_yd
    ).toBe(258);
    expect((await provider.getWeekProjections(2025, 1, asOf)).length).toBeGreaterThan(15);
    expect(await provider.getWeekStats(2025, 17, asOf)).toEqual([]);
    expect((await provider.getTrending('drop', asOf, { limit: 3 }))[0]).toEqual({
      playerId: '6794',
      count: 18502
    });
  });

  it('caches the schedule per season and retries after a failure', async () => {
    let fail = true;
    const { provider, calls } = live((u, n) => {
      if (u.pathname.endsWith('/games.csv') && fail) {
        fail = false;
        return text('nope', 404);
      }
      return fixtureRoute(u, n);
    });
    await expect(provider.getSchedule(2025, asOf)).rejects.toThrow(/404/);
    expect(await provider.getSchedule(2025, asOf)).toHaveLength(285);
    expect(await provider.getByeWeeks(2025, asOf)).toMatchObject({ GB: 5 });
    expect(calls.filter((c) => c.endsWith('/games.csv'))).toHaveLength(2);
  });
});
