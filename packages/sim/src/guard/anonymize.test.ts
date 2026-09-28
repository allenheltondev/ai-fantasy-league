import { FixedClock } from '@fantasy/core';
import { HistoricalDataProvider, InMemoryArchiveStore, type Player } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { fixtureArchive } from '../../test/helpers.js';
import { toSeasonArchive } from '../archive/season-archive.js';
import { PlayerAnonymizer } from './anonymize.js';
import { AsOfGuardedProvider } from './guard.js';

const player = (id: string, name: string, position = 'WR'): Player => ({
  id,
  name,
  firstName: name.split(' ')[0] ?? '',
  lastName: name.split(' ')[1] ?? '',
  team: 'CIN',
  position,
  fantasyPositions: [position],
  status: 'Active',
  injuryStatus: null,
  depthChartOrder: 1,
  depthChartPosition: position,
  active: true,
  gsisId: '00-0036900',
  searchNames: [name.toLowerCase()]
});

describe('PlayerAnonymizer', () => {
  it('replaces names and search names, keeps ids, teams, and positions, and hides the GSIS id', () => {
    const a = new PlayerAnonymizer('seed');
    const out = a.anonymize(player('7564', "Ja'Marr Chase"));
    expect(out.id).toBe('7564');
    expect(out.team).toBe('CIN');
    expect(out.name).not.toContain('Chase');
    expect(out.name).toBe(`${out.firstName} ${out.lastName}`);
    expect(out.searchNames).toEqual([out.name.toLowerCase()]);
    expect(out.gsisId).toBeUndefined();
  });

  it('is stable per seed and universe regardless of the order players are asked for', () => {
    const ids = Array.from({ length: 50 }, (_, i) => String(1000 + i));
    const forward = new PlayerAnonymizer('s');
    forward.assign(ids);
    const backward = new PlayerAnonymizer('s');
    backward.assign([...ids].reverse());
    for (const id of ids) expect(backward.pseudonym(id)).toEqual(forward.pseudonym(id));
    const other = new PlayerAnonymizer('other');
    other.assign(ids);
    expect(ids.some((id) => other.pseudonym(id).name !== forward.pseudonym(id).name)).toBe(true);
  });

  it('never gives two players the same pseudonym, even past the name table size', () => {
    const a = new PlayerAnonymizer();
    const ids = Array.from({ length: 3000 }, (_, i) => `p${i}`);
    a.assign(ids);
    const names = new Set(ids.map((id) => a.pseudonym(id).name));
    expect(names.size).toBe(ids.length);
    expect([...names].some((n) => / [IVX]+$/.test(n))).toBe(true);
  });

  it('leaves team defenses alone', () => {
    const def = player('KC', 'Kansas City Chiefs', 'DEF');
    expect(new PlayerAnonymizer().anonymize(def)).toBe(def);
  });

  it('is a guard flag: getPlayers serves pseudonyms, everything else is unchanged', async () => {
    const archive = await fixtureArchive();
    const inner = new HistoricalDataProvider(new InMemoryArchiveStore([toSeasonArchive(archive)]));
    const clock = new FixedClock(archive.weeks[2]!.injuriesCapturedAt);
    const plain = new AsOfGuardedProvider(inner, clock);
    const masked = new AsOfGuardedProvider(inner, clock, { anonymizePlayers: true, anonymizeSeed: 7 });
    const real = await plain.getPlayers();
    const fake = await masked.getPlayers();
    expect(fake.map((p) => p.id)).toEqual(real.map((p) => p.id));
    const realNames = new Set(real.filter((p) => p.position !== 'DEF').map((p) => p.name));
    for (const p of fake.filter((x) => x.position !== 'DEF')) expect(realNames.has(p.name)).toBe(false);
    expect(await masked.getPlayers()).toEqual(fake);
    expect(await masked.getWeekStats(2025, 1)).toEqual(await plain.getWeekStats(2025, 1));
  });
});
