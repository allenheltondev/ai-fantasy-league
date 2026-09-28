import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scorePlayer, type StatLine } from './engine.js';
import { scoringPreset, type ScoringSettings } from './settings.js';
import {
  SCORING_FORMATS,
  SLEEPER_DEFAULT_IDP,
  sleeperDefaultDifference,
  sleeperReferenceScoring,
  validateScoring,
  type ScoringFormat
} from './validate.js';

/**
 * Sleeper's default scoring as the recorded weeks show it, written out as settings: our presets,
 * then each intended difference (docs/rules.md). Scoring a line both ways must always leave a
 * mismatch the difference classes explain exactly.
 */
function sleeperDefaultScoring(format: ScoringFormat): ScoringSettings {
  const ours = sleeperReferenceScoring(format);
  return {
    perStat: { ...ours.perStat, ...SLEEPER_DEFAULT_IDP, fgmiss: -1, xpmiss: -1, ff: 1, def_st_fum_rec: 1 },
    tiers: ours.tiers.map((rule) => ({
      stat: rule.stat,
      bands: rule.bands.map((b) => (b.min === 14 && b.max === 20 ? { ...b, points: 0 } : b))
    }))
  };
}

const KEYS = [
  'pass_yd',
  'pass_td',
  'pass_int',
  'rush_yd',
  'rec',
  'rec_yd',
  'rec_td',
  'fum_lost',
  'fgm_40_49',
  'fgmiss',
  'xpm',
  'xpmiss',
  'sack',
  'int',
  'fum_rec',
  'def_st_fum_rec',
  'ff',
  'def_td',
  'pts_allow',
  ...Object.keys(SLEEPER_DEFAULT_IDP),
  'idp_tkl_solo'
];
const statLine = fc.dictionary(
  fc.constantFrom(...KEYS),
  fc.oneof(
    fc.integer({ min: 0, max: 60 }),
    fc.integer({ min: 0, max: 400 }).map((n) => n / 2)
  )
);

describe('Sleeper difference classes (property)', () => {
  it('explain every mismatch between our presets and Sleeper-style scoring, and nothing is left over', () => {
    fc.assert(
      fc.property(statLine, (stats: StatLine) => {
        const expected = Object.fromEntries(
          SCORING_FORMATS.map((f) => [f, scorePlayer(sleeperDefaultScoring(f), stats).points])
        );
        const report = validateScoring([{ key: 'p', stats, expected }], sleeperReferenceScoring, [
          sleeperDefaultDifference()
        ]);
        expect(report.unexplained).toEqual([]);
        expect(report.comparisons).toBe(3);
      })
    );
  });

  it('never explain a line off by an amount no class covers', () => {
    fc.assert(
      fc.property(statLine, fc.integer({ min: 1, max: 50 }), (stats: StatLine, cents) => {
        const off = scorePlayer(sleeperDefaultScoring('ppr'), stats).points + cents / 100 + 0.001;
        const report = validateScoring(
          [{ key: 'p', stats, expected: { ppr: off } }],
          sleeperReferenceScoring,
          [sleeperDefaultDifference()]
        );
        expect(report.unexplained).toHaveLength(1);
      })
    );
  });

  it('score a special-teams fumble recovery like any other for a team defense', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), (a, b) => {
        const preset = scoringPreset();
        expect(scorePlayer(preset, { fum_rec: a, def_st_fum_rec: b }).points).toBe(2 * (a + b));
      })
    );
  });
});
