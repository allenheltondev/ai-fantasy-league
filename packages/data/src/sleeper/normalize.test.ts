import { describe, expect, it } from 'vitest';
import { fixtureJson } from '../../test/helpers.js';
import { normalizeName, normalizeNameNoSuffix } from '../names.js';
import {
  compareIds,
  normalizeInjuryStatus,
  normalizePlayer,
  normalizePlayers,
  normalizeState,
  normalizeTrending,
  normalizeWeekStats
} from './normalize.js';
import {
  sleeperPlayersSchema,
  sleeperStateSchema,
  sleeperTrendingSchema,
  sleeperWeekStatsSchema
} from './schemas.js';

const rawPlayers = sleeperPlayersSchema.parse(fixtureJson('sleeper/players.json'));
const players = normalizePlayers(rawPlayers);
const byId = new Map(players.map((p) => [p.id, p]));

describe('normalizePlayers (fixtures)', () => {
  it('normalizes every fixture player, sorted numerically then by team code', () => {
    expect(players).toHaveLength(Object.keys(rawPlayers).length);
    expect(players.slice(0, 3).map((p) => p.id)).toEqual(['96', '1466', '4034']);
    expect(players.slice(-2).map((p) => p.id)).toEqual(['KC', 'PHI']);
  });

  it('maps a starter into our Player shape', () => {
    expect(byId.get('4046')).toEqual({
      id: '4046',
      name: 'Patrick Mahomes',
      firstName: 'Patrick',
      lastName: 'Mahomes',
      team: 'KC',
      position: 'QB',
      fantasyPositions: ['QB'],
      status: 'Active',
      injuryStatus: null,
      depthChartOrder: 1,
      depthChartPosition: 'QB',
      active: true,
      gsisId: '00-0033873', // Sleeper sends it with a leading space
      age: 29,
      yearsExp: 8,
      number: 15,
      searchNames: ['patrick mahomes']
    });
  });

  it('keeps injury, apostrophes, and free agents', () => {
    expect(byId.get('6794')?.injuryStatus).toBe('Questionable');
    expect(byId.get('7564')?.searchNames).toEqual(['jamarr chase']);
    expect(byId.get('90003')).toMatchObject({ team: null, status: 'Inactive', depthChartOrder: null });
    expect(byId.get('90003')?.number).toBeUndefined();
    expect(byId.get('90004')?.active).toBe(false);
  });

  it('names team defenses and makes them searchable by city, nickname, and code', () => {
    expect(byId.get('KC')).toMatchObject({
      name: 'Kansas City Chiefs',
      position: 'DEF',
      team: 'KC',
      fantasyPositions: ['DEF'],
      searchNames: ['kansas city chiefs', 'chiefs', 'kansas city', 'kc']
    });
    expect(byId.get('KC')?.gsisId).toBeUndefined();
  });
});

describe('normalizePlayer edge cases', () => {
  it('falls back sensibly when Sleeper leaves fields null', () => {
    const p = normalizePlayer({ player_id: '123', number: '12', fantasy_positions: null, position: 'TE' });
    expect(p).toMatchObject({
      name: '123',
      firstName: '',
      lastName: '',
      team: null,
      fantasyPositions: ['TE'],
      active: false,
      number: 12
    });
    expect(normalizePlayer({ player_id: '124' }).fantasyPositions).toEqual([]);
  });

  it('adds a suffix-free search name', () => {
    const p = normalizePlayer({ player_id: '1', first_name: 'Marvin', last_name: 'Harrison Jr.' });
    expect(p.searchNames).toEqual(['marvin harrison jr', 'marvin harrison']);
  });

  it('maps injury statuses and keeps unknown ones raw', () => {
    expect(normalizeInjuryStatus('Out')).toEqual({ injuryStatus: 'Out' });
    expect(normalizeInjuryStatus('Sus')).toEqual({ injuryStatus: 'Suspended' });
    expect(normalizeInjuryStatus(' ')).toEqual({ injuryStatus: null });
    expect(normalizeInjuryStatus(undefined)).toEqual({ injuryStatus: null });
    expect(normalizeInjuryStatus('COV')).toEqual({ injuryStatus: 'Other', injuryStatusRaw: 'COV' });
  });
});

describe('names', () => {
  it('normalizes accents, initials, apostrophes, and suffixes', () => {
    expect(normalizeName('A.J. Brown')).toBe('aj brown');
    expect(normalizeName("D'Andre Swift")).toBe('dandre swift');
    expect(normalizeName('José  Ramírez-Smith')).toBe('jose ramirez smith');
    expect(normalizeNameNoSuffix('Kenneth Walker III')).toBe('kenneth walker');
    expect(normalizeNameNoSuffix('Jr')).toBe('jr');
  });
});

describe('normalizeState', () => {
  it('normalizes the fixture state', () => {
    const state = normalizeState(sleeperStateSchema.parse(fixtureJson('sleeper/state.json')));
    expect(state).toEqual({
      season: 2025,
      seasonType: 'regular',
      week: 1,
      displayWeek: 1,
      leagueSeason: 2025,
      previousSeason: 2024,
      seasonStartDate: '2025-09-04'
    });
  });

  it('fills optional fields and maps unknown season types to off', () => {
    expect(normalizeState({ week: 0, season: '2026', season_type: 'weird' })).toEqual({
      season: 2026,
      seasonType: 'off',
      week: 0,
      displayWeek: 0,
      leagueSeason: 2026,
      previousSeason: 2025,
      seasonStartDate: null
    });
  });
});

describe('normalizeWeekStats', () => {
  it('turns the stats map into sorted stat lines, dropping empty and null entries', () => {
    const raw = sleeperWeekStatsSchema.parse(fixtureJson('sleeper/stats_regular_2025_1.json'));
    const lines = normalizeWeekStats(raw, 2025, 1);
    expect(lines.find((l) => l.playerId === '90002')).toBeUndefined(); // {} in the payload
    expect(lines.find((l) => l.playerId === '4046')).toMatchObject({
      season: 2025,
      week: 1,
      stats: { pass_yd: 258, pass_td: 1, rush_td: 1, pts_ppr: 26.02, pts_half_ppr: 26.02, pts_std: 26.02 }
    });
    expect(lines.find((l) => l.playerId === 'KC')?.stats.pts_allow).toBe(27);
    const nulls = normalizeWeekStats({ '1': { pass_yd: null, rec: 3 } }, 2025, 2);
    expect(nulls).toEqual([{ playerId: '1', season: 2025, week: 2, stats: { rec: 3 } }]);
  });

  it('keeps precomputed totals consistent across formats', () => {
    const raw = sleeperWeekStatsSchema.parse(fixtureJson('sleeper/stats_regular_2025_2.json'));
    for (const line of normalizeWeekStats(raw, 2025, 2)) {
      const rec = line.stats.rec ?? 0;
      expect(line.stats.pts_ppr).toBeCloseTo((line.stats.pts_std ?? 0) + rec, 5);
      expect(line.stats.pts_half_ppr).toBeCloseTo((line.stats.pts_std ?? 0) + rec / 2, 5);
    }
  });
});

describe('normalizeTrending / compareIds', () => {
  it('maps trending entries', () => {
    const raw = sleeperTrendingSchema.parse(fixtureJson('sleeper/trending_drop.json'));
    expect(normalizeTrending(raw)[0]).toEqual({ playerId: '6794', count: 18502 });
  });

  it('orders numeric ids numerically before team codes', () => {
    expect(['KC', '100', '20', 'ARI', '20'].sort(compareIds)).toEqual(['20', '20', '100', 'ARI', 'KC']);
  });
});
