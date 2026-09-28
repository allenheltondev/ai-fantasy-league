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
 * The scoring Sleeper uses for its precomputed `pts_ppr` / `pts_half_ppr` / `pts_std`: our Yahoo
 * weights plus -1 for each missed field goal and extra point. Yahoo's default charges nothing for a
 * miss, which is the one intentional difference in the league default (docs/rules.md).
 */
export function sleeperReferenceScoring(format: ScoringFormat): ScoringSettings {
  const base = scoringPreset(
    format === 'ppr' ? 'full_ppr' : format === 'std' ? 'standard' : 'yahoo_standard'
  );
  return { perStat: { ...base.perStat, fgmiss: -1, xpmiss: -1 }, tiers: base.tiers };
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
