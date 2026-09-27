import { z } from 'zod';
import { ruleError, ruleWarning, type RuleIssue } from '../rules/issues.js';

/**
 * Scoring settings keyed by Sleeper stat keys (Sleeper is the stat source).
 *
 * - `perStat` is linear: points = stat value × weight. Yardage weights are per yard (0.04 = 1 point
 *   per 25 passing yards).
 * - `tiers` handle stats that score by bucket rather than linearly, such as points allowed by a team
 *   defense. A tier rule only applies when the stat line contains that stat.
 */
export const StatKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'Stat keys are lowercase Sleeper keys such as pass_yd or fgm_40_49');

export const TierBandSchema = z.strictObject({
  /** Inclusive lower bound. */
  min: z.number().finite(),
  /** Inclusive upper bound; `null` means no upper bound. */
  max: z.number().finite().nullable(),
  points: z.number().finite()
});
export type TierBand = z.infer<typeof TierBandSchema>;

export const TierRuleSchema = z.strictObject({
  stat: StatKeySchema,
  bands: z.array(TierBandSchema).min(1)
});
export type TierRule = z.infer<typeof TierRuleSchema>;

export const ScoringSettingsSchema = z.strictObject({
  perStat: z.record(StatKeySchema, z.number().finite()),
  tiers: z.array(TierRuleSchema)
});
export type ScoringSettings = z.infer<typeof ScoringSettingsSchema>;

/** Human-readable labels for the Sleeper stat keys we know about. Unknown keys are allowed but warned. */
export const STAT_LABELS: Readonly<Record<string, string>> = {
  pass_yd: 'Passing yards',
  pass_td: 'Passing touchdowns',
  pass_int: 'Interceptions thrown',
  pass_2pt: 'Passing 2-point conversions',
  pass_cmp: 'Pass completions',
  pass_att: 'Pass attempts',
  pass_inc: 'Incomplete passes',
  pass_sack: 'Sacks taken',
  pass_fd: 'Passing first downs',
  rush_yd: 'Rushing yards',
  rush_td: 'Rushing touchdowns',
  rush_2pt: 'Rushing 2-point conversions',
  rush_att: 'Rush attempts',
  rush_fd: 'Rushing first downs',
  rec: 'Receptions',
  rec_yd: 'Receiving yards',
  rec_td: 'Receiving touchdowns',
  rec_2pt: 'Receiving 2-point conversions',
  rec_tgt: 'Targets',
  rec_fd: 'Receiving first downs',
  fum: 'Fumbles',
  fum_lost: 'Fumbles lost',
  fum_rec_td: 'Offensive fumble recovery touchdowns',
  st_td: 'Kick and punt return touchdowns (individual)',
  kr_yd: 'Kick return yards',
  pr_yd: 'Punt return yards',
  fgm_0_19: 'Field goals made, 0-19 yards',
  fgm_20_29: 'Field goals made, 20-29 yards',
  fgm_30_39: 'Field goals made, 30-39 yards',
  fgm_40_49: 'Field goals made, 40-49 yards',
  fgm_50p: 'Field goals made, 50+ yards',
  fgmiss_0_19: 'Field goals missed, 0-19 yards',
  fgmiss_20_29: 'Field goals missed, 20-29 yards',
  fgmiss_30_39: 'Field goals missed, 30-39 yards',
  fgmiss_40_49: 'Field goals missed, 40-49 yards',
  fgmiss_50p: 'Field goals missed, 50+ yards',
  fgm_yds: 'Field goal yards',
  xpm: 'Extra points made',
  xpmiss: 'Extra points missed',
  sack: 'Sacks (team defense)',
  int: 'Interceptions (team defense)',
  fum_rec: 'Fumble recoveries (team defense)',
  ff: 'Forced fumbles (team defense)',
  def_td: 'Defensive touchdowns',
  def_st_td: 'Special teams touchdowns (team defense)',
  def_2pt: 'Two-point conversion returns (team defense)',
  safe: 'Safeties',
  blk_kick: 'Blocked kicks',
  def_4_and_stop: 'Fourth-down stops',
  pts_allow: 'Points allowed',
  yds_allow: 'Yards allowed',
  idp_tkl_solo: 'IDP solo tackles',
  idp_tkl_ast: 'IDP assisted tackles',
  idp_tkl_loss: 'IDP tackles for loss',
  idp_sack: 'IDP sacks',
  idp_qb_hit: 'IDP quarterback hits',
  idp_int: 'IDP interceptions',
  idp_ff: 'IDP forced fumbles',
  idp_fum_rec: 'IDP fumble recoveries',
  idp_def_td: 'IDP touchdowns',
  idp_pass_def: 'IDP passes defended',
  idp_safe: 'IDP safeties',
  idp_blk_kick: 'IDP blocked kicks'
};

/** Yahoo points-allowed tiers for team defense. */
export const YAHOO_POINTS_ALLOWED_TIERS: TierRule = {
  stat: 'pts_allow',
  bands: [
    { min: 0, max: 0, points: 10 },
    { min: 1, max: 6, points: 7 },
    { min: 7, max: 13, points: 4 },
    { min: 14, max: 20, points: 1 },
    { min: 21, max: 27, points: 0 },
    { min: 28, max: 34, points: -1 },
    { min: 35, max: null, points: -4 }
  ]
};

const YAHOO_BASE_PER_STAT: Readonly<Record<string, number>> = {
  // Passing
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -1,
  pass_2pt: 2,
  // Rushing
  rush_yd: 0.1,
  rush_td: 6,
  rush_2pt: 2,
  // Receiving (rec is set per preset)
  rec_yd: 0.1,
  rec_td: 6,
  rec_2pt: 2,
  // Misc offense
  fum_lost: -2,
  fum_rec_td: 6,
  st_td: 6,
  // Kicking
  fgm_0_19: 3,
  fgm_20_29: 3,
  fgm_30_39: 3,
  fgm_40_49: 4,
  fgm_50p: 5,
  xpm: 1,
  // Team defense / special teams
  sack: 1,
  int: 2,
  fum_rec: 2,
  def_td: 6,
  def_st_td: 6,
  def_2pt: 2,
  safe: 2,
  blk_kick: 2
};

/** Optional IDP scoring (Yahoo IDP defaults). Merge in with `withIdpScoring` when IDP slots are used. */
export const IDP_PER_STAT: Readonly<Record<string, number>> = {
  idp_tkl_solo: 1,
  idp_tkl_ast: 0.5,
  idp_sack: 2,
  idp_int: 3,
  idp_ff: 2,
  idp_fum_rec: 2,
  idp_def_td: 6,
  idp_pass_def: 1,
  idp_safe: 2,
  idp_blk_kick: 2
};

export const SCORING_PRESETS = ['yahoo_standard', 'full_ppr', 'standard'] as const;
export const ScoringPresetSchema = z.enum(SCORING_PRESETS);
export type ScoringPreset = z.infer<typeof ScoringPresetSchema>;

const RECEPTION_POINTS: Readonly<Record<ScoringPreset, number>> = {
  yahoo_standard: 0.5,
  full_ppr: 1,
  standard: 0
};

/**
 * Returns a fresh copy of a scoring preset.
 * - `yahoo_standard`: Yahoo public-league default (half-PPR, 0.5 per reception).
 * - `full_ppr`: same, with 1 point per reception.
 * - `standard`: same, with no reception points.
 */
export function scoringPreset(preset: ScoringPreset = 'yahoo_standard'): ScoringSettings {
  const perStat: Record<string, number> = { ...YAHOO_BASE_PER_STAT };
  const rec = RECEPTION_POINTS[preset];
  if (rec !== 0) perStat.rec = rec;
  return {
    perStat,
    tiers: [
      {
        stat: YAHOO_POINTS_ALLOWED_TIERS.stat,
        bands: YAHOO_POINTS_ALLOWED_TIERS.bands.map((b) => ({ ...b }))
      }
    ]
  };
}

/** Adds the IDP stat weights to a scoring configuration (existing weights win). */
export function withIdpScoring(scoring: ScoringSettings): ScoringSettings {
  return { perStat: { ...IDP_PER_STAT, ...scoring.perStat }, tiers: scoring.tiers };
}

/** Semantic checks beyond the schema: tier bands must be ordered and non-overlapping. */
export function validateScoringSettings(scoring: ScoringSettings, basePath = 'scoring'): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const key of Object.keys(scoring.perStat)) {
    if (!(key in STAT_LABELS)) {
      issues.push(
        ruleWarning(
          'UNKNOWN_STAT_KEY',
          `${basePath}.perStat.${key}`,
          `"${key}" is not a Sleeper stat key this league recognizes. It only scores if Sleeper stat lines contain it.`,
          `Check the spelling against Sleeper stat keys (for example pass_yd, rec, fgm_40_49), or remove it.`
        )
      );
    }
  }

  const seen = new Set<string>();
  scoring.tiers.forEach((rule, ruleIndex) => {
    const rulePath = `${basePath}.tiers.${ruleIndex}`;
    if (seen.has(rule.stat)) {
      issues.push(
        ruleError(
          'DUPLICATE_TIER_RULE',
          rulePath,
          `There is more than one tier rule for "${rule.stat}".`,
          `Merge the bands for "${rule.stat}" into a single tier rule.`
        )
      );
    }
    seen.add(rule.stat);

    rule.bands.forEach((band, i) => {
      if (band.max !== null && band.max < band.min) {
        issues.push(
          ruleError(
            'TIER_BAND_INVERTED',
            `${rulePath}.bands.${i}`,
            `Band ${i} of "${rule.stat}" has max ${band.max} below min ${band.min}.`,
            `Swap the bounds or set max to at least ${band.min}.`
          )
        );
      }
      const prev = i > 0 ? rule.bands[i - 1] : undefined;
      if (!prev) return;
      if (prev.max === null || band.min <= prev.max) {
        issues.push(
          ruleError(
            'TIER_BANDS_OVERLAP',
            `${rulePath}.bands.${i}`,
            `Band ${i} of "${rule.stat}" (starting at ${band.min}) overlaps band ${i - 1} (ending at ${prev.max ?? 'no limit'}).`,
            `List bands in ascending order with each min greater than the previous max.`
          )
        );
      } else if (band.min > prev.max + 1) {
        issues.push(
          ruleWarning(
            'TIER_BANDS_GAP',
            `${rulePath}.bands.${i}`,
            `Values from ${prev.max + 1} to ${band.min - 1} of "${rule.stat}" match no band and score 0.`,
            `Set band ${i} min to ${prev.max + 1} if that range should score.`
          )
        );
      }
    });
  });
  return issues;
}
