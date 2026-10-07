import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fixtureRoute, fixtureText, mockFetch, text } from '../../test/helpers.js';
import { HttpStatusError } from '../errors.js';
import { MISSING_ASSET_RETRY_MS, NFLVERSE_URLS, NflverseClient } from './client.js';
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
    const sleeps: number[] = [];
    const client = new NflverseClient({
      fetch: m.fetch,
      sleep: async (ms) => void sleeps.push(ms),
      urls: { schedules: 'https://mirror.test/games.csv' }
    });
    const error = await client.schedule().catch((e: unknown) => e);
    // The CSV's error, not the fallback's.
    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toMatchObject({ status: 404, url: 'https://mirror.test/games.csv' });
    expect(m.calls).toEqual([
      'https://mirror.test/games.csv',
      'https://mirror.test/games.csv',
      'https://mirror.test/games.csv.gz'
    ]);
    expect(sleeps).toEqual([MISSING_ASSET_RETRY_MS]);
  });

  it('asks again when games.csv is missing for a moment (nflverse republishing)', async () => {
    const m = mockFetch((url, call) => (call === 1 ? text('Not Found', 404) : fixtureRoute(url, call)));
    const client = new NflverseClient({ fetch: m.fetch, sleep: async () => undefined });
    expect(await client.schedule(2025)).toHaveLength(285);
    expect(m.calls).toEqual([NFLVERSE_URLS.schedules, NFLVERSE_URLS.schedules]);
  });

  it('falls back to games.csv.gz from the same release while games.csv stays missing', async () => {
    const gz = gzipSync(fixtureText('nflverse/games_2025.csv'));
    const m = mockFetch((url) =>
      url.pathname.endsWith('/games.csv.gz') ? new Response(gz) : text('Not Found', 404)
    );
    const client = new NflverseClient({ fetch: m.fetch, sleep: async () => undefined });
    const schedule = await client.schedule(2025);
    expect(schedule).toHaveLength(285);
    expect(m.calls).toEqual([NFLVERSE_URLS.schedules, NFLVERSE_URLS.schedules, NFLVERSE_URLS.schedulesGz]);
    expect(NFLVERSE_URLS.schedulesGz).toBe(`${NFLVERSE_URLS.schedules}.gz`);
  });

  it('uses a given gzipped URL, and throws its error when it fails some other way', async () => {
    const m = mockFetch((url) => text('nope', url.pathname.endsWith('.gz') ? 403 : 404));
    const client = new NflverseClient({
      fetch: m.fetch,
      sleep: async () => undefined,
      urls: { schedulesGz: 'https://mirror.test/schedule.csv.gz' }
    });
    await expect(client.schedule()).rejects.toMatchObject({ status: 403 });
    expect(m.calls.at(-1)).toBe('https://mirror.test/schedule.csv.gz');
  });

  it('does not retry or fall back on other errors', async () => {
    const m = mockFetch(() => text('nope', 403));
    const client = new NflverseClient({ fetch: m.fetch, sleep: async () => undefined });
    await expect(client.schedule()).rejects.toMatchObject({ status: 403 });
    expect(m.calls).toEqual([NFLVERSE_URLS.schedules]);
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
