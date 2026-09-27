import { describe, expect, it } from 'vitest';
import { fixtureJson, fixtureText } from '../../test/helpers.js';
import { SchemaDriftError } from '../errors.js';
import { normalizePlayers, normalizeWeekStats } from '../sleeper/normalize.js';
import { sleeperPlayersSchema, sleeperWeekStatsSchema } from '../sleeper/schemas.js';
import type { StatMap } from '../types.js';
import { buildCrosswalk, parseIdMap } from './crosswalk.js';
import { NFLVERSE_TO_SLEEPER, mapNflverseStats, parseNflverseWeeklyStats } from './stats.js';

const csv = fixtureText('nflverse/stats_player_week_2025.csv');
const players = normalizePlayers(sleeperPlayersSchema.parse(fixtureJson('sleeper/players.json')));
const { crosswalk } = buildCrosswalk(players, parseIdMap(fixtureText('nflverse/db_playerids.csv')));
const lines = parseNflverseWeeklyStats(csv, crosswalk);

/** nflverse's own scoring (standard; INT and fumbles lost are -2). */
function nflverseStandard(s: StatMap): number {
  const v = (k: string): number => s[k] ?? 0;
  return (
    v('pass_yd') * 0.04 +
    v('pass_td') * 4 -
    v('pass_int') * 2 +
    v('rush_yd') * 0.1 +
    v('rush_td') * 6 +
    v('rec_yd') * 0.1 +
    v('rec_td') * 6 +
    (v('pass_2pt') + v('rush_2pt') + v('rec_2pt')) * 2 -
    v('fum_lost') * 2 +
    v('st_td') * 6
  );
}

describe('parseNflverseWeeklyStats (fixture: 18 players, 2025 weeks 1-2)', () => {
  it('parses every row and keys them by Sleeper id through the crosswalk', () => {
    expect(lines).toHaveLength(36);
    expect(crosswalk.unmappedGsis(lines.map((l) => l.gsisId))).toEqual([]);
    const mahomes = lines.find((l) => l.playerId === '4046' && l.week === 1);
    expect(mahomes).toMatchObject({
      gsisId: '00-0033873',
      name: 'Patrick Mahomes',
      position: 'QB',
      season: 2025,
      seasonType: 'regular',
      team: 'KC',
      opponent: 'LAC',
      fantasyPoints: 26.02,
      fantasyPointsPpr: 26.02
    });
    expect(mahomes?.stats).toEqual({
      gp: 1,
      pass_cmp: 24,
      pass_att: 39,
      pass_yd: 258,
      pass_td: 1,
      pass_sack: 2,
      pass_fd: 9,
      rush_att: 6,
      rush_yd: 57,
      rush_td: 1,
      rush_fd: 5
    });
  });

  it('maps team codes (LA → LAR) and kicker distance buckets', () => {
    expect(lines.find((l) => l.playerId === '9493')?.team).toBe('LAR');
    const aubrey = lines.find((l) => l.playerId === '11533' && l.week === 2);
    expect(aubrey?.stats).toMatchObject({
      fgm: 4,
      fga: 4,
      fgm_40_49: 2,
      fgm_50_59: 1,
      fgm_60p: 1,
      fgm_50p: 2,
      fgm_yds: 205,
      xpm: 4,
      xpa: 4
    });
  });

  it('reproduces nflverse fantasy_points and fantasy_points_ppr from the mapped Sleeper keys', () => {
    for (const line of lines) {
      const std = nflverseStandard(line.stats);
      expect(std, `${line.name} week ${line.week}`).toBeCloseTo(line.fantasyPoints, 2);
      expect(std + (line.stats.rec ?? 0), `${line.name} week ${line.week}`).toBeCloseTo(
        line.fantasyPointsPpr,
        2
      );
    }
  });

  it('agrees with the Sleeper-shaped stat fixture on shared keys', () => {
    for (const week of [1, 2]) {
      const sleeper = normalizeWeekStats(
        sleeperWeekStatsSchema.parse(fixtureJson(`sleeper/stats_regular_2025_${week}.json`)),
        2025,
        week
      );
      for (const s of sleeper.filter((l) => /^\d+$/.test(l.playerId) && l.stats.gp)) {
        const n = lines.find((l) => l.playerId === s.playerId && l.week === week);
        expect(n, s.playerId).toBeDefined();
        for (const key of ['pass_yd', 'pass_td', 'rush_yd', 'rec', 'rec_yd', 'rec_td', 'fgm', 'xpm']) {
          expect(n?.stats[key] ?? 0, `${s.playerId}.${key}`).toBe(s.stats[key] ?? 0);
        }
      }
    }
  });

  it('falls back to the gsis id without a crosswalk', () => {
    const raw = parseNflverseWeeklyStats(csv);
    expect(raw[0]?.playerId).toBe(raw[0]?.gsisId);
  });

  it('marks postseason rows, skips rows without ids, and handles free agents', () => {
    const header = csv.slice(0, csv.indexOf('\n'));
    const cols = header.split(',');
    const make = (values: Record<string, string>): string => cols.map((c) => values[c] ?? '').join(',');
    const text = [
      header,
      make({
        player_id: '00-1',
        season: '2025',
        week: '19',
        season_type: 'POST',
        team: 'FA',
        receptions: '2'
      }),
      make({ player_id: '', season: '2025', week: '1' })
    ].join('\n');
    const parsed = parseNflverseWeeklyStats(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      seasonType: 'post',
      opponent: null,
      position: null,
      name: '00-1',
      fantasyPoints: 0
    });
    expect(parsed[0]?.team).toBeUndefined();
    expect(parsed[0]?.stats).toEqual({ gp: 1, rec: 2 });
  });

  it('raises SchemaDriftError when a required column disappears', () => {
    expect(() => parseNflverseWeeklyStats(csv.replace('passing_yards', 'pass_yards'))).toThrow(
      SchemaDriftError
    );
  });
});

describe('mapNflverseStats', () => {
  it('every mapped nflverse column exists in the real stats file header', () => {
    const header = new Set(csv.slice(0, csv.indexOf('\n')).split(','));
    for (const columns of Object.values(NFLVERSE_TO_SLEEPER)) {
      for (const c of columns) expect(header.has(c), c).toBe(true);
    }
  });

  it('rounds sums and omits zeros', () => {
    expect(mapNflverseStats({ passing_yards: '0', receptions: '1.0000001', def_sacks: '0.5' })).toEqual({
      gp: 1,
      rec: 1,
      idp_sack: 0.5
    });
  });
});
