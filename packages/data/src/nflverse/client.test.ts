import { describe, expect, it } from 'vitest';
import { fixtureRoute, mockFetch, text } from '../../test/helpers.js';
import { HttpStatusError } from '../errors.js';
import { NFLVERSE_URLS, NflverseClient } from './client.js';
import { IdCrosswalk } from './crosswalk.js';

describe('NflverseClient (mocked fetch)', () => {
  it('fetches the ID map, weekly stats, and schedule from the release URLs', async () => {
    const m = mockFetch(fixtureRoute);
    const client = new NflverseClient({ fetch: m.fetch, sleep: async () => undefined });
    const ids = await client.idMap();
    const cw = new IdCrosswalk([{ sleeperId: '4046', gsisId: '00-0033873', method: 'idmap' }]);
    const stats = await client.weeklyStats(2025, cw);
    const schedule = await client.schedule(2025);
    expect(m.calls).toEqual([NFLVERSE_URLS.idMap, NFLVERSE_URLS.weeklyStats(2025), NFLVERSE_URLS.schedules]);
    expect(ids.length).toBeGreaterThan(20);
    expect(stats.filter((s) => s.playerId === '4046')).toHaveLength(2);
    expect(schedule).toHaveLength(285);
  });

  it('accepts URL overrides and surfaces HTTP errors', async () => {
    const m = mockFetch(() => text('gone', 404));
    const client = new NflverseClient({
      fetch: m.fetch,
      urls: { schedules: 'https://mirror.test/games.csv' }
    });
    await expect(client.schedule()).rejects.toBeInstanceOf(HttpStatusError);
    expect(m.calls).toEqual(['https://mirror.test/games.csv']);
  });
});

describe.skipIf(!process.env.LIVE_DATA_TESTS)('NflverseClient (live network)', () => {
  const client = new NflverseClient();

  it('downloads the real schedule and ID map', async () => {
    const schedule = await client.schedule(2025);
    expect(schedule.filter((g) => g.seasonType === 'regular')).toHaveLength(272);
    const ids = await client.idMap();
    expect(ids.find((r) => r.sleeperId === '4046')?.gsisId).toBe('00-0033873');
  }, 120_000);

  it('downloads real 2025 weekly stats', async () => {
    const stats = await client.weeklyStats(2025);
    expect(stats.length).toBeGreaterThan(5000);
  }, 120_000);
});
