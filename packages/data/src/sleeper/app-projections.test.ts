import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureJson } from '../../test/helpers.js';
import { SchemaDriftError } from '../errors.js';
import { hasProjectedStats, parseSleeperAppProjections } from './app-projections.js';
import { normalizeWeekStats } from './normalize.js';

const SOURCE = 'sleeper api.sleeper.com/projections/nfl/{season}/{week}';
const parse = (body: unknown, week = 1) => parseSleeperAppProjections(body, week, SOURCE);

describe('parseSleeperAppProjections', () => {
  it('maps the recorded rows to the v1 shape by player id', () => {
    const stats = parse(fixtureJson('sleeper/projection-sources/hand-authored/app_2026_1.json'));
    expect(Object.keys(stats).sort()).toEqual(['4046', '4227', '6904', '9493', '96', 'KC']);
    expect(stats['9493']).toMatchObject({ rec: 7.58, rec_yd: 94.55, pts_half_ppr: 17.18 });
    // Row fields (team, opponent, game id, player) never leak into the stats.
    expect(Object.keys(stats['4046'] ?? {})).not.toContain('last_modified');
    const lines = normalizeWeekStats(stats, 2026, 1, 'projections');
    expect(lines.find((l) => l.playerId === '4227')?.stats.fgm).toBe(1.74);
  });

  it('accepts stats flat on the row and numeric player ids', () => {
    const stats = parse([
      { player_id: 4046, week: '1', team: 'KC', last_modified: 17, pass_yd: 250, pts_ppr: 20, note: 'x' }
    ]);
    expect(stats).toEqual({ '4046': { pass_yd: 250, pts_ppr: 20 } });
  });

  it('coerces numeric strings, drops nulls and non-numbers', () => {
    const stats = parse([{ player_id: '1', stats: { pass_yd: '101.5', rush_yd: null, bad: 'n/a', ok: 3 } }]);
    expect(stats).toEqual({ '1': { pass_yd: 101.5, ok: 3 } });
  });

  it('skips malformed rows and rows for another week when others parse', () => {
    const stats = parse([
      null,
      'row',
      { stats: { pts_ppr: 3 } },
      { player_id: '', stats: { pts_ppr: 3 } },
      { player_id: '2', week: 6, stats: { pts_ppr: 9 } },
      { player_id: '3', stats: { pts_ppr: 4 } }
    ]);
    expect(stats).toEqual({ '3': { pts_ppr: 4 } });
  });

  it('keeps the row that projects something when a player repeats', () => {
    expect(
      parse([
        { player_id: '1', stats: { pts_ppr: 12 } },
        { player_id: '1', stats: { adp_dd_ppr: 40 } }
      ])
    ).toEqual({ '1': { pts_ppr: 12 } });
    expect(
      parse([
        { player_id: '1', stats: { adp_dd_ppr: 40 } },
        { player_id: '1', stats: { pts_ppr: 12 } }
      ])
    ).toEqual({ '1': { pts_ppr: 12 } });
  });

  it('treats null and an empty list as an empty week', () => {
    expect(parse(null)).toEqual({});
    expect(parse([])).toEqual({});
  });

  it('accepts a v1-style map', () => {
    expect(parse({ '4046': { pass_yd: 250, gone: null } })).toEqual({ '4046': { pass_yd: 250 } });
    expect(parse({})).toEqual({});
  });

  it('raises drift only when nothing parses', () => {
    const drift = (() => {
      try {
        parse([{ id: 1 }, { player_id: { nested: true } }]);
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(drift).toBeInstanceOf(SchemaDriftError);
    expect((drift as SchemaDriftError).source).toBe(SOURCE);
    expect((drift as SchemaDriftError).issues[0]?.path).toBe('0.player_id');
    expect(() => parse('rows')).toThrow(/Expected a list of projection rows, received string/);
    expect(() => parse({ players: 'none' })).toThrow(SchemaDriftError);
    expect(() => parse(42)).toThrow(SchemaDriftError);
  });

  it('never throws on a list with at least one well-formed row (property)', () => {
    const junk = fc.oneof(fc.constant(null), fc.string(), fc.integer(), fc.object());
    const good = fc.record({
      player_id: fc.stringMatching(/^[0-9A-Z]{1,5}$/),
      stats: fc.dictionary(fc.stringMatching(/^[a-z_]{1,8}$/), fc.oneof(fc.double(), fc.constant(null)))
    });
    fc.assert(
      fc.property(fc.array(junk), good, fc.array(junk), (before, row, after) => {
        const stats = parse([...before, row, ...after]);
        for (const map of Object.values(stats)) {
          for (const value of Object.values(map)) expect(Number.isFinite(value)).toBe(true);
        }
        expect(Object.keys(stats)).toContain(row.player_id);
      })
    );
  });
});

describe('hasProjectedStats', () => {
  it('ignores ADP, rank, and null values', () => {
    expect(hasProjectedStats({})).toBe(false);
    expect(hasProjectedStats({ adp_dd_ppr: 3, pos_adp_dd_ppr: 1, rank_ppr: 2, pos_rank_ppr: 1 })).toBe(false);
    expect(hasProjectedStats({ pts_ppr: null })).toBe(false);
    expect(hasProjectedStats({ adp_dd_ppr: 3, gp: 1 })).toBe(true);
  });
});
