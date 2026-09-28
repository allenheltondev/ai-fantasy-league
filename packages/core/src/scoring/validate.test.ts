import { describe, expect, it } from 'vitest';
import { scoringPreset } from './settings.js';
import {
  formatScoringReport,
  nflverseReferenceScoring,
  SLEEPER_DEFAULT_DIFFERENCES,
  sleeperDefaultDifference,
  sleeperReferenceScoring,
  validateScoring,
  type KnownDifference,
  type ScoringCase
} from './validate.js';

const receiver = { rec: 5, rec_yd: 80, rec_td: 1 };

describe('reference scorings', () => {
  it("Sleeper's is the league preset for each format, with no miss penalties", () => {
    expect(sleeperReferenceScoring('ppr')).toEqual(scoringPreset('full_ppr'));
    expect(sleeperReferenceScoring('half_ppr')).toEqual(scoringPreset('yahoo_standard'));
    expect(sleeperReferenceScoring('std')).toEqual(scoringPreset('standard'));
    expect(sleeperReferenceScoring('ppr').perStat.fgmiss).toBeUndefined();
  });

  it("nflverse's charges 2 per interception and scores offense only", () => {
    expect(nflverseReferenceScoring('std').perStat).toMatchObject({ pass_int: -2 });
    expect(nflverseReferenceScoring('std').perStat.rec).toBeUndefined();
    expect(nflverseReferenceScoring('ppr').perStat.xpm).toBeUndefined();
    expect(nflverseReferenceScoring('half_ppr').tiers).toEqual([]);
  });
});

describe('validateScoring', () => {
  it('passes lines that match within a cent and compares only the formats given', () => {
    const report = validateScoring(
      [
        { key: 'a', stats: receiver, expected: { ppr: 19, half_ppr: 16.5, std: 14.005 } },
        { key: 'b', stats: { pass_yd: 250 }, expected: { std: 10 } }
      ],
      sleeperReferenceScoring
    );
    expect(report).toEqual({ cases: 2, comparisons: 4, unexplained: [], explained: [] });
  });

  it('separates explained from unexplained mismatches', () => {
    const extraFumble: KnownDifference = (c, _format, diff) =>
      c.key === 'fumbler' && diff === -2 ? 'return fumble lost' : null;
    const report = validateScoring(
      [
        { key: 'fumbler', stats: { ...receiver, fum_lost: 1 }, expected: { std: 14 } },
        { key: 'wrong', stats: receiver, expected: { ppr: 20 } }
      ],
      sleeperReferenceScoring,
      [extraFumble]
    );
    expect(report.explained).toEqual([
      { key: 'fumbler', format: 'std', expected: 14, actual: 12, diff: -2, explanation: 'return fumble lost' }
    ]);
    expect(report.unexplained).toEqual([
      { key: 'wrong', format: 'ppr', expected: 20, actual: 19, diff: -1, explanation: null }
    ]);
    expect(formatScoringReport(report).split('\n')).toEqual([
      '2 lines, 2 comparisons, 1 unexplained and 1 explained mismatches',
      'wrong ppr: expected 20, engine 19 (-1)',
      'fumbler std: expected 14, engine 12 (-2) — return fumble lost'
    ]);
    expect(
      formatScoringReport(
        validateScoring([{ key: 'x', stats: {}, expected: { std: -1 } }], sleeperReferenceScoring)
      )
    ).toContain('x std: expected -1, engine 0 (+1)');
  });
});

describe("Sleeper's intended differences", () => {
  const explain = sleeperDefaultDifference();
  const line = (stats: ScoringCase['stats']): ScoringCase => ({ key: 'x', stats, expected: {} });
  const delta = (id: string, stats: ScoringCase['stats']): number =>
    SLEEPER_DEFAULT_DIFFERENCES.find((d) => d.id === id)?.sleeperMinusOurs(stats) ?? NaN;

  it('computes each class from the line', () => {
    expect(delta('missed-kicks', { fgmiss: 1, xpmiss: 2, fgm_40_49: 1 })).toBe(-3);
    expect(delta('idp', { idp_sack: 1.5, idp_int: 1, idp_ff: 1, idp_tkl_solo: 6, idp_qb_hit: 2 })).toBe(4.5);
    expect(delta('idp', { idp_fum_rec: 1, idp_def_td: 1, idp_blk_kick: 1, idp_safe: 1 })).toBe(12);
    expect(delta('points-allowed-14-20', { pts_allow: 14 })).toBe(-1);
    expect(delta('points-allowed-14-20', { pts_allow: 20 })).toBe(-1);
    expect(delta('points-allowed-14-20', { pts_allow: 13 })).toBe(0);
    expect(delta('points-allowed-14-20', { pts_allow: 21 })).toBe(0);
    expect(delta('points-allowed-14-20', { sack: 3 })).toBe(0);
    expect(delta('def-forced-fumbles', { ff: 2 })).toBe(2);
    expect(delta('def-special-teams-fumble-recoveries', { def_st_fum_rec: 1 })).toBe(-1);
    expect(delta('def-special-teams-forced-fumbles', { def_st_ff: 2, ff: 3 })).toBe(2);
    // A player's st_ff is also in idp_ff, so only st_fum_rec is counted here.
    expect(delta('special-teams-fumble-recoveries', { st_fum_rec: 1, st_ff: 1 })).toBe(1);
  });

  it('applies a difference Sleeper dropped only to the seasons it covered', () => {
    const allowed17 = line({ pts_allow: 17, sack: 1 });
    expect(sleeperDefaultDifference({ season: 2025 })(allowed17, 'std', 1)).toMatch(/^points-allowed-14-20 /);
    expect(sleeperDefaultDifference({ season: 2026 })(allowed17, 'std', 1)).toBeNull();
    expect(sleeperDefaultDifference({ season: 2026 })(allowed17, 'std', 0.5)).toBeNull();
    // With no season given, every class applies.
    expect(explain(allowed17, 'std', 1)).toMatch(/^points-allowed-14-20 /);
  });

  it('explains a mismatch that is exactly the sum of the classes on the line', () => {
    // A kicker who missed a FG: Sleeper 1 point lower, so the engine is 1 higher.
    expect(explain(line({ fgm_30_39: 1, fgmiss: 1 }), 'ppr', 1)).toBe(
      'missed-kicks (-1): Sleeper charges -1 per missed field goal and extra point, Yahoo charges 0'
    );
    // A defense allowing 17 with 2 forced fumbles: Sleeper 0 + 2, we 1 + 0.
    expect(explain(line({ pts_allow: 17, ff: 2, sack: 1 }), 'std', -1)).toMatch(
      /^points-allowed-14-20 \(-1\): .*; def-forced-fumbles \(\+2\): /
    );
    expect(explain(line({ idp_sack: 1 }), 'half_ppr', -1)).toMatch(/^idp \(\+1\): /);
  });

  it('leaves partial and unrelated mismatches unexplained', () => {
    expect(explain(line({ fgmiss: 1 }), 'ppr', 2)).toBeNull();
    expect(explain(line(receiver), 'ppr', -1)).toBeNull();
    expect(explain(line({ idp_sack: 1 }), 'ppr', -2)).toBeNull();
    expect(sleeperDefaultDifference({ differences: [] })(line(receiver), 'ppr', 0)).toBeNull();
  });

  it('explains whole points missing from an early recording, within bounds', () => {
    const early = sleeperDefaultDifference({ missingKeys: true });
    // A team defense short 3 forced fumbles, on top of the 14-20 difference.
    expect(early(line({ pts_allow: 17, sack: 2 }), 'ppr', -2)).toMatch(
      /^points-allowed-14-20 \(-1\): .*; missing-keys \(\+3\): this early recording has no ff\/st_ff\/st_fum_rec/
    );
    // A player short one special-teams play, and nothing else.
    expect(early(line({ idp_tkl_solo: 1 }), 'ppr', -1)).toMatch(/^missing-keys \(\+1\): /);
    // Never more than one play for a player, never a fraction, never in our favor.
    expect(early(line({ idp_tkl_solo: 1 }), 'ppr', -2)).toBeNull();
    expect(early(line(receiver), 'ppr', -0.5)).toBeNull();
    expect(early(line(receiver), 'ppr', 1)).toBeNull();
    // Not an early recording: the same shortfall stays unexplained.
    expect(explain(line({ idp_tkl_solo: 1 }), 'ppr', -1)).toBeNull();
  });

  it('reports mixed sets through validateScoring', () => {
    const report = validateScoring(
      [
        { key: 'K', stats: { fgm_30_39: 2, xpmiss: 1 }, expected: { ppr: 5, std: 5 } },
        { key: 'LB', stats: { idp_sack: 2, idp_tkl_solo: 5 }, expected: { ppr: 2 } },
        { key: 'WR', stats: receiver, expected: { ppr: 18 } }
      ],
      sleeperReferenceScoring,
      [explain]
    );
    expect(report.explained.map((m) => `${m.key} ${m.format}`)).toEqual(['K ppr', 'K std', 'LB ppr']);
    expect(report.unexplained.map((m) => m.key)).toEqual(['WR']);
  });
});
