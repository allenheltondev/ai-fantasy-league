import { describe, expect, it } from 'vitest';
import {
  IDP_PER_STAT,
  STAT_LABELS,
  ScoringSettingsSchema,
  scoringPreset,
  validateScoringSettings,
  withIdpScoring,
  type ScoringSettings
} from './settings.js';

describe('scoring presets', () => {
  it('yahoo_standard is half-PPR with Yahoo values', () => {
    const s = scoringPreset('yahoo_standard');
    expect(s.perStat).toMatchObject({
      pass_yd: 0.04,
      pass_td: 4,
      pass_int: -1,
      rush_yd: 0.1,
      rush_td: 6,
      rec: 0.5,
      rec_yd: 0.1,
      rec_td: 6,
      fum_lost: -2,
      fgm_0_19: 3,
      fgm_20_29: 3,
      fgm_30_39: 3,
      fgm_40_49: 4,
      fgm_50p: 5,
      xpm: 1,
      sack: 1,
      int: 2,
      fum_rec: 2,
      def_td: 6,
      safe: 2,
      blk_kick: 2
    });
    expect(s.tiers).toHaveLength(1);
    expect(s.tiers[0]?.stat).toBe('pts_allow');
  });

  it('defaults to yahoo_standard', () => {
    expect(scoringPreset()).toEqual(scoringPreset('yahoo_standard'));
  });

  it('full_ppr and standard differ only in reception points', () => {
    const half = scoringPreset('yahoo_standard');
    const full = scoringPreset('full_ppr');
    const std = scoringPreset('standard');
    expect(full.perStat.rec).toBe(1);
    expect(std.perStat.rec).toBeUndefined();
    const { rec: _a, ...halfRest } = half.perStat;
    const { rec: _b, ...fullRest } = full.perStat;
    expect(fullRest).toEqual(halfRest);
    expect(std.perStat).toEqual(halfRest);
  });

  it('returns independent copies', () => {
    const a = scoringPreset();
    a.perStat.pass_td = 6;
    const band = a.tiers[0]?.bands[0];
    if (band) band.points = 99;
    expect(scoringPreset().perStat.pass_td).toBe(4);
    expect(scoringPreset().tiers[0]?.bands[0]?.points).toBe(10);
  });

  it('every preset key has a label and passes the schema and validation with no issues', () => {
    for (const p of ['yahoo_standard', 'full_ppr', 'standard'] as const) {
      const s = scoringPreset(p);
      expect(ScoringSettingsSchema.parse(s)).toEqual(s);
      expect(validateScoringSettings(s)).toEqual([]);
      for (const key of Object.keys(s.perStat)) expect(STAT_LABELS[key]).toBeDefined();
    }
  });

  it('withIdpScoring adds IDP weights without overriding existing ones', () => {
    const base = scoringPreset();
    base.perStat.idp_sack = 3;
    const s = withIdpScoring(base);
    expect(s.perStat.idp_tkl_solo).toBe(IDP_PER_STAT.idp_tkl_solo);
    expect(s.perStat.idp_sack).toBe(3);
    expect(s.perStat.pass_td).toBe(4);
    expect(validateScoringSettings(s)).toEqual([]);
  });
});

describe('ScoringSettingsSchema', () => {
  it('rejects non-Sleeper-shaped keys and non-finite weights', () => {
    expect(ScoringSettingsSchema.safeParse({ perStat: { 'Pass Yards': 1 }, tiers: [] }).success).toBe(false);
    expect(ScoringSettingsSchema.safeParse({ perStat: { pass_yd: Infinity }, tiers: [] }).success).toBe(
      false
    );
    expect(
      ScoringSettingsSchema.safeParse({ perStat: {}, tiers: [{ stat: 'pts_allow', bands: [] }] }).success
    ).toBe(false);
  });
});

describe('validateScoringSettings', () => {
  const codes = (s: ScoringSettings): string[] => validateScoringSettings(s).map((i) => i.code);

  it('warns on unknown stat keys', () => {
    const issues = validateScoringSettings({ perStat: { pass_yds: 0.04 }, tiers: [] });
    expect(issues).toMatchObject([
      { code: 'UNKNOWN_STAT_KEY', severity: 'warning', path: 'scoring.perStat.pass_yds' }
    ]);
  });

  it('flags duplicate tier rules, inverted bands, overlaps and gaps', () => {
    expect(
      codes({
        perStat: {},
        tiers: [
          { stat: 'pts_allow', bands: [{ min: 0, max: 0, points: 1 }] },
          { stat: 'pts_allow', bands: [{ min: 0, max: 0, points: 1 }] }
        ]
      })
    ).toEqual(['DUPLICATE_TIER_RULE']);
    expect(
      codes({ perStat: {}, tiers: [{ stat: 'pts_allow', bands: [{ min: 5, max: 1, points: 1 }] }] })
    ).toEqual(['TIER_BAND_INVERTED']);
    expect(
      codes({
        perStat: {},
        tiers: [
          {
            stat: 'pts_allow',
            bands: [
              { min: 0, max: 10, points: 1 },
              { min: 10, max: 20, points: 0 }
            ]
          }
        ]
      })
    ).toEqual(['TIER_BANDS_OVERLAP']);
    expect(
      codes({
        perStat: {},
        tiers: [
          {
            stat: 'pts_allow',
            bands: [
              { min: 0, max: null, points: 1 },
              { min: 10, max: 20, points: 0 }
            ]
          }
        ]
      })
    ).toEqual(['TIER_BANDS_OVERLAP']);
    const gap = validateScoringSettings(
      {
        perStat: {},
        tiers: [
          {
            stat: 'yds_allow',
            bands: [
              { min: 0, max: 99, points: 5 },
              { min: 200, max: null, points: -1 }
            ]
          }
        ]
      },
      'x'
    );
    expect(gap).toMatchObject([{ code: 'TIER_BANDS_GAP', severity: 'warning', path: 'x.tiers.0.bands.1' }]);
    expect(gap[0]?.fix).toContain('100');
  });
});
