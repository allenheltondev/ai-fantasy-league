import { ruleError, type RuleIssue } from '../rules/issues.js';
import { ruleFail, ruleOk, type RuleResult } from '../rules/result.js';
import { LAST_NFL_WEEK } from '../rules/settings.js';
import { seededRandom, seededShuffle } from './random.js';

/** One regular-season game. Home and away only matter for display; fantasy has no home field. */
export interface ScheduledMatchup {
  week: number;
  homeTeamId: string;
  awayTeamId: string;
}

export interface ScheduleWeek {
  week: number;
  matchups: ScheduledMatchup[];
}

export interface ScheduleOptions {
  /** First week the league plays (later than 1 for a mid-season start). */
  startWeek: number;
  /** Last regular-season week, inclusive. */
  regularSeasonEndWeek: number;
  /** Makes the schedule reproducible. The same teams, weeks, and seed always give the same schedule. */
  seed: string | number;
}

function validateScheduleInput(teamIds: readonly string[], options: ScheduleOptions): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (teamIds.length < 2) {
    issues.push(
      ruleError(
        'SCHEDULE_TOO_FEW_TEAMS',
        'teamIds',
        `A schedule needs at least 2 teams; got ${teamIds.length}.`,
        'Pass every team in the league (4 to 12 teams).'
      )
    );
  } else if (teamIds.length % 2 !== 0) {
    issues.push(
      ruleError(
        'SCHEDULE_ODD_TEAMS',
        'teamIds',
        `${teamIds.length} teams is an odd number, so one team would sit out every week.`,
        `Use an even team count: add a team (${teamIds.length + 1}) or remove one (${teamIds.length - 1}).`
      )
    );
  }
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of teamIds) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  if (dupes.size > 0 || seen.has('')) {
    issues.push(
      ruleError(
        'SCHEDULE_INVALID_TEAMS',
        'teamIds',
        dupes.size > 0
          ? `Team ids must be unique; repeated: ${[...dupes].join(', ')}.`
          : 'Team ids must be non-empty.',
        'Pass each team id exactly once.'
      )
    );
  }
  const { startWeek, regularSeasonEndWeek } = options;
  for (const [path, w] of [
    ['startWeek', startWeek],
    ['regularSeasonEndWeek', regularSeasonEndWeek]
  ] as const) {
    if (!Number.isInteger(w) || w < 1 || w > LAST_NFL_WEEK) {
      issues.push(
        ruleError(
          'INVALID_WEEK',
          `schedule.${path}`,
          `schedule.${path} must be a whole NFL week from 1 to ${LAST_NFL_WEEK}; got ${w}.`,
          `Set schedule.${path} to a week between 1 and ${LAST_NFL_WEEK}.`
        )
      );
    }
  }
  if (startWeek > regularSeasonEndWeek) {
    issues.push(
      ruleError(
        'SEASON_HAS_NO_WEEKS',
        'schedule.startWeek',
        `The league starts in week ${startWeek}, after the regular season ends in week ${regularSeasonEndWeek}.`,
        `Set schedule.startWeek to ${regularSeasonEndWeek} or earlier.`
      )
    );
  }
  return issues;
}

/**
 * One round of the circle method: the first team stays put and the rest rotate one place per round.
 * Every round is a perfect matching, and the n-1 rounds together pair every two teams exactly once.
 */
function circleRound(order: readonly string[], round: number): Array<[string, string]> {
  const n = order.length;
  const fixed = order[0] as string;
  const rest = order.slice(1);
  const rotated = rest.map((_, i) => rest[(i + round) % rest.length] as string);
  const arr = [fixed, ...rotated];
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < n / 2; i++) {
    const a = arr[i] as string;
    const b = arr[n - 1 - i] as string;
    // Alternate home and away so each team's home games stay close to half.
    const swap = i === 0 ? round % 2 === 1 : i % 2 === 1;
    pairs.push(swap ? [b, a] : [a, b]);
  }
  return pairs;
}

/**
 * Generates a regular-season schedule from `startWeek` through `regularSeasonEndWeek` with the
 * round-robin circle method.
 *
 * - Every team plays exactly once every week (each week is a perfect matching).
 * - When the season is longer than one round robin (n-1 weeks), the rotation repeats, with home and
 *   away flipped on each repeat. When it is shorter, the round robin is cut off. Either way, the
 *   number of times any two teams meet differs by at most 1 across all pairs.
 * - Consecutive weeks never repeat a pairing (unless there are only 2 teams).
 * - Team order is shuffled with `seed`, so the result is deterministic for a given seed.
 */
export function generateSchedule(
  teamIds: readonly string[],
  options: ScheduleOptions
): RuleResult<ScheduleWeek[]> {
  const issues = validateScheduleInput(teamIds, options);
  if (issues.length > 0) return ruleFail(issues);

  const order = seededShuffle(teamIds, seededRandom(`schedule:${String(options.seed)}`));
  const roundsPerCycle = order.length - 1;
  const weeks: ScheduleWeek[] = [];
  for (let week = options.startWeek; week <= options.regularSeasonEndWeek; week++) {
    const index = week - options.startWeek;
    const cycle = Math.floor(index / roundsPerCycle);
    const flip = cycle % 2 === 1;
    const matchups = circleRound(order, index % roundsPerCycle).map(([home, away]): ScheduledMatchup =>
      flip ? { week, homeTeamId: away, awayTeamId: home } : { week, homeTeamId: home, awayTeamId: away }
    );
    weeks.push({ week, matchups });
  }
  return ruleOk(weeks);
}

/** The matchup a team plays in a week, or undefined when it has none. */
export function matchupFor(
  schedule: readonly ScheduleWeek[],
  week: number,
  teamId: string
): ScheduledMatchup | undefined {
  return schedule
    .find((w) => w.week === week)
    ?.matchups.find((m) => m.homeTeamId === teamId || m.awayTeamId === teamId);
}
