import { existsSync, readdirSync } from 'node:fs';
import { formatScoringReport } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { FIXTURES, fixtureJson, fixtureText } from '../../test/helpers.js';
import {
  nflverseScoringCases,
  returnFumbleDifference,
  sleeperScoringCases,
  validateNflverseStats,
  validateSleeperStats
} from './scoring-harness.js';

/**
 * The Phase 1 milestone (#30): the engine's PPR, half-PPR, and standard totals match the source's
 * precomputed totals within 0.01 for every player in every recorded week. Recording more weeks
 * (`node scripts/record-fixtures.mjs --scoring`) widens this test with no code change.
 */

type SleeperFile = Parameters<typeof validateSleeperStats>[0];

const sleeperFiles = [
  ...readdirSync(new URL('sleeper/', FIXTURES))
    .filter((f) => /^stats_regular_\d+_\d+\.json$/.test(f))
    .map((f) => `sleeper/${f}`),
  ...(existsSync(new URL('sleeper/scoring/', FIXTURES))
    ? readdirSync(new URL('sleeper/scoring/', FIXTURES)).map((f) => `sleeper/scoring/${f}`)
    : [])
];
const nflverseFiles = readdirSync(new URL('nflverse/', FIXTURES))
  .filter((f) => /^(scoring_sample|stats_player_week)_\d+\.csv$/.test(f))
  .map((f) => `nflverse/${f}`);

describe('scoring validation against recorded totals', () => {
  it('has fixtures to validate', () => {
    expect(sleeperFiles.length).toBeGreaterThanOrEqual(2);
    expect(nflverseFiles).toContain('nflverse/scoring_sample_2025.csv');
  });

  it.each(sleeperFiles)("matches Sleeper's pts_ppr, pts_half_ppr, and pts_std in %s", (file) => {
    const report = validateSleeperStats(fixtureJson(file) as SleeperFile, file);
    expect(report.comparisons).toBeGreaterThan(0);
    expect(report.unexplained, formatScoringReport(report)).toEqual([]);
  });

  it.each(nflverseFiles)("matches nflverse's fantasy_points in %s", (file) => {
    const report = validateNflverseStats(fixtureText(file));
    expect(report.comparisons).toBe(report.cases * 3);
    expect(report.unexplained, formatScoringReport(report)).toEqual([]);
  });

  it('covers every regular-season player-week of the sample, explaining only return fumbles', () => {
    const report = validateNflverseStats(fixtureText('nflverse/scoring_sample_2025.csv'));
    expect(report.cases).toBeGreaterThan(2000);
    expect(report.explained.length).toBeGreaterThan(0);
    for (const m of report.explained) {
      expect(m.explanation).toMatch(/on returns/);
      expect(m.diff).toBe(-2);
    }
  });
});

describe('harness building blocks', () => {
  it('builds Sleeper cases only for lines with precomputed points', () => {
    expect(
      sleeperScoringCases(
        { a: { rec: 2, pts_ppr: 2 }, b: { pts_half_ppr: 1, pts_std: 0 }, c: { rec: 1 } },
        'wk'
      )
    ).toEqual([
      { key: 'wk a', stats: { rec: 2, pts_ppr: 2 }, expected: { ppr: 2 } },
      { key: 'wk b', stats: { pts_half_ppr: 1, pts_std: 0 }, expected: { half_ppr: 1, std: 0 } }
    ]);
  });

  it('reports a wrong Sleeper total as unexplained', () => {
    const report = validateSleeperStats({ x: { rec: 3, rec_yd: 30, pts_ppr: 7 } }, 'wk1');
    expect(report.unexplained).toEqual([expect.objectContaining({ key: 'wk1 x', format: 'ppr', diff: -1 })]);
  });

  it('reads nflverse rows, skipping the postseason, and notes return fumbles', () => {
    const header =
      'player_id,player_display_name,position,season,week,season_type,team,opponent_team,completions,attempts,passing_yards,passing_tds,passing_interceptions,carries,rushing_yards,rushing_tds,receptions,targets,receiving_yards,receiving_tds,fumbles_lost_total,fg_made,pat_made,fantasy_points,fantasy_points_ppr,receiving_fumbles_lost';
    const csv = [
      header,
      'g1,Returner,WR,2025,1,REG,KC,LAC,,,,,,,,,2,3,20,0,1,,,2,4,0',
      'g2,Receiver,WR,2025,1,REG,KC,LAC,,,,,,,,,2,3,20,0,1,,,0,2,1',
      'g3,Playoff,WR,2025,19,POST,KC,LAC,,,,,,,,,1,1,10,0,0,,,1,2,0'
    ].join('\n');
    const { cases, returnFumblesLost } = nflverseScoringCases(csv);
    expect(cases.map((c) => c.key)).toEqual(['2025 wk1 g1 (Returner)', '2025 wk1 g2 (Receiver)']);
    expect(cases[0]?.expected).toEqual({ std: 2, ppr: 4, half_ppr: 3 });
    expect([...returnFumblesLost]).toEqual([['2025 wk1 g1 (Returner)', 1]]);

    const report = validateNflverseStats(csv);
    expect(report.unexplained).toEqual([]);
    expect(report.explained.map((m) => m.key)).toEqual([
      '2025 wk1 g1 (Returner)',
      '2025 wk1 g1 (Returner)',
      '2025 wk1 g1 (Returner)'
    ]);

    const explain = returnFumbleDifference(returnFumblesLost);
    expect(explain(cases[0] as (typeof cases)[number], 'std', -1)).toBeNull();
    expect(explain(cases[1] as (typeof cases)[number], 'std', -2)).toBeNull();
  });
});
