import { OUTLOOK_MODEL, winProbability } from '../outlook/outlook.js';

/**
 * Draft report card math: the post-draft letter grades and projected standings. Pure: the caller
 * supplies each team's projected weekly score and the regular-season schedule.
 *
 * Projected records always add up across the league: every regular-season matchup gives exactly one
 * win and one loss, so the wins sum to the number of matchups, each team's wins and losses sum to
 * its games, and the records are achievable on the actual schedule (some assignment of matchup
 * winners produces them). Ranks are 1..N with no gaps, and a team with more projected wins never
 * ranks below one with fewer.
 */

/** Letter grades, best first. */
export const DRAFT_GRADES = [
  'A+',
  'A',
  'A-',
  'B+',
  'B',
  'B-',
  'C+',
  'C',
  'C-',
  'D+',
  'D',
  'D-',
  'F+',
  'F',
  'F-'
] as const;
export type DraftGrade = (typeof DRAFT_GRADES)[number];

/** A regular-season matchup. */
export interface ReportMatchup {
  week: number;
  homeTeamId: string;
  awayTeamId: string;
}

/** A team's projected score for one week: mean and standard deviation of its starters' points. */
export interface WeekScore {
  projected: number;
  stdDev: number;
}

/** Projected score by team id, then by week. */
export type WeeklyScores = ReadonlyMap<string, ReadonlyMap<number, WeekScore>>;

export interface ProjectedRecord {
  teamId: string;
  wins: number;
  losses: number;
}

/** Standard deviation of a starting lineup's score from its starters' projections (OUTLOOK_MODEL). */
export function lineupStdDev(starterPoints: readonly number[]): number {
  let variance = 0;
  for (const points of starterPoints) {
    if (points <= 0) continue;
    const sd = Math.max(OUTLOOK_MODEL.sdFloor, OUTLOOK_MODEL.sdRatio * points);
    variance += sd * sd;
  }
  return Math.sqrt(variance);
}

const NO_SCORE: WeekScore = { projected: 0, stdDev: 0 };

/** Each team's expected regular-season wins: the sum of its win probabilities, matchup by matchup. */
export function expectedWins(
  teamIds: readonly string[],
  schedule: readonly ReportMatchup[],
  scores: WeeklyScores
): Map<string, number> {
  const wins = new Map(teamIds.map((id) => [id, 0]));
  const score = (teamId: string, week: number) => scores.get(teamId)?.get(week) ?? NO_SCORE;
  for (const m of schedule) {
    const p = winProbability(score(m.homeTeamId, m.week), score(m.awayTeamId, m.week));
    wins.set(m.homeTeamId, (wins.get(m.homeTeamId) ?? 0) + p);
    wins.set(m.awayTeamId, (wins.get(m.awayTeamId) ?? 0) + 1 - p);
  }
  return wins;
}

/** Regular-season games per team. */
export function gamesPerTeam(
  teamIds: readonly string[],
  schedule: readonly ReportMatchup[]
): Map<string, number> {
  const games = new Map(teamIds.map((id) => [id, 0]));
  for (const m of schedule) {
    games.set(m.homeTeamId, (games.get(m.homeTeamId) ?? 0) + 1);
    games.set(m.awayTeamId, (games.get(m.awayTeamId) ?? 0) + 1);
  }
  return games;
}

/**
 * Whole-number records closest to `targets` (any real numbers: expected wins, or a model's guess)
 * that add up on `schedule`:
 *
 * 1. Targets are clamped to 0..games and rescaled so they sum to the number of matchups.
 * 2. They are rounded by largest remainder, keeping the sum.
 * 3. While no assignment of matchup winners can produce the rounded wins (a max-flow check), a win
 *    moves from a team that has one to spare to one inside the over-constrained group that needs it,
 *    choosing the teams whose rounding moved furthest from their targets.
 *
 * Ties in rounding go to the team earlier in `teamIds`.
 */
export function projectRecords(
  teamIds: readonly string[],
  schedule: readonly ReportMatchup[],
  targets: ReadonlyMap<string, number>
): ProjectedRecord[] {
  const games = gamesPerTeam(teamIds, schedule);
  const scaled = scaleTargets(teamIds, games, targets, schedule.length);
  const wins = roundTargets(teamIds, games, scaled, schedule.length);
  for (let guard = 0; ; guard++) {
    const unmet = unmetGroup(teamIds, schedule, wins);
    if (unmet === null) break;
    const { cut, load } = unmet;
    const gap = (id: string) => (scaled.get(id) ?? 0) - (wins.get(id) ?? 0);
    const up = pickBy(
      teamIds.filter((id) => cut.has(id) && (wins.get(id) ?? 0) < (games.get(id) ?? 0)),
      gap
    );
    // A team outside the group holds a win no matchup has used yet.
    const down = pickBy(
      teamIds.filter((id) => (wins.get(id) ?? 0) > (load.get(id) ?? 0)),
      (id) => -gap(id)
    );
    // Unreachable for a valid schedule: the unmet group always has a team below its game count, and
    // the wins it lacks sit unused with a team outside it.
    if (up === null || down === null || guard > schedule.length * teamIds.length)
      throw new Error('Projected records cannot be balanced on this schedule');
    wins.set(up, (wins.get(up) ?? 0) + 1);
    wins.set(down, (wins.get(down) ?? 0) - 1);
  }
  return teamIds.map((teamId) => {
    const w = wins.get(teamId) ?? 0;
    return { teamId, wins: w, losses: (games.get(teamId) ?? 0) - w };
  });
}

function pickBy(ids: readonly string[], score: (id: string) => number): string | null {
  let best: string | null = null;
  for (const id of ids) if (best === null || score(id) > score(best)) best = id;
  return best;
}

function scaleTargets(
  teamIds: readonly string[],
  games: ReadonlyMap<string, number>,
  targets: ReadonlyMap<string, number>,
  total: number
): Map<string, number> {
  const cap = (id: string) => games.get(id) ?? 0;
  const out = new Map(
    teamIds.map((id) => {
      const t = targets.get(id);
      return [id, Math.min(cap(id), Math.max(0, t !== undefined && Number.isFinite(t) ? t : cap(id) / 2))];
    })
  );
  // Rescale the unclamped teams toward the total; a few passes settle any that hit 0 or their cap.
  for (let pass = 0; pass < 20; pass++) {
    const sum = [...out.values()].reduce((a, b) => a + b, 0);
    const diff = total - sum;
    if (Math.abs(diff) < 1e-9) break;
    const free = teamIds.filter((id) => (diff > 0 ? out.get(id)! < cap(id) : out.get(id)! > 0));
    if (free.length === 0) break;
    const freeSum = free.reduce((a, id) => a + out.get(id)!, 0);
    for (const id of free) {
      const share = freeSum > 0 ? out.get(id)! / freeSum : 1 / free.length;
      out.set(id, Math.min(cap(id), Math.max(0, out.get(id)! + diff * share)));
    }
  }
  return out;
}

function roundTargets(
  teamIds: readonly string[],
  games: ReadonlyMap<string, number>,
  scaled: ReadonlyMap<string, number>,
  total: number
): Map<string, number> {
  const wins = new Map(teamIds.map((id) => [id, Math.floor(scaled.get(id) ?? 0)]));
  let left = total - [...wins.values()].reduce((a, b) => a + b, 0);
  const order = teamIds
    .map((id, index) => ({ id, index, rem: (scaled.get(id) ?? 0) - (wins.get(id) ?? 0) }))
    .sort((a, b) => b.rem - a.rem || a.index - b.index);
  while (left > 0) {
    let moved = false;
    for (const { id } of order) {
      if (left === 0) break;
      if ((wins.get(id) ?? 0) < (games.get(id) ?? 0)) {
        wins.set(id, (wins.get(id) ?? 0) + 1);
        left--;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return wins;
}

/**
 * Null when some assignment of matchup winners gives every team exactly `wins`; otherwise the teams
 * reachable in the residual graph of a maximum flow (matchup → one of its two teams → capacity
 * `wins`): a group whose own matchups need more wins than it has been given.
 */
function unmetGroup(
  teamIds: readonly string[],
  schedule: readonly ReportMatchup[],
  wins: ReadonlyMap<string, number>
): { cut: Set<string>; load: Map<string, number> } | null {
  const winner: (string | null)[] = schedule.map(() => null);
  const load = new Map(teamIds.map((id) => [id, 0]));
  const byTeam = new Map<string, number[]>(teamIds.map((id) => [id, []]));
  schedule.forEach((m, i) => {
    byTeam.get(m.homeTeamId)?.push(i);
    byTeam.get(m.awayTeamId)?.push(i);
  });
  const sides = (i: number) => [schedule[i]!.homeTeamId, schedule[i]!.awayTeamId];

  // Augment one matchup at a time: BFS over teams, where a team can pass a win on by flipping one of
  // the matchups it currently wins to that matchup's other team.
  const augment = (start: number): Set<string> | null => {
    const parent = new Map<string, { from: string | null; matchup: number }>();
    const queue: string[] = [];
    for (const t of sides(start)) {
      if (!parent.has(t)) {
        parent.set(t, { from: null, matchup: start });
        queue.push(t);
      }
    }
    while (queue.length > 0) {
      const team = queue.shift()!;
      if ((load.get(team) ?? 0) < (wins.get(team) ?? 0)) {
        // Walk back, flipping each matchup along the path to the team that reached it.
        let at: string | null = team;
        while (at !== null) {
          const step: { from: string | null; matchup: number } = parent.get(at)!;
          winner[step.matchup] = at;
          at = step.from;
        }
        load.set(team, (load.get(team) ?? 0) + 1);
        return null;
      }
      for (const i of byTeam.get(team) ?? []) {
        if (winner[i] !== team) continue;
        for (const other of sides(i)) {
          if (other === team || parent.has(other)) continue;
          parent.set(other, { from: team, matchup: i });
          queue.push(other);
        }
      }
    }
    return new Set(parent.keys());
  };

  for (let i = 0; i < schedule.length; i++) {
    const cut = augment(i);
    if (cut !== null) return { cut, load };
  }
  return null;
}

/**
 * Ranks 1..N by projected wins, most first. Teams level on wins keep the order of `preference`
 * (a model's ranking, or projected points); teams missing from it follow, in `records` order.
 */
export function rankRecords(
  records: readonly ProjectedRecord[],
  preference: readonly string[]
): Map<string, number> {
  const pos = (id: string) => {
    const i = preference.indexOf(id);
    return i === -1 ? preference.length + records.findIndex((r) => r.teamId === id) : i;
  };
  const sorted = [...records].sort((a, b) => b.wins - a.wins || pos(a.teamId) - pos(b.teamId));
  return new Map(sorted.map((r, i) => [r.teamId, i + 1]));
}

/** z-score cutoffs for each grade but the last, best first (roughly a bell curve centred on C+/C). */
const GRADE_CUTOFFS = [1.6, 1.2, 0.9, 0.6, 0.3, 0.1, -0.1, -0.3, -0.5, -0.7, -0.9, -1.1, -1.4, -1.8] as const;

/** A computed grade from a composite z-score (0 is league average). */
export function gradeForScore(z: number): DraftGrade {
  const index = GRADE_CUTOFFS.findIndex((cut) => z >= cut);
  return DRAFT_GRADES[index === -1 ? DRAFT_GRADES.length - 1 : index]!;
}

/** z-scores of `values` against their own mean; all 0 when they do not vary. */
export function zScores(values: ReadonlyMap<string, number>): Map<string, number> {
  const list = [...values.values()];
  const mean = list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
  const sd = Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, list.length));
  return new Map([...values].map(([id, v]) => [id, sd === 0 ? 0 : (v - mean) / sd]));
}
