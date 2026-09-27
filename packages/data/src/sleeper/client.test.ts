import { describe, expect, it } from 'vitest';
import { fixtureJson, fixtureRoute, json, mockFetch, text, wallClock } from '../../test/helpers.js';
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
});
