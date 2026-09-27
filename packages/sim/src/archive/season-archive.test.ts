import { HistoricalDataProvider, InMemoryArchiveStore } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { fixtureArchive, freshArchive } from '../../test/helpers.js';
import { weekMoments } from '../clock/moments.js';
import { toSeasonArchive } from './season-archive.js';
import { FIXTURE_TRIM, trimArchive } from './trim.js';

describe('toSeasonArchive', () => {
  it('produces two player snapshots per week (teams, then injuries) and one stats/projection version', async () => {
    const archive = await fixtureArchive();
    const season = toSeasonArchive(archive);
    expect(season.season).toBe(2025);
    expect(season.players).toHaveLength(archive.manifest.weeks.length * 2);
    for (const week of archive.manifest.weeks) {
      const w = archive.weeks[week]!;
      expect(season.stats[week]).toHaveLength(1);
      expect(season.stats[week]?.[0]?.capturedAt).toBeUndefined();
      expect(season.stats[week]?.[0]?.data).toHaveLength(Object.keys(w.stats).length);
      expect(season.projections[week]?.[0]?.capturedAt).toBe(w.projections.capturedAt);
    }
    expect(season.trending?.add).toHaveLength(archive.manifest.weeks.length);
    expect(season.trending?.drop).toEqual([]);
  });

  it('shows injuries only from the injury snapshot, and maps IR to a reserve status', async () => {
    const archive = await freshArchive();
    const player = archive.players.find((p) => p.position === 'WR')!;
    player.injuries = { 1: 'Out', 2: 'IR' };
    const season = toSeasonArchive(archive);
    const [teams1, hurt1, , hurt2] = season.players;
    expect(teams1?.data.find((p) => p.id === player.id)?.injuryStatus).toBeNull();
    expect(hurt1?.data.find((p) => p.id === player.id)).toMatchObject({
      injuryStatus: 'Out',
      status: 'Active'
    });
    expect(hurt2?.data.find((p) => p.id === player.id)).toMatchObject({
      injuryStatus: 'IR',
      status: 'Injured Reserve'
    });
  });

  it('serves through HistoricalDataProvider with each week gated at its moments', async () => {
    const archive = await fixtureArchive();
    const provider = new HistoricalDataProvider(new InMemoryArchiveStore([toSeasonArchive(archive)]));
    const m = weekMoments(archive.schedule).get(2)!;
    const before = new Date(m.projectionsAt - 1);
    const after = new Date(m.projectionsAt);
    expect(await provider.getWeekProjections(2025, 2, before)).toEqual([]);
    expect((await provider.getWeekProjections(2025, 2, after)).length).toBeGreaterThan(100);
    const team = archive.players.find((p) => p.position === 'DEF')!.id;
    const def = (await provider.getPlayers(after)).find((p) => p.id === team);
    expect(def).toMatchObject({
      position: 'DEF',
      team,
      searchNames: expect.arrayContaining([team.toLowerCase()])
    });
    const lines = await provider.getWeekStats(2025, 1, new Date(m.projectionsAt));
    expect(lines.find((l) => l.playerId === team)?.team).toBe(team);
  });
});

describe('trimArchive', () => {
  it('keeps the best-projected players per position and only the kept weeks', async () => {
    const archive = await fixtureArchive();
    const trimmed = trimArchive(archive, {
      weeks: 2,
      perPosition: { QB: 2, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 }
    });
    expect(trimmed.manifest).toMatchObject({ weeks: [1, 2], fixture: true });
    expect(trimmed.players).toHaveLength(9);
    expect(new Set(trimmed.schedule.map((g) => g.week))).toEqual(new Set([1, 2]));
    const ids = new Set(trimmed.players.map((p) => p.id));
    for (const w of [1, 2]) {
      for (const id of Object.keys(trimmed.weeks[w]!.stats)) expect(ids.has(id)).toBe(true);
      for (const id of Object.keys(trimmed.weeks[w]!.projections.lines)) expect(ids.has(id)).toBe(true);
      for (const t of trimmed.weeks[w]!.trending.add) expect(ids.has(t.playerId)).toBe(true);
    }
    for (const p of trimmed.players) {
      expect(Object.keys(p.teams)).toEqual(['1', '2']);
      if (p.injuries) expect(Object.keys(p.injuries).every((w) => w === '1' || w === '2')).toBe(true);
    }
    expect(trimmed.crosswalk.every((e) => trimmed.players.some((p) => p.gsisId === e.gsisId))).toBe(true);
  });

  it('drops injury maps left empty and fails on a missing week', async () => {
    const archive = await freshArchive();
    const qb = archive.players.find((p) => p.position === 'QB')!;
    qb.injuries = { 4: 'Out' };
    const trimmed = trimArchive(archive, { ...FIXTURE_TRIM, weeks: 1 });
    expect(trimmed.players.find((p) => p.id === qb.id)?.injuries).toBeUndefined();
    delete archive.weeks[1];
    expect(() => trimArchive(archive)).toThrow(/missing week 1/);
  });
});
