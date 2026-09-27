import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings } from '../rules/settings.js';
import { findTierBand, roundPoints, scorePlayer, scoreTeamWeek, type StatLine } from './engine.js';
import { YAHOO_POINTS_ALLOWED_TIERS, scoringPreset, type ScoringSettings } from './settings.js';

const half = scoringPreset('yahoo_standard');
const ppr = scoringPreset('full_ppr');
const std = scoringPreset('standard');

/*
 * Real-game lines (from public box scores). The hand-computed totals below are the contract:
 *   yards × per-yard weight + touchdowns × TD weight + receptions × PPR weight.
 */
// Ja'Marr Chase, 2024 week 10 at BAL: 11 catches, 264 yards, 3 TD.
const chase: StatLine = { rec: 11, rec_yd: 264, rec_td: 3, rec_tgt: 17 };
// Christian McCaffrey, 2023 week 1 at PIT: 22-152-1 rushing, 3-17 receiving.
const cmc: StatLine = { rush_att: 22, rush_yd: 152, rush_td: 1, rec: 3, rec_yd: 17 };
// Josh Allen, 2024 week 1 vs ARI: 232 passing yards, 2 pass TD, 39 rushing yards, 2 rush TD.
const allen: StatLine = { pass_yd: 232, pass_td: 2, pass_int: 0, rush_yd: 39, rush_td: 2 };

describe('scorePlayer: real-player examples by preset', () => {
  it.each([
    ['full_ppr', ppr, 55.4],
    ['half (yahoo_standard)', half, 49.9],
    ['standard', std, 44.4]
  ])('Chase 11-264-3 in %s', (_name, scoring, expected) => {
    // 26.4 yards + 18 TD + 11/5.5/0 receptions
    expect(scorePlayer(scoring, chase).points).toBe(expected);
  });

  it.each([
    ['full_ppr', ppr, 25.9],
    ['half (yahoo_standard)', half, 24.4],
    ['standard', std, 22.9]
  ])('McCaffrey 152 rush + 1 TD + 3-17 in %s', (_name, scoring, expected) => {
    // 15.2 + 6 + 1.7 + 3/1.5/0
    expect(scorePlayer(scoring, cmc).points).toBe(expected);
  });

  it('Allen 232 pass / 2 pass TD / 39 rush / 2 rush TD is 33.18 in every preset', () => {
    // 232 × 0.04 = 9.28; 2 × 4 = 8; 39 × 0.1 = 3.9; 2 × 6 = 12
    for (const scoring of [ppr, half, std]) expect(scorePlayer(scoring, allen).points).toBe(33.18);
  });

  it('kicker: 2 XP, 1 FG in each of 30-39, 40-49, 50+', () => {
    const line: StatLine = { xpm: 2, fgm_30_39: 1, fgm_40_49: 1, fgm_50p: 1, fgm: 3, fga: 3 };
    expect(scorePlayer(half, line).points).toBe(14);
  });

  it('team defense: 4 sacks, 2 INT, 1 fumble recovery, 1 TD, 10 points allowed', () => {
    const line: StatLine = { sack: 4, int: 2, fum_rec: 1, def_td: 1, pts_allow: 10 };
    const score = scorePlayer(half, line);
    expect(score.points).toBe(4 + 4 + 2 + 6 + 4);
    expect(score.breakdown.find((b) => b.stat === 'pts_allow')).toEqual({
      stat: 'pts_allow',
      value: 10,
      points: 4,
      tier: { min: 7, max: 13 }
    });
  });

  it.each([
    [0, 10],
    [1, 7],
    [6, 7],
    [7, 4],
    [14, 1],
    [20, 1],
    [21, 0],
    [27, 0],
    [28, -1],
    [34, -1],
    [35, -4],
    [59, -4]
  ])('points allowed %i scores %i', (pa, pts) => {
    expect(scorePlayer(half, { pts_allow: pa }).points).toBe(pts);
  });

  it('negative plays: interceptions and fumbles lost', () => {
    expect(scorePlayer(half, { pass_yd: 150, pass_int: 3, fum_lost: 1 }).points).toBe(6 - 3 - 2);
  });

  it('two-point conversions and return/fumble-recovery touchdowns', () => {
    expect(scorePlayer(half, { pass_2pt: 1, rush_2pt: 1, rec_2pt: 1, st_td: 1, fum_rec_td: 1 }).points).toBe(
      18
    );
  });
});

describe('scorePlayer mechanics', () => {
  it('ignores stats the league does not weight, and null/undefined/non-finite values', () => {
    const line: StatLine = {
      pts_ppr: 99,
      rec_tgt: 12,
      rec_yd: null,
      rush_yd: undefined,
      pass_yd: Number.NaN,
      rec_td: Number.POSITIVE_INFINITY
    };
    expect(scorePlayer(half, line)).toEqual({ points: 0, breakdown: [] });
  });

  it('only rounds at the end: 3 × 0.04 pass yards stay exact', () => {
    // 1 + 1 + 1 pass yards across a line of odd fractions: 0.04 + 0.1 + 0.5 = 0.64
    expect(scorePlayer(half, { pass_yd: 1, rush_yd: 1, rec: 1 }).points).toBe(0.64);
    // 7 yards × 0.04 = 0.28, 3 yards × 0.1 = 0.3 → 0.58 (no intermediate rounding to 0.3/0.3)
    expect(scorePlayer(half, { pass_yd: 7, rush_yd: 3 }).points).toBe(0.58);
    // A custom weight that only rounds cleanly once summed: 3 × 0.333 + 3 × 0.334 = 2.001 → 2
    const custom: ScoringSettings = { perStat: { a: 0.333, b: 0.334 }, tiers: [] };
    expect(scorePlayer(custom, { a: 3, b: 3 }).points).toBe(2);
  });

  it('breakdown lists each scoring stat with cleaned per-stat points', () => {
    const { breakdown } = scorePlayer(half, { pass_yd: 301, pass_td: 1 });
    expect(breakdown).toEqual([
      { stat: 'pass_yd', value: 301, points: 12.04 },
      { stat: 'pass_td', value: 1, points: 4 }
    ]);
  });

  it('accepts full league settings as well as bare scoring settings', () => {
    const league = yahooDefaultSettings(10, { scoring: 'full_ppr' });
    expect(scorePlayer(league, chase).points).toBe(55.4);
  });

  it('skips a tier stat that falls in no band (a gap)', () => {
    const gappy: ScoringSettings = {
      perStat: {},
      tiers: [{ stat: 'yds_allow', bands: [{ min: 0, max: 99, points: 5 }] }]
    };
    expect(scorePlayer(gappy, { yds_allow: 150 }).points).toBe(0);
    expect(scorePlayer(gappy, { yds_allow: 50 }).points).toBe(5);
  });
});

describe('roundPoints', () => {
  it.each([
    [33.179999999999, 33.18],
    [0.005, 0.01],
    [-0.005, -0.01],
    [-1.234, -1.23],
    [-0.001, 0],
    [2.675, 2.68],
    [0, 0]
  ])('%d → %d', (input, expected) => {
    expect(roundPoints(input)).toBe(expected);
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundPoints(-0.0001), 0)).toBe(true);
  });
});

describe('findTierBand', () => {
  it('uses inclusive bounds and open-ended last band', () => {
    expect(findTierBand(YAHOO_POINTS_ALLOWED_TIERS.bands, 13)?.points).toBe(4);
    expect(findTierBand(YAHOO_POINTS_ALLOWED_TIERS.bands, 500)?.points).toBe(-4);
    expect(findTierBand(YAHOO_POINTS_ALLOWED_TIERS.bands, -1)).toBeUndefined();
  });
});

describe('scoreTeamWeek', () => {
  const lineup = [
    { playerId: 'chase', slot: 'WR' as const },
    { playerId: 'cmc', slot: 'RB' as const },
    { playerId: 'allen', slot: 'BN' as const },
    { playerId: 'hurt', slot: 'IR' as const },
    { playerId: 'bye', slot: 'W/R/T' as const }
  ];
  const lines = { chase, cmc, allen, hurt: { rec: 5, rec_yd: 50 } };

  it('counts starters only and reports bench points separately', () => {
    const week = scoreTeamWeek(half, lineup, lines);
    expect(week.points).toBe(74.3); // 49.9 + 24.4 + 0
    expect(week.starters.map((s) => s.playerId)).toEqual(['chase', 'cmc', 'bye']);
    expect(week.bench.map((s) => s.playerId)).toEqual(['allen', 'hurt']);
    expect(week.benchPoints).toBe(33.18 + 7.5);
  });

  it('marks players without a stat line', () => {
    const week = scoreTeamWeek(half, lineup, lines);
    const bye = week.starters.find((s) => s.playerId === 'bye');
    expect(bye).toMatchObject({ points: 0, hasStats: false, breakdown: [] });
    expect(week.starters[0]?.hasStats).toBe(true);
  });

  it('scores an empty lineup as 0', () => {
    expect(scoreTeamWeek(half, [], {})).toEqual({ points: 0, starters: [], bench: [], benchPoints: 0 });
  });
});
