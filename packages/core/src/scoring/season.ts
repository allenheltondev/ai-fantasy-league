import { roundPoints, scorePlayer, type ScoringSource, type StatLine } from './engine.js';

/**
 * Season views over weekly stat lines: last season's fantasy points and points per game, and a
 * season projection, under any league's scoring. Each week is scored on its own (tiers such as
 * points allowed are per game), then the weeks are summed.
 */

export interface WeekStatLine {
  week: number;
  stats: StatLine;
}

export interface WeekPoints {
  week: number;
  points: number;
}

export interface SeasonPoints {
  /** Total fantasy points: the sum of the weekly points, rounded to 2 decimals. */
  points: number;
  /** Games played (weeks with Sleeper's `gp` above 0, or any stat when `gp` is missing). */
  games: number;
  /** Points per game played, rounded to 2 decimals; 0 with no games. */
  ppg: number;
  /** Points each week there is a line for, in week order. */
  weekly: WeekPoints[];
}

/** Whether a weekly line counts as a game played. */
export function playedWeek(stats: StatLine): boolean {
  const gp = stats.gp;
  if (typeof gp === 'number' && Number.isFinite(gp)) return gp > 0;
  return Object.values(stats).some((v) => typeof v === 'number' && Number.isFinite(v) && v !== 0);
}

/** Scores every week of a season and totals them. */
export function seasonPoints(scoring: ScoringSource, weeks: readonly WeekStatLine[]): SeasonPoints {
  const sorted = [...weeks].sort((a, b) => a.week - b.week);
  const weekly = sorted.map((w) => ({ week: w.week, points: scorePlayer(scoring, w.stats).points }));
  const points = roundPoints(weekly.reduce((sum, w) => sum + w.points, 0));
  const games = sorted.filter((w) => playedWeek(w.stats)).length;
  return { points, games, ppg: games === 0 ? 0 : roundPoints(points / games), weekly };
}

/** Adds stat lines key by key (season totals), rounded to 2 decimals. Nulls and non-numbers are skipped. */
export function sumStatLines(lines: readonly StatLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) {
    for (const [key, value] of Object.entries(line)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = (out[key] ?? 0) + value;
    }
  }
  for (const key of Object.keys(out)) out[key] = roundPoints(out[key] as number);
  return out;
}
