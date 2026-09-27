import { isStarterSlot, type RosterSlot } from '../rules/positions.js';
import type { ScoringSettings, TierBand } from './settings.js';

/** A player's raw stats for one week, keyed by Sleeper stat key. Missing and null values count as 0. */
export type StatLine = Readonly<Record<string, number | null | undefined>>;

export interface ScoreBreakdownItem {
  stat: string;
  value: number;
  /** Points from this stat, cleaned of float noise to 6 decimals (not rounded to 2). */
  points: number;
  /** Set when the points came from a tier band rather than a per-stat weight. */
  tier?: { min: number; max: number | null };
}

export interface PlayerScore {
  /** Total fantasy points, rounded to 2 decimals once, after summing. */
  points: number;
  breakdown: ScoreBreakdownItem[];
}

/** Either a bare scoring configuration or anything that carries one (such as `LeagueSettings`). */
export type ScoringSource = ScoringSettings | { scoring: ScoringSettings };

function resolveScoring(source: ScoringSource): ScoringSettings {
  return 'scoring' in source ? source.scoring : source;
}

/** Rounds half away from zero to 2 decimals, tolerating float noise such as 33.179999999. */
export function roundPoints(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const rounded = (sign * Math.round(Math.abs(value) * 100 + 1e-7)) / 100;
  return rounded === 0 ? 0 : rounded;
}

function clean(value: number): number {
  const cleaned = Math.round(value * 1e6) / 1e6;
  return cleaned === 0 ? 0 : cleaned;
}

function statValue(line: StatLine, key: string): number | undefined {
  const v = line[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Finds the band containing `value` (inclusive bounds), or undefined. */
export function findTierBand(bands: readonly TierBand[], value: number): TierBand | undefined {
  return bands.find((b) => value >= b.min && (b.max === null || value <= b.max));
}

/**
 * Scores one player's stat line. Pure and deterministic.
 * Per-stat points are `value × weight` for every weighted stat; each tier rule adds its matching
 * band's points when the stat is present in the line. The total is rounded to 2 decimals at the end.
 */
export function scorePlayer(settings: ScoringSource, statLine: StatLine): PlayerScore {
  const scoring = resolveScoring(settings);
  const breakdown: ScoreBreakdownItem[] = [];
  let total = 0;

  for (const [stat, weight] of Object.entries(scoring.perStat)) {
    const value = statValue(statLine, stat);
    if (value === undefined || value === 0) continue;
    const pts = value * weight;
    total += pts;
    breakdown.push({ stat, value, points: clean(pts) });
  }

  for (const rule of scoring.tiers) {
    const value = statValue(statLine, rule.stat);
    if (value === undefined) continue;
    const band = findTierBand(rule.bands, value);
    if (!band) continue;
    total += band.points;
    breakdown.push({ stat: rule.stat, value, points: band.points, tier: { min: band.min, max: band.max } });
  }

  return { points: roundPoints(total), breakdown };
}

export interface LineupEntry {
  playerId: string;
  slot: RosterSlot;
}

export interface PlayerWeekScore extends PlayerScore {
  playerId: string;
  slot: RosterSlot;
  /** False when no stat line was supplied (did not play, bye, or stats not yet available). */
  hasStats: boolean;
}

export interface TeamWeekScore {
  /** Sum of starter points, rounded to 2 decimals. */
  points: number;
  starters: PlayerWeekScore[];
  /** Bench and IR players, scored for information only ("points left on the bench"). */
  bench: PlayerWeekScore[];
  benchPoints: number;
}

/** Scores a team's week. Only starters count toward `points`; BN and IR are reported separately. */
export function scoreTeamWeek(
  settings: ScoringSource,
  lineup: readonly LineupEntry[],
  statLinesByPlayer: Readonly<Record<string, StatLine | undefined>>
): TeamWeekScore {
  const starters: PlayerWeekScore[] = [];
  const bench: PlayerWeekScore[] = [];
  for (const entry of lineup) {
    const line = statLinesByPlayer[entry.playerId];
    const score = line ? scorePlayer(settings, line) : { points: 0, breakdown: [] };
    const row: PlayerWeekScore = {
      playerId: entry.playerId,
      slot: entry.slot,
      hasStats: line !== undefined,
      ...score
    };
    (isStarterSlot(entry.slot) ? starters : bench).push(row);
  }
  const sum = (rows: PlayerWeekScore[]): number => roundPoints(rows.reduce((acc, r) => acc + r.points, 0));
  return { points: sum(starters), starters, bench, benchPoints: sum(bench) };
}
