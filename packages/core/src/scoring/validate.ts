import { roundPoints, scorePlayer, type StatLine } from './engine.js';
import { scoringPreset, type ScoringSettings } from './settings.js';

/**
 * The scoring validation harness (#30, the Phase 1 milestone): score real stat lines with the engine
 * and compare against totals computed elsewhere (Sleeper's precomputed `pts_*`, nflverse's
 * `fantasy_points*`). Pure; the data package feeds it fixtures.
 */

export const SCORING_FORMATS = ['ppr', 'half_ppr', 'std'] as const;
export type ScoringFormat = (typeof SCORING_FORMATS)[number];

const RECEPTION: Readonly<Record<ScoringFormat, number>> = { ppr: 1, half_ppr: 0.5, std: 0 };

/**
 * The league preset compared with each Sleeper total: `pts_ppr` with `full_ppr`, `pts_half_ppr` with
 * `yahoo_standard`, and `pts_std` with `standard`. Where Sleeper's default scoring differs from these
 * Yahoo rules on purpose, `sleeperDefaultDifference` explains the mismatch (docs/rules.md).
 */
export function sleeperReferenceScoring(format: ScoringFormat): ScoringSettings {
  return scoringPreset(format === 'ppr' ? 'full_ppr' : format === 'std' ? 'standard' : 'yahoo_standard');
}

/**
 * One intended difference between Sleeper's default scoring (behind its precomputed `pts_*`) and
 * our Yahoo defaults. `sleeperMinusOurs` is the points Sleeper gives a line minus the points we
 * give it, the same in every format.
 */
export interface SleeperDefaultDifference {
  id: string;
  reason: string;
  sleeperMinusOurs: (stats: StatLine) => number;
}

const stat = (stats: StatLine, key: string): number => {
  const v = stats[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/** Sleeper's default individual defensive (IDP) weights. Tackles, QB hits, and passes defended score 0. */
export const SLEEPER_DEFAULT_IDP: Readonly<Record<string, number>> = {
  idp_sack: 1,
  idp_int: 2,
  idp_fum_rec: 2,
  idp_ff: 1,
  idp_blk_kick: 2,
  idp_def_td: 6,
  idp_safe: 2
};

/** The classes the recorded Sleeper weeks show (docs/rules.md, "Scoring validation"). */
export const SLEEPER_DEFAULT_DIFFERENCES: readonly SleeperDefaultDifference[] = [
  {
    id: 'missed-kicks',
    reason: 'Sleeper charges -1 per missed field goal and extra point, Yahoo charges 0',
    sleeperMinusOurs: (s) => -(stat(s, 'fgmiss') + stat(s, 'xpmiss'))
  },
  {
    id: 'idp',
    reason:
      'Sleeper scores individual defenders by default (sack 1, INT 2, fumble recovery 2, forced fumble 1, blocked kick 2, TD 6, safety 2), our default has no IDP scoring',
    sleeperMinusOurs: (s) =>
      Object.entries(SLEEPER_DEFAULT_IDP).reduce((sum, [key, w]) => sum + stat(s, key) * w, 0)
  },
  {
    id: 'points-allowed-14-20',
    reason: 'Sleeper gives a team defense 0 for allowing 14-20 points, Yahoo gives 1',
    sleeperMinusOurs: (s) => {
      const allowed = s.pts_allow;
      return typeof allowed === 'number' && allowed >= 14 && allowed <= 20 ? -1 : 0;
    }
  },
  {
    id: 'def-forced-fumbles',
    reason: 'Sleeper gives a team defense 1 per forced fumble (ff), Yahoo gives 0',
    sleeperMinusOurs: (s) => stat(s, 'ff')
  },
  {
    id: 'def-special-teams-fumble-recoveries',
    reason:
      'Sleeper gives a team defense 1 per special-teams fumble recovery (def_st_fum_rec), we give 2 as for any fumble recovery',
    sleeperMinusOurs: (s) => -stat(s, 'def_st_fum_rec')
  }
];

/** Stat keys Sleeper scores that the first scoring recordings dropped (an allow-list missed them). */
export const SLEEPER_KEYS_MISSING_FROM_EARLY_RECORDINGS = ['ff', 'st_ff', 'st_fum_rec'] as const;

export interface SleeperDifferenceOptions {
  /**
   * The set is an early recording without `SLEEPER_KEYS_MISSING_FROM_EARLY_RECORDINGS`. Sleeper
   * scores each of them in whole points (1 per forced fumble or special-teams fumble recovery), so
   * a remainder of whole points in Sleeper's favor is those keys. Re-record the set to drop this.
   */
  missingKeys?: boolean;
  differences?: readonly SleeperDefaultDifference[];
}

const isWhole = (n: number): boolean => Math.abs(n - Math.round(n)) < 1e-6;

/**
 * Explains a Sleeper mismatch when it is exactly the sum of the intended differences that apply to
 * the line (plus, for an early recording, whole points from the keys it is missing). Anything
 * else, including a partial match, stays unexplained.
 */
export function sleeperDefaultDifference(options: SleeperDifferenceOptions = {}): KnownDifference {
  const differences = options.differences ?? SLEEPER_DEFAULT_DIFFERENCES;
  return (c, _format, diff) => {
    const parts = differences
      .map((d) => ({ id: d.id, reason: d.reason, delta: d.sleeperMinusOurs(c.stats) }))
      .filter((p) => Math.abs(p.delta) > 1e-9);
    const missing = -(diff + parts.reduce((sum, p) => sum + p.delta, 0));
    if (Math.abs(missing) > 1e-6) {
      // A team defense (the only lines with pts_allow) can force several fumbles; a player's line
      // is short at most one special-teams play in these sets.
      const most = typeof c.stats.pts_allow === 'number' ? Infinity : 1;
      if (!options.missingKeys || missing < 1 - 1e-6 || missing > most + 1e-6 || !isWhole(missing)) {
        return null;
      }
      parts.push({
        id: 'missing-keys',
        reason: `this early recording has no ${SLEEPER_KEYS_MISSING_FROM_EARLY_RECORDINGS.join('/')}, which Sleeper scores 1 each: re-record it`,
        delta: missing
      });
    }
    if (parts.length === 0) return null;
    return parts
      .map((p) => `${p.id} (${p.delta > 0 ? '+' : ''}${roundPoints(p.delta)}): ${p.reason}`)
      .join('; ');
  };
}

/**
 * The scoring nflverse uses for `fantasy_points` (standard) and `fantasy_points_ppr`: offense only,
 * -2 per interception thrown, no kicking or team defense. Half-PPR is their mean.
 */
export function nflverseReferenceScoring(format: ScoringFormat): ScoringSettings {
  const perStat: Record<string, number> = {
    pass_yd: 0.04,
    pass_td: 4,
    pass_int: -2,
    pass_2pt: 2,
    rush_yd: 0.1,
    rush_td: 6,
    rush_2pt: 2,
    rec_yd: 0.1,
    rec_td: 6,
    rec_2pt: 2,
    fum_lost: -2,
    st_td: 6
  };
  if (RECEPTION[format] !== 0) perStat.rec = RECEPTION[format];
  return { perStat, tiers: [] };
}

export interface ScoringCase {
  /** Identifies the line in reports, e.g. "2025 wk1 4046 (Patrick Mahomes)". */
  key: string;
  stats: StatLine;
  /** Reference totals by format; formats left out are not compared. */
  expected: Partial<Record<ScoringFormat, number>>;
}

export interface ScoringMismatch {
  key: string;
  format: ScoringFormat;
  expected: number;
  actual: number;
  /** actual − expected. */
  diff: number;
  /** Why the difference is intended, when a known-difference rule explains it. */
  explanation: string | null;
}

export interface ScoringReport {
  cases: number;
  comparisons: number;
  /** Differences no known-difference rule explains. These must be fixed. */
  unexplained: ScoringMismatch[];
  /** Differences a known-difference rule explains (documented in docs/rules.md). */
  explained: ScoringMismatch[];
}

/** Explains a mismatch as an intended difference, or returns null. */
export type KnownDifference = (c: ScoringCase, format: ScoringFormat, diff: number) => string | null;

export const SCORING_TOLERANCE = 0.01;

export function validateScoring(
  cases: readonly ScoringCase[],
  scoringFor: (format: ScoringFormat) => ScoringSettings,
  known: readonly KnownDifference[] = [],
  tolerance = SCORING_TOLERANCE
): ScoringReport {
  const settings = new Map(SCORING_FORMATS.map((f) => [f, scoringFor(f)]));
  const report: ScoringReport = { cases: cases.length, comparisons: 0, unexplained: [], explained: [] };
  for (const c of cases) {
    for (const format of SCORING_FORMATS) {
      const expected = c.expected[format];
      if (expected === undefined) continue;
      report.comparisons++;
      const actual = scorePlayer(settings.get(format) as ScoringSettings, c.stats).points;
      const diff = roundPoints(actual - expected);
      if (Math.abs(diff) <= tolerance + 1e-9) continue;
      const explanation = known.map((k) => k(c, format, diff)).find((e) => e !== null) ?? null;
      const mismatch = { key: c.key, format, expected, actual, diff, explanation };
      (explanation === null ? report.unexplained : report.explained).push(mismatch);
    }
  }
  return report;
}

/** One line per mismatch, for test failure messages and the CLI report. */
export function formatScoringReport(report: ScoringReport): string {
  const line = (m: ScoringMismatch) =>
    `${m.key} ${m.format}: expected ${m.expected}, engine ${m.actual} (${m.diff > 0 ? '+' : ''}${m.diff})${m.explanation === null ? '' : ` — ${m.explanation}`}`;
  return [
    `${report.cases} lines, ${report.comparisons} comparisons, ${report.unexplained.length} unexplained and ${report.explained.length} explained mismatches`,
    ...report.unexplained.map(line),
    ...report.explained.map(line)
  ].join('\n');
}
