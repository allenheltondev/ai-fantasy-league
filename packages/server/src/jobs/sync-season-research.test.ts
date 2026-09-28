import { FixedClock } from '@fantasy/core';
import { FixtureDataProvider, type NflState, type StatLine } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { createTestJobDeps, nflState, sourcePlayer, StubProvider } from '../../test/support/jobs.js';
import { researchSeasons } from '../players/research.js';
import { seasonLinesHash, syncSeasonResearch } from './sync-season-research.js';
import { syncPlayers } from './sync-players.js';

const AT = '2026-08-20T12:00:00.000Z';

/** A stub whose weekly stats differ by week (the shared stub answers every week alike). */
class WeeklyProvider extends StubProvider {
  weekly: Record<number, StatLine[]> = {};
  override async getWeekStats(season: number, week: number): Promise<StatLine[]> {
    this.calls.push(`getWeekStats:${season}:${week}`);
    return structuredClone(this.weekly[week] ?? []);
  }
}

const line = (playerId: string, season: number, week: number, stats: Record<string, number>) => ({
  playerId,
  season,
  week,
  stats
});

async function setup(state: Partial<NflState>, provider = new WeeklyProvider()) {
  const deps = createTestJobDeps({ provider, clock: new FixedClock(AT) });
  await deps.reference.nflState.put({ ...nflState(state), updatedAt: AT }, null);
  return { provider, deps };
}

const PRESEASON_2026 = { season: 2026, leagueSeason: 2026, previousSeason: 2025, seasonType: 'pre' } as const;

describe('researchSeasons', () => {
  it('drafts for the league season and looks back one', () => {
    expect(researchSeasons({ season: 2026, leagueSeason: 2026, previousSeason: 2025 })).toEqual({
      season: 2026,
      lastSeason: 2025
    });
    // The offseason: Sleeper has moved league_season ahead of season.
    expect(researchSeasons({ season: 2025, leagueSeason: 2026, previousSeason: 2024 })).toEqual({
      season: 2026,
      lastSeason: 2025
    });
  });
});

describe('syncSeasonResearch', () => {
  it('skips without an NFL state', async () => {
    const deps = createTestJobDeps({ provider: new WeeklyProvider() });
    expect(await syncSeasonResearch(deps, deps.clock)).toEqual({ status: 'skipped', reason: 'no_nfl_state' });
  });

  it('stores last season from the recorded Sleeper fixtures', async () => {
    const provider = new FixtureDataProvider();
    const deps = createTestJobDeps({ provider, clock: new FixedClock(AT) });
    await deps.reference.nflState.put({ ...nflState(PRESEASON_2026), updatedAt: AT }, null);
    const result = await syncSeasonResearch(deps, deps.clock);
    expect(result).toMatchObject({
      status: 'ok',
      season: 2026,
      lastSeason: 2025,
      sets: [
        { kind: 'stats', season: 2025, stored: true, weeks: 2 },
        { kind: 'projections', season: 2026, stored: false, reason: 'no_data' }
      ]
    });
    const [mahomes] = await deps.reference.seasons.get('stats', 2025, ['4046']);
    expect(mahomes?.weeks.map((w) => w.week)).toEqual([1, 2]);
    expect(mahomes?.weeks[0]?.stats).toMatchObject({ gp: 1, pass_yd: 258 });
    expect(await deps.reference.seasons.getMeta('stats', 2025)).toMatchObject({ weeks: [1, 2] });
  });

  it('pulls final stats once, and projections daily in the preseason when they change', async () => {
    const { provider, deps } = await setup(PRESEASON_2026);
    provider.weekly = Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [i + 1, [line('1', 2025, i + 1, { gp: 1, rec: 2 })]])
    );
    provider.projections[1] = [line('1', 2026, 1, { rec: 5 })];
    await syncSeasonResearch(deps, deps.clock);
    expect(provider.calls.filter((c) => c.startsWith('getWeekStats'))).toHaveLength(18);
    expect(provider.calls.filter((c) => c.startsWith('getWeekProjections:2026'))).toHaveLength(18);

    provider.calls.length = 0;
    deps.clock.advance(86_400_000);
    expect(await syncSeasonResearch(deps, deps.clock)).toMatchObject({
      sets: [
        { kind: 'stats', stored: false, reason: 'final' },
        { kind: 'projections', stored: false, reason: 'unchanged' }
      ]
    });
    expect(provider.calls.some((c) => c.startsWith('getWeekStats'))).toBe(false);

    provider.projections[2] = [line('1', 2026, 2, { rec: 4 })];
    expect(await syncSeasonResearch(deps, deps.clock)).toMatchObject({
      sets: [{ kind: 'stats' }, { kind: 'projections', stored: true, players: 1, weeks: 2 }]
    });
    const [proj] = await deps.reference.seasons.get('projections', 2026);
    expect(proj?.weeks).toEqual([
      { week: 1, stats: { rec: 5 } },
      { week: 2, stats: { rec: 4 } }
    ]);
  });

  it('refreshes incomplete in-season projections and keeps only the synced universe', async () => {
    const { provider, deps } = await setup({ ...PRESEASON_2026, seasonType: 'regular', week: 3 });
    provider.players = [sourcePlayer({ id: '1' })];
    await syncPlayers(deps, deps.clock);
    provider.weekly[1] = [line('1', 2025, 1, { gp: 1, rec: 2 }), line('999', 2025, 1, { gp: 1, rec: 9 })];
    provider.projections[1] = [line('1', 2026, 1, { rec: 5 })];
    expect(await syncSeasonResearch(deps, deps.clock)).toMatchObject({
      sets: [
        { kind: 'stats', stored: true, players: 1 },
        { kind: 'projections', stored: true }
      ]
    });
    expect(await syncSeasonResearch(deps, deps.clock)).toMatchObject({
      sets: [
        { kind: 'stats', stored: false, reason: 'unchanged' },
        { kind: 'projections', stored: false, reason: 'unchanged' }
      ]
    });
  });

  it('fills missing projection weeks before freezing a complete in-season snapshot', async () => {
    const { provider, deps } = await setup({ ...PRESEASON_2026, seasonType: 'regular', week: 3 });
    provider.projections[1] = [line('1', 2026, 1, { rec: 5 })];
    await syncSeasonResearch(deps, deps.clock);
    provider.projections = Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [i + 1, [line('1', 2026, i + 1, { rec: 5 })]])
    );
    expect(await syncSeasonResearch(deps, deps.clock)).toMatchObject({
      sets: [{ kind: 'stats' }, { kind: 'projections', stored: true, weeks: 18 }]
    });
    provider.calls.length = 0;
    expect(await syncSeasonResearch(deps, deps.clock)).toMatchObject({
      sets: [{ kind: 'stats' }, { kind: 'projections', reason: 'in_season' }]
    });
    expect(provider.calls.some((c) => c.startsWith('getWeekProjections'))).toBe(false);
  });

  it('fails the run on a source error, so the schedule retries it', async () => {
    const { provider, deps } = await setup(PRESEASON_2026);
    provider.getWeekStats = async () => {
      throw new Error('Sleeper is down');
    };
    await expect(syncSeasonResearch(deps, deps.clock)).rejects.toThrow('Sleeper is down');
  });

  it('hashes content, not order', () => {
    const a = [{ playerId: '1', season: 2025, weeks: [{ week: 1, stats: { rec: 1, rec_yd: 9 } }] }];
    const b = [{ playerId: '1', season: 2025, weeks: [{ week: 1, stats: { rec_yd: 9, rec: 1 } }] }];
    expect(seasonLinesHash(a)).toBe(seasonLinesHash(b));
    expect(seasonLinesHash(a)).not.toBe(seasonLinesHash([{ ...a[0]!, team: 'KC' }]));
  });
});
