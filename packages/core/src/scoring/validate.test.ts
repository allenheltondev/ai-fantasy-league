import { describe, expect, it } from 'vitest';
import {
  formatScoringReport,
  nflverseReferenceScoring,
  sleeperReferenceScoring,
  validateScoring,
  type KnownDifference
} from './validate.js';

const receiver = { rec: 5, rec_yd: 80, rec_td: 1 };

describe('reference scorings', () => {
  it("Sleeper's adds miss penalties to the Yahoo weights, with reception points per format", () => {
    expect(sleeperReferenceScoring('ppr').perStat).toMatchObject({
      rec: 1,
      fgmiss: -1,
      xpmiss: -1,
      pass_int: -1
    });
    expect(sleeperReferenceScoring('half_ppr').perStat.rec).toBe(0.5);
    expect(sleeperReferenceScoring('std').perStat.rec).toBeUndefined();
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
