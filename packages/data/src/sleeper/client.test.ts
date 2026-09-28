import { describe, expect, it } from 'vitest';
import {
  fixtureJson,
  fixtureRoute,
  json,
  mockFetch,
  text,
  wallClock,
  type Route
} from '../../test/helpers.js';
import { HttpStatusError, SchemaDriftError } from '../errors.js';
import type { RateLimiter } from '../http/rate-limiter.js';
import { SleeperClient, sharedSleeperRateLimiter } from './client.js';

const noLimit: RateLimiter = { acquire: async () => undefined };
const noSleep = async (): Promise<void> => undefined;

function client(route = fixtureRoute): { sleeper: SleeperClient; calls: string[] } {
  const m = mockFetch(route);
  return {
    sleeper: new SleeperClient({ clock: wallClock, fetch: m.fetch, limiter: noLimit, sleep: noSleep }),
    calls: m.calls
  };
}

describe('SleeperClient', () => {
  it('fetches and validates the players map', async () => {
    const { sleeper, calls } = client();
    const players = await sleeper.players();
    expect(calls).toEqual(['https://api.sleeper.app/v1/players/nfl']);
    expect(players['4046']?.full_name).toBe('Patrick Mahomes');
    expect(players.KC?.position).toBe('DEF');
  });

  it('fetches state, weekly stats, projections, and trending from the documented paths', async () => {
    const { sleeper, calls } = client();
    const state = await sleeper.state();
    const stats = await sleeper.weekStats(2025, 1);
    const projections = await sleeper.weekProjections(2025, 2);
    const trending = await sleeper.trending('add', { lookbackHours: 24, limit: 2 });
    await sleeper.trending('drop');
    expect(calls).toEqual([
      'https://api.sleeper.app/v1/state/nfl',
      'https://api.sleeper.app/v1/stats/nfl/regular/2025/1',
      'https://api.sleeper.app/v1/projections/nfl/regular/2025/2',
      'https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=2',
      'https://api.sleeper.app/v1/players/nfl/trending/drop'
    ]);
    expect(state.season).toBe('2025');
    expect(stats['4046']?.pts_ppr).toBe(26.02);
    expect(projections['4046']?.pass_yd).toBeGreaterThan(0);
    expect(trending[0]).toEqual({ player_id: '90001', count: 41288 });
  });

  describe('weekProjections fallback (#184)', () => {
    const V1 = 'https://api.sleeper.app/v1/projections/nfl/regular/2026/1';
    const APP =
      'https://api.sleeper.com/projections/nfl/2026/1?season_type=regular&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE&position%5B%5D=K&position%5B%5D=DEF';
    const appRows = fixtureJson('sleeper/projection-sources/hand-authored/app_2026_1.json');
    const route =
      (v1: () => Response, app: () => Response = () => json(appRows)): Route =>
      (u) =>
        u.host === 'api.sleeper.com' ? app() : v1();

    it('uses v1 when it has projected stats', async () => {
      const { sleeper, calls } = client();
      const result = await sleeper.weekProjectionsWithSource(2025, 1);
      expect(result.source).toBe('v1');
      expect(result.fallbackReason).toBeUndefined();
      expect(result.stats['4046']?.pass_yd).toBe(245.1);
      expect(calls).toEqual(['https://api.sleeper.app/v1/projections/nfl/regular/2025/1']);
    });

    it('falls back to the app endpoint when every v1 entry is empty', async () => {
      const { sleeper, calls } = client(
        route(() => json(fixtureJson('sleeper/projection-sources/hand-authored/v1_2026_1.json')))
      );
      const result = await sleeper.weekProjectionsWithSource(2026, 1);
      expect(calls).toEqual([V1, APP]);
      expect(result).toMatchObject({ source: 'app', fallbackReason: 'v1_empty' });
      expect(result.stats['6904']).toMatchObject({ pass_yd: 258.4, pts_ppr: 22.75 });
      expect(result.stats.KC?.pts_allow).toBe(22.1);
      // The bye row keeps only its ADP; the week 6 row is not this week's.
      expect(result.stats['96']).toEqual({ adp_dd_ppr: 1000 });
      expect(result.stats['6786']).toBeUndefined();
      expect(await sleeper.weekProjections(2026, 1)).toEqual(result.stats);
    });

    it('treats ADP-only v1 entries and a null v1 week as empty', async () => {
      const adpOnly = client(route(() => json({ '4046': { adp_dd_ppr: 20, pos_adp_dd_ppr: 3 } })));
      expect((await adpOnly.sleeper.weekProjectionsWithSource(2026, 1)).source).toBe('app');
      const nothing = client(route(() => json(null)));
      expect((await nothing.sleeper.weekProjectionsWithSource(2026, 1)).source).toBe('app');
    });

    it('falls back when v1 fails', async () => {
      const { sleeper, calls } = client(route(() => text('gone', 404)));
      const result = await sleeper.weekProjectionsWithSource(2026, 1);
      expect(calls).toEqual([V1, APP]);
      expect(result.source).toBe('app');
      expect(result.fallbackReason).toMatch(/^v1_error: GET .* failed with HTTP 404$/);
      expect(Object.keys(result.stats)).toContain('4046');
    });

    it('falls back when v1 drifts', async () => {
      const { sleeper } = client(route(() => json([{ player_id: '4046' }])));
      const result = await sleeper.weekProjectionsWithSource(2026, 1);
      expect(result.fallbackReason).toMatch(/^v1_error: Schema drift/);
    });

    it('raises SchemaDriftError when the fallback is malformed', async () => {
      const empty = () => json({ '4046': {} });
      await expect(
        client(route(empty, () => json({ players: 'none' }))).sleeper.weekProjections(2026, 1)
      ).rejects.toThrow(/Schema drift in sleeper api\.sleeper\.com\/projections\/nfl\/\{season\}\/\{week\}/);
      await expect(
        client(route(empty, () => json([{ id: 1 }, 'x', null]))).sleeper.weekProjections(2026, 1)
      ).rejects.toBeInstanceOf(SchemaDriftError);
      await expect(
        client(route(empty, () => json('x'))).sleeper.weekProjections(2026, 1)
      ).rejects.toBeInstanceOf(SchemaDriftError);
    });

    it('surfaces the fallback failing too', async () => {
      const { sleeper } = client(
        route(
          () => json({}),
          () => text('forbidden', 403)
        )
      );
      await expect(sleeper.weekProjections(2026, 1)).rejects.toBeInstanceOf(HttpStatusError);
    });

    it('reads the fallback from a custom host and validates season and week first', async () => {
      const m = mockFetch(route(() => json({})));
      const sleeper = new SleeperClient({
        clock: wallClock,
        fetch: m.fetch,
        limiter: noLimit,
        appBaseUrl: 'https://app.proxy.test/'
      });
      await sleeper.appWeekProjections(2026, 1);
      expect(m.calls[0]).toMatch(
        /^https:\/\/app\.proxy\.test\/projections\/nfl\/2026\/1\?season_type=regular&/
      );
      await expect(sleeper.weekProjectionsWithSource(2026, 0)).rejects.toThrow(RangeError);
      await expect(sleeper.appWeekProjections(2026, 23)).rejects.toThrow(RangeError);
      expect(m.calls).toHaveLength(1);
    });
  });

  it('treats a null weekly payload as empty', async () => {
    const { sleeper } = client(() => json(null));
    expect(await sleeper.weekStats(2025, 18)).toEqual({});
  });

  it('raises SchemaDriftError when Sleeper changes a shape', async () => {
    const drifted = structuredClone(fixtureJson('sleeper/players.json')) as Record<
      string,
      Record<string, unknown>
    >;
    (drifted['4046'] as Record<string, unknown>).fantasy_positions = 'QB';
    const { sleeper } = client(() => json(drifted));
    const error = await sleeper.players().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchemaDriftError);
    const drift = error as SchemaDriftError;
    expect(drift.source).toBe('sleeper /v1/players/nfl');
    expect(drift.issues[0]?.path).toBe('4046.fantasy_positions');
  });

  it('raises SchemaDriftError when stats switch from a map to an array', async () => {
    const { sleeper } = client(() => json([{ player_id: '4046', stats: {} }]));
    await expect(sleeper.weekStats(2025, 1)).rejects.toThrow(
      /Schema drift in sleeper \/v1\/stats\/nfl\/regular\/\{season\}\/\{week\}/
    );
  });

  it('raises SchemaDriftError on a malformed state or trending payload', async () => {
    const { sleeper } = client((u) => (u.pathname.includes('state') ? json({ week: '1' }) : json({})));
    await expect(sleeper.state()).rejects.toBeInstanceOf(SchemaDriftError);
    await expect(sleeper.trending('add')).rejects.toBeInstanceOf(SchemaDriftError);
  });

  it('summarizes many drift issues', async () => {
    const bad = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), { player_id: i }]));
    const { sleeper } = client(() => json(bad));
    await expect(sleeper.players()).rejects.toThrow(/\(\+3 more\)/);
  });

  it('retries server errors through the shared HTTP layer', async () => {
    const { sleeper, calls } = client((u, call) => (call === 1 ? text('', 503) : fixtureRoute(u, call)));
    expect((await sleeper.state()).week).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('surfaces non-retryable HTTP errors', async () => {
    const { sleeper } = client(() => text('forbidden', 403));
    await expect(sleeper.state()).rejects.toBeInstanceOf(HttpStatusError);
  });

  it('validates season and week before calling out', async () => {
    const { sleeper, calls } = client();
    await expect(sleeper.weekStats(2025, 0)).rejects.toThrow(RangeError);
    await expect(sleeper.weekProjections(1990, 1)).rejects.toThrow(RangeError);
    await expect(sleeper.weekStats(2025, 1.5)).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });

  it('supports a custom base URL', async () => {
    const m = mockFetch(fixtureRoute);
    const sleeper = new SleeperClient({
      clock: wallClock,
      fetch: m.fetch,
      limiter: noLimit,
      baseUrl: 'https://proxy.test/',
      timeoutMs: 1000,
      playersTimeoutMs: 2000,
      retry: { maxRetries: 0 },
      random: () => 0
    });
    await sleeper.state();
    expect(m.calls).toEqual(['https://proxy.test/v1/state/nfl']);
  });

  it('shares one process-wide limiter by default', async () => {
    const a = sharedSleeperRateLimiter(wallClock);
    expect(sharedSleeperRateLimiter(wallClock)).toBe(a);
    const m = mockFetch(fixtureRoute);
    const sleeper = new SleeperClient({ clock: wallClock, fetch: m.fetch });
    const before = a.available();
    await sleeper.state();
    expect(a.available()).toBeLessThan(before);
  });
});

describe.skipIf(!process.env.LIVE_DATA_TESTS)('SleeperClient (live network)', () => {
  const live = new SleeperClient({ clock: wallClock });

  it('reads the real NFL state', async () => {
    const state = await live.state();
    expect(Number(state.season)).toBeGreaterThan(2020);
  });

  it('reads real weekly stats and trending adds', async () => {
    const stats = await live.weekStats(2025, 1);
    expect(Object.keys(stats).length).toBeGreaterThan(100);
    expect((await live.trending('add', { limit: 5 })).length).toBeGreaterThan(0);
  });

  it('reads real projections from v1 or the app endpoint', async () => {
    const state = await live.state();
    const week = Math.min(Math.max(state.week, 1), 18);
    const result = await live.weekProjectionsWithSource(Number(state.season), week);
    expect(['v1', 'app']).toContain(result.source);
    expect(Object.keys(await live.appWeekProjections(Number(state.season), week)).length).toBeGreaterThan(0);
  });
});
