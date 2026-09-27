import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scorePlayer, scoreTeamWeek, type StatLine } from './engine.js';
import { YAHOO_POINTS_ALLOWED_TIERS, scoringPreset, type ScoringSettings } from './settings.js';

/** Rounding to 2 decimals happens once per call, so comparing two calls can differ by one cent. */
const CENT = 0.0100001;

const STAT_KEYS = [
  'pass_yd',
  'pass_td',
  'pass_int',
  'rush_yd',
  'rush_td',
  'rec',
  'rec_yd',
  'rec_td',
  'fum_lost',
  'xpm'
];

const weight = fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true });
const statValue = fc.oneof(
  fc.integer({ min: 0, max: 600 }),
  fc.double({ min: 0, max: 600, noNaN: true, noDefaultInfinity: true })
);

const perStatArb = fc.dictionary(fc.constantFrom(...STAT_KEYS), weight);
const linearScoring = perStatArb.map((perStat): ScoringSettings => ({ perStat, tiers: [] }));
const statLineArb = fc.dictionary(fc.constantFrom(...STAT_KEYS), statValue);
const presetArb = fc.constantFrom(
  scoringPreset('yahoo_standard'),
  scoringPreset('full_ppr'),
  scoringPreset('standard')
);

function addLines(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

describe('scoring properties', () => {
  it('an empty stat line scores 0 under any settings', () => {
    fc.assert(
      fc.property(fc.oneof(linearScoring, presetArb), (scoring) => {
        expect(scorePlayer(scoring, {})).toEqual({ points: 0, breakdown: [] });
      })
    );
  });

  it('all-zero per-stat values score 0', () => {
    fc.assert(
      fc.property(presetArb, fc.subarray(STAT_KEYS), (scoring, keys) => {
        const line = Object.fromEntries(keys.map((k) => [k, 0]));
        expect(scorePlayer(scoring, line).points).toBe(0);
      })
    );
  });

  it('points are additive over stat lines (within one cent of rounding)', () => {
    fc.assert(
      fc.property(linearScoring, statLineArb, statLineArb, (scoring, a, b) => {
        const sum = scorePlayer(scoring, addLines(a, b)).points;
        const parts = scorePlayer(scoring, a).points + scorePlayer(scoring, b).points;
        expect(Math.abs(sum - parts)).toBeLessThanOrEqual(2 * CENT);
      })
    );
  });

  it('points are additive over individual stats: total equals the breakdown sum', () => {
    fc.assert(
      fc.property(presetArb, statLineArb, (scoring, line) => {
        const { points, breakdown } = scorePlayer(scoring, line);
        const sum = breakdown.reduce((acc, b) => acc + b.points, 0);
        expect(Math.abs(points - sum)).toBeLessThanOrEqual(CENT / 2 + 1e-5);
      })
    );
  });

  it('doubling every per-stat weight doubles the non-tier points', () => {
    fc.assert(
      fc.property(linearScoring, statLineArb, (scoring, line) => {
        const doubled: ScoringSettings = {
          perStat: Object.fromEntries(Object.entries(scoring.perStat).map(([k, w]) => [k, w * 2])),
          tiers: []
        };
        const once = scorePlayer(scoring, line).points;
        expect(Math.abs(scorePlayer(doubled, line).points - 2 * once)).toBeLessThanOrEqual(2 * CENT);
      })
    );
  });

  it('scaling a stat line by an integer k scales linear points by k', () => {
    fc.assert(
      fc.property(linearScoring, statLineArb, fc.integer({ min: 0, max: 5 }), (scoring, line, k) => {
        const scaled = Object.fromEntries(Object.entries(line).map(([s, v]) => [s, v * k]));
        const expected = k * scorePlayer(scoring, line).points;
        expect(Math.abs(scorePlayer(scoring, scaled).points - expected)).toBeLessThanOrEqual(k * CENT + CENT);
      })
    );
  });

  it('is independent of the order of per-stat keys', () => {
    fc.assert(
      fc.property(linearScoring, statLineArb, (scoring, line) => {
        const reversed: ScoringSettings = {
          perStat: Object.fromEntries(Object.entries(scoring.perStat).reverse()),
          tiers: []
        };
        expect(Math.abs(scorePlayer(reversed, line).points - scorePlayer(scoring, line).points)).toBeLessThan(
          1e-9
        );
      })
    );
  });

  it('full PPR minus standard equals receptions; half PPR sits exactly halfway', () => {
    fc.assert(
      fc.property(
        fc.record({
          rec: fc.integer({ min: 0, max: 20 }),
          rec_yd: fc.integer({ min: -10, max: 300 }),
          rec_td: fc.integer({ min: 0, max: 4 })
        }),
        (line: StatLine) => {
          const p = scorePlayer(scoringPreset('full_ppr'), line).points;
          const h = scorePlayer(scoringPreset('yahoo_standard'), line).points;
          const s = scorePlayer(scoringPreset('standard'), line).points;
          expect(p - s).toBeCloseTo(line.rec ?? 0, 9);
          expect(h - s).toBeCloseTo((line.rec ?? 0) / 2, 9);
        }
      )
    );
  });

  it('points-allowed tiers: every non-negative integer hits exactly one band, never rising with more points', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 80 }), (pa) => {
        const matches = YAHOO_POINTS_ALLOWED_TIERS.bands.filter(
          (b) => pa >= b.min && (b.max === null || pa <= b.max)
        );
        expect(matches).toHaveLength(1);
        const scoring = scoringPreset();
        expect(scorePlayer(scoring, { pts_allow: pa + 1 }).points).toBeLessThanOrEqual(
          scorePlayer(scoring, { pts_allow: pa }).points
        );
      })
    );
  });

  it('team week points depend only on starters', () => {
    const slot = fc.constantFrom('QB', 'WR', 'RB', 'BN', 'IR') as fc.Arbitrary<
      'QB' | 'WR' | 'RB' | 'BN' | 'IR'
    >;
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ playerId: fc.string({ minLength: 1, maxLength: 4 }), slot }), {
          selector: (e) => e.playerId,
          maxLength: 8
        }),
        fc.array(statLineArb, { minLength: 8, maxLength: 8 }),
        presetArb,
        (lineup, lines, scoring) => {
          const byPlayer = Object.fromEntries(lineup.map((e, i) => [e.playerId, lines[i]]));
          const week = scoreTeamWeek(scoring, lineup, byPlayer);
          const starters = lineup.filter((e) => e.slot !== 'BN' && e.slot !== 'IR');
          const expected = starters.reduce(
            (acc, e) => acc + scorePlayer(scoring, byPlayer[e.playerId] ?? {}).points,
            0
          );
          expect(week.points).toBeCloseTo(expected, 6);
          expect(week.starters).toHaveLength(starters.length);
          expect(week.bench).toHaveLength(lineup.length - starters.length);
        }
      )
    );
  });
});
