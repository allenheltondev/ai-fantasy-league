import { ruleError, type RuleIssue } from '../rules/issues.js';
import { ruleFail, ruleOk, type RuleResult } from '../rules/result.js';
import type { LeagueSettings } from '../rules/settings.js';

export interface LeagueWeeks {
  /** First week the league plays. */
  startWeek: number;
  /** Regular-season weeks the league plays, in order (starting at `schedule.startWeek`). */
  regularSeason: number[];
  /** Playoff weeks, one per bracket round. */
  playoffs: number[];
  /** No trades process once this week kicks off. */
  tradeDeadlineWeek: number;
  /** True when the league skips the start of the NFL season. */
  midSeasonStart: boolean;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let w = from; w <= to; w++) out.push(w);
  return out;
}

/**
 * Derives the weeks a league plays from its settings, which is how a mid-season start works: the
 * league drafts right away and plays from `schedule.startWeek` to the end of the regular season.
 *
 * Fails when the start week is not before the trade deadline or leaves no regular-season week.
 */
export function leagueWeeks(
  settings: Pick<LeagueSettings, 'schedule' | 'playoffs' | 'trades'>
): RuleResult<LeagueWeeks> {
  const { startWeek, regularSeasonEndWeek } = settings.schedule;
  const deadline = settings.trades.deadlineWeek;
  const issues: RuleIssue[] = [];
  if (startWeek > regularSeasonEndWeek) {
    issues.push(
      ruleError(
        'SEASON_HAS_NO_WEEKS',
        'schedule.startWeek',
        `Starting in week ${startWeek} leaves no regular-season weeks (the regular season ends in week ${regularSeasonEndWeek}).`,
        `Set schedule.startWeek to ${Math.min(regularSeasonEndWeek, deadline - 1)} or earlier.`
      )
    );
  }
  if (startWeek >= deadline) {
    issues.push(
      ruleError(
        'START_AFTER_TRADE_DEADLINE',
        'schedule.startWeek',
        `A league must start before the trade deadline (week ${deadline}); this one starts in week ${startWeek}.`,
        deadline > 1
          ? `Set schedule.startWeek to ${deadline - 1} or earlier.`
          : `Set trades.deadlineWeek to ${startWeek + 1} or later.`,
        { tradeDeadlineWeek: deadline, latestStartWeek: deadline - 1 }
      )
    );
  }
  if (issues.length > 0) return ruleFail(issues);
  return ruleOk({
    startWeek,
    regularSeason: range(startWeek, regularSeasonEndWeek),
    playoffs: range(settings.playoffs.startWeek, settings.playoffs.endWeek),
    tradeDeadlineWeek: deadline,
    midSeasonStart: startWeek > 1
  });
}

/** Latest week a new league may start: the week before the trade deadline, if it is in the regular season. */
export function latestStartWeek(settings: Pick<LeagueSettings, 'schedule' | 'trades'>): number {
  return Math.min(settings.trades.deadlineWeek - 1, settings.schedule.regularSeasonEndWeek);
}
