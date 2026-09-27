import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../../test/helpers.js';
import { SchemaDriftError } from '../errors.js';
import type { DataProvider } from '../provider.js';
import { FixtureArchiveStore, FixtureDataProvider, loadFixtureArchive } from './fixture.js';

const at = (iso: string): Date => new Date(iso);

describe('FixtureDataProvider (recorded fixtures)', () => {
  const provider: DataProvider = new FixtureDataProvider();

  it('serves the fixture players with bye weeks once captured', async () => {
    await expect(provider.getPlayers(at('2025-09-01T00:00:00Z'))).rejects.toThrow(/No player snapshot/);
    const players = await provider.getPlayers(at('2025-09-04T00:00:00Z'));
    expect(players).toHaveLength(25);
    expect(players.find((p) => p.id === '4046')).toMatchObject({ name: 'Patrick Mahomes', byeWeek: 10 });
    expect(players.find((p) => p.id === 'PHI')?.byeWeek).toBe(9);
  });

  it('derives week 1 state from the 2025 schedule', async () => {
    expect(await provider.getNflState(at('2025-09-07T12:00:00Z'))).toMatchObject({
      season: 2025,
      seasonType: 'regular',
      week: 1,
      seasonStartDate: '2025-09-05'
    });
  });

  it('gates Sleeper stats by game final', async () => {
    // Thursday night DAL @ PHI final; nobody else yet.
    const thursday = await provider.getWeekStats(2025, 1, at('2025-09-05T04:30:00Z'));
    expect(thursday.map((l) => l.playerId).sort()).toEqual(['11533', '4866', '6786', '6904', 'PHI']);
    const tuesday = await provider.getWeekStats(2025, 1, at('2025-09-09T12:00:00Z'));
    expect(tuesday).toHaveLength(20);
    expect(tuesday.find((l) => l.playerId === '4046')?.stats.pts_ppr).toBe(26.02);
  });

  it('gates projections by capture time and kickoff', async () => {
    expect(await provider.getWeekProjections(2025, 2, at('2025-09-09T00:00:00Z'))).toEqual([]);
    const w2 = await provider.getWeekProjections(2025, 2, at('2025-09-12T00:00:00Z'));
    expect(w2.length).toBeGreaterThan(15);
    const w1 = await provider.getWeekProjections(2025, 1, at('2025-09-20T00:00:00Z'));
    expect(w1.find((l) => l.playerId === '4046')?.stats.pass_yd).toBeGreaterThan(200);
  });

  it('serves trending while fresh and the full schedule', async () => {
    expect((await provider.getTrending('add', at('2025-09-10T00:00:00Z')))[0]?.playerId).toBe('90001');
    expect(await provider.getTrending('drop', at('2025-09-20T00:00:00Z'))).toEqual([]);
    expect(await provider.getSchedule(2025, at('2025-09-01T00:00:00Z'))).toHaveLength(285);
    expect((await provider.getByeWeeks(2025, at('2025-09-01T00:00:00Z'))).GB).toBe(5);
  });

  it('exposes the store for reuse', async () => {
    const store = new FixtureArchiveStore();
    expect(await store.seasons()).toEqual([2025]);
    expect((await store.load(2025))?.players).toHaveLength(1);
    expect(await store.load(2024)).toBeUndefined();
  });
});

describe('loadFixtureArchive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fantasy-fixtures-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('validates fixture files like live responses', async () => {
    cpSync(new URL('.', FIXTURES), dir, { recursive: true });
    writeFileSync(join(dir, 'sleeper/trending_add.json'), JSON.stringify([{ player_id: 1 }]));
    await expect(loadFixtureArchive(pathToFileURL(`${dir}/`))).rejects.toBeInstanceOf(SchemaDriftError);
  });
});
