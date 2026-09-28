import { scorePlayer, scoringPreset, type ScoringSettings } from '@fantasy/core';
import type { StatMap } from '@fantasy/data';

export interface ProjectionOptions {
  /** How many of the most recent games played count. */
  window: number;
  /** Weight of the game i places back is decay^i (the latest game weighs 1). */
  decay: number;
  /**
   * Weeks 1..baselineWeeks blend in the prior-season per-game baseline, weighted as
   * (baselineWeeks + 1 - week) games: 3 in week 1, 2 in week 2, 1 in week 3, then 0.
   */
  baselineWeeks: number;
}

export const DEFAULT_PROJECTION_OPTIONS: Readonly<ProjectionOptions> = {
  window: 6,
  decay: 0.8,
  baselineWeeks: 3
};

/** Stats that describe the game rather than production; they are not projected. */
const NOT_PROJECTED = new Set(['gp']);
/** Stats a line must carry even at 0 (a tier rule only applies when the stat is present). */
const ALWAYS_PRESENT = new Set(['pts_allow']);

export function describeProjectionMethod(options: ProjectionOptions = DEFAULT_PROJECTION_OPTIONS): string {
  return (
    `Synthetic projections (historical Sleeper projections are unavailable). For week W, each stat is the ` +
    `weighted mean of the player's actual lines in his last ${options.window} games played before week W ` +
    `(weight ${options.decay}^i for the game i places back), blended with his prior-season per-game average ` +
    `weighted as (${options.baselineWeeks + 1} - W) games in weeks 1-${options.baselineWeeks}. A player ` +
    `with no current-season game yet uses the prior-season average alone; a player with neither gets no ` +
    `projection. Players whose team is on bye or who have no team get none. Only weeks before W are read, ` +
    `and the snapshot is captured before week W's first kickoff, so projections are strictly pre-kickoff.`
  );
}

/** Per-stat average of a list of stat lines (the prior-season per-game baseline). */
export function averageLines(lines: readonly StatMap[]): StatMap | undefined {
  if (lines.length === 0) return undefined;
  return weightedMean(lines.map((stats) => ({ stats, weight: 1 })));
}

function weightedMean(parts: readonly { stats: StatMap; weight: number }[]): StatMap {
  const total = parts.reduce((sum, p) => sum + p.weight, 0);
  const sums = new Map<string, number>();
  for (const { stats, weight } of parts) {
    for (const [key, value] of Object.entries(stats)) {
      if (NOT_PROJECTED.has(key)) continue;
      sums.set(key, (sums.get(key) ?? 0) + value * weight);
    }
  }
  const out: StatMap = {};
  for (const key of [...sums.keys()].sort()) {
    const value = Math.round(((sums.get(key) as number) / total) * 100) / 100;
    if (value !== 0 || ALWAYS_PRESENT.has(key)) out[key] = value === 0 ? 0 : value;
  }
  return out;
}

/**
 * One player's projected stat line for `week`.
 *
 * @param history The player's actual lines from earlier weeks of this season, most recent first. Only
 *   weeks before `week` may be passed; the caller guarantees it.
 * @param baseline Prior-season per-game average, if he played last season.
 */
export function projectLine(
  week: number,
  history: readonly StatMap[],
  baseline: StatMap | undefined,
  options: ProjectionOptions = DEFAULT_PROJECTION_OPTIONS
): StatMap | null {
  const parts = history.slice(0, options.window).map((stats, i) => ({ stats, weight: options.decay ** i }));
  const baselineWeight = Math.max(0, options.baselineWeeks + 1 - week);
  if (baseline && baselineWeight > 0) parts.push({ stats: baseline, weight: baselineWeight });
  if (parts.length === 0) return baseline ? weightedMean([{ stats: baseline, weight: 1 }]) : null;
  return weightedMean(parts);
}

export interface WeekProjectionInput {
  week: number;
  /** Player id → actual lines of earlier weeks, most recent first. */
  history: ReadonlyMap<string, readonly StatMap[]>;
  /** Player id → prior-season per-game average. */
  baselines: ReadonlyMap<string, StatMap>;
  /** Players eligible for a projection this week (on a team that plays). */
  eligible: readonly string[];
  options?: ProjectionOptions;
}

/** Projections for every eligible player in a week, keyed by player id (sorted). */
export function projectWeek(input: WeekProjectionInput): Record<string, StatMap> {
  const out: Record<string, StatMap> = {};
  for (const id of [...input.eligible].sort()) {
    const line = projectLine(input.week, input.history.get(id) ?? [], input.baselines.get(id), input.options);
    if (line) out[id] = line;
  }
  return out;
}

/**
 * Synthetic trending adds: the players whose projected points (half-PPR) rose most from the previous
 * week's projection, derived only from the two pre-kickoff projection snapshots. `count` is the rise in
 * hundredths of a point, standing in for Sleeper's add count.
 */
export function trendingAdds(
  previous: Readonly<Record<string, StatMap>> | undefined,
  current: Readonly<Record<string, StatMap>>,
  limit = 25,
  scoring: ScoringSettings = scoringPreset('yahoo_standard')
): { playerId: string; count: number }[] {
  if (!previous) return [];
  const rises: { playerId: string; count: number }[] = [];
  for (const [playerId, line] of Object.entries(current)) {
    const before = previous[playerId];
    // Players without a previous projection (bye, first game) have no trend yet.
    if (!before) continue;
    const now = scorePlayer(scoring, line).points;
    const then = scorePlayer(scoring, before).points;
    const count = Math.round((now - then) * 100);
    if (count > 0) rises.push({ playerId, count });
  }
  return rises
    .sort((a, b) => b.count - a.count || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0))
    .slice(0, limit);
}
