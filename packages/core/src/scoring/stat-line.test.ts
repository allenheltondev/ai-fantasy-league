import { describe, expect, it } from 'vitest';
import { statLine } from './stat-line.js';

describe('statLine', () => {
  it('passers: completions, yards, touchdowns, picks, and their own runs', () => {
    expect(statLine('QB', { pass_cmp: 18, pass_att: 27, pass_yd: 212, pass_td: 2 })).toBe(
      '18/27 · 212 yds · 2 TD'
    );
    expect(
      statLine('QB', { pass_cmp: 9, pass_att: 14, pass_yd: 88, pass_int: 1, rush_yd: 31, rush_td: 1 })
    ).toBe('9/14 · 88 yds · 1 INT · 31 rush yds · 1 rush TD');
    expect(statLine('QB', { pass_yd: 300, pass_td: 2 })).toBe('300 yds · 2 TD');
  });

  it('backs lead with carries, then catches and touchdowns', () => {
    expect(statLine('RB', { rush_att: 14, rush_yd: 71, rec: 3, rec_tgt: 4, rec_yd: 22, rush_td: 1 })).toBe(
      '14 car · 71 yds · 3/4 rec · 22 rec yds · 1 TD'
    );
    expect(statLine('RB', { rush_att: 3, rush_yd: -2 })).toBe('3 car · -2 yds');
  });

  it('receivers lead with catches (targets when known)', () => {
    expect(statLine('WR', { rec: 5, rec_tgt: 7, rec_yd: 62, rec_td: 1 })).toBe('5/7 rec · 62 yds · 1 TD');
    expect(statLine('TE', { rec: 2, rec_yd: 19, rush_att: 1, rush_yd: 4 })).toBe(
      '2 rec · 19 yds · 1 car · 4 rush yds'
    );
  });

  it('kickers and defenses', () => {
    expect(statLine('K', { fgm: 2, fga: 3, xpm: 3, xpa: 3 })).toBe('2/3 FG · 3/3 XP');
    expect(statLine('K', { xpm: 1 })).toBe('1 XP');
    expect(statLine('DEF', { pts_allow: 10, sack: 3, int: 1, fum_rec: 1, def_td: 1 })).toBe(
      '10 pts allowed · 3 sacks · 2 TO · 1 TD'
    );
    expect(statLine('DEF', { pts_allow: 0, sack: 1 })).toBe('0 pts allowed · 1 sack');
  });

  it('is null with no line or nothing to show', () => {
    expect(statLine('WR', undefined)).toBeNull();
    expect(statLine('WR', { gp: 1, off_snp: 12 })).toBeNull();
    expect(statLine('QB', {})).toBeNull();
    expect(statLine('K', { fgm_yds: 0 })).toBeNull();
    expect(statLine('DEF', {})).toBeNull();
    expect(statLine('WR', { rec: Number.NaN })).toBeNull();
  });
});
