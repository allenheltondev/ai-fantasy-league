import { describe, expect, it } from 'vitest';
import { fixtureRoute, mockFetch, wallClock } from '../../test/helpers.js';
import { NflverseClient } from '../nflverse/client.js';
import { LiveDataProvider } from '../providers/live.js';
import { SleeperClient } from '../sleeper/client.js';
import { buildSeasonLines, compactStats, fetchSeasonLines } from './lines.js';

const asOf = new Date('2025-09-20T12:00:00Z');

function live() {
  const m = mockFetch(fixtureRoute);
  const provider = new LiveDataProvider({
    sleeper: new SleeperClient({
      clock: wallClock,
      fetch: m.fetch,
      limiter: { acquire: async () => undefined }
    }),
    nflverse: new NflverseClient({ fetch: m.fetch, sleep: async () => undefined })
  });
  return { provider, calls: m.calls };
}

describe('compactStats', () => {
  it('keeps scoring keys and games played, drops Sleeper points, ranks, and scoreless zeros', () => {
    expect(
      compactStats({ gp: 1, pass_yd: 250, pts_ppr: 20, rank_ppr: 3, int: 0, pts_allow: 0, fga: 2 })
    ).toEqual({ gp: 1, pass_yd: 250, pts_allow: 0, fga: 2 });
  });
});

describe('buildSeasonLines', () => {
  it('groups weeks per player in week order, keeps the latest team, and skips other seasons', () => {
    const lines = buildSeasonLines(2025, [
      { playerId: '7', season: 2025, week: 2, team: 'NYJ', stats: { rec: 3 } },
      { playerId: '7', season: 2025, week: 1, team: 'KC', stats: { rec: 1 } },
      { playerId: '7', season: 2024, week: 3, stats: { rec: 9 } },
      { playerId: '3', season: 2025, week: 1, stats: { pts_ppr: 4 } }
    ]);
    expect(lines).toEqual([
      {
        playerId: '7',
        season: 2025,
        team: 'NYJ',
        weeks: [
          { week: 1, stats: { rec: 1 } },
          { week: 2, stats: { rec: 3 } }
        ]
      }
    ]);
  });
});

describe('fetchSeasonLines (recorded Sleeper fixtures)', () => {
  it('pulls weeks 1-18 of stats and folds them per player', async () => {
    const { provider, calls } = live();
    const season = await fetchSeasonLines(provider, 'stats', 2025, asOf);
    expect(calls.filter((c) => c.includes('/v1/stats/nfl/regular/2025/'))).toHaveLength(18);
    expect(season.weeks).toEqual([1, 2]);
    const mahomes = season.lines.find((l) => l.playerId === '4046');
    expect(mahomes?.weeks.map((w) => w.week)).toEqual([1, 2]);
    expect(mahomes?.weeks[0]?.stats).toMatchObject({ gp: 1, pass_yd: 258, rush_td: 1 });
    expect(mahomes?.weeks[0]?.stats.pts_ppr).toBeUndefined();
    const kc = season.lines.find((l) => l.playerId === 'KC');
    expect(kc?.weeks[0]?.stats).toMatchObject({ pts_allow: 27, sack: 2 });
  });

  it('pulls the weekly projections the same way', async () => {
    const { provider, calls } = live();
    const season = await fetchSeasonLines(provider, 'projections', 2025, asOf);
    expect(calls.filter((c) => c.includes('/v1/projections/nfl/regular/2025/'))).toHaveLength(18);
    expect(season.weeks).toEqual([1, 2]);
    expect(season.lines.find((l) => l.playerId === '96')?.weeks[0]?.stats.pass_yd).toBe(231.8);
    // Weeks 3-18 have no v1 projections, so each fell back to the (empty) app endpoint (#184).
    expect(season.sources).toEqual({ v1: [1, 2], app: Array.from({ length: 16 }, (_, i) => i + 3) });
    expect(calls.filter((c) => c.startsWith('https://api.sleeper.com/projections/nfl/2025/'))).toHaveLength(
      16
    );
  });

  it('reports no sources for stats or a provider that does not track them', async () => {
    const { provider } = live();
    expect((await fetchSeasonLines(provider, 'stats', 2025, asOf)).sources).toBeUndefined();
    const plain = {
      getWeekStats: provider.getWeekStats.bind(provider),
      getWeekProjections: provider.getWeekProjections.bind(provider)
    };
    expect((await fetchSeasonLines(plain, 'projections', 2025, asOf)).sources).toBeUndefined();
  });
});
