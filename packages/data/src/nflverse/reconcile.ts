import type { StatLine } from '../types.js';
import { NFLVERSE_TO_SLEEPER } from './stats.js';

/**
 * Stat corrections (#80): the week's Sleeper lines reconciled with nflverse, whose weekly files are
 * rebuilt nightly and carry the league's stat corrections by Thursday. For each player on both
 * sides, nflverse wins for every stat it maps (`NFLVERSE_TO_SLEEPER`; a mapped stat nflverse does
 * not report is zero), and Sleeper keeps everything nflverse does not cover (team defense, bonuses,
 * `gp`). Players nflverse does not list keep their Sleeper line unchanged.
 *
 * `nflverse` lines must already use Sleeper ids (parse them with a crosswalk); lines still keyed by
 * a GSIS id match nothing and change nothing.
 */
export function reconcileWithNflverse(
  primary: readonly StatLine[],
  nflverse: readonly StatLine[]
): StatLine[] {
  const official = new Map<string, StatLine>();
  for (const line of nflverse) official.set(`${line.playerId}:${line.week}`, line);
  return primary.map((line) => {
    const fix = official.get(`${line.playerId}:${line.week}`);
    if (fix === undefined) return line;
    const stats = { ...line.stats };
    for (const key of Object.keys(NFLVERSE_TO_SLEEPER)) {
      const value = fix.stats[key];
      if (value === undefined || value === 0) delete stats[key];
      else stats[key] = value;
    }
    return { ...line, stats };
  });
}
