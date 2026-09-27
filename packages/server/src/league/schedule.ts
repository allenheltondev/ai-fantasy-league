import { generateSchedule, leagueWeeks, type RuleIssue } from '@fantasy/core';
import { ApiError } from '../errors.js';
import { weekKey } from '../repos/dynamo/query.js';
import type { League, Matchup, Repos } from '../repos/types.js';

function scheduleError(issues: readonly RuleIssue[]): ApiError {
  return new ApiError('INVALID_SETTINGS', 'The league cannot build a schedule from its settings.', {
    fix: issues.map((issue) => issue.fix).join(' '),
    details: { issues: issues.map(({ code, path, message, fix }) => ({ code, path, message, fix })) }
  });
}

/**
 * Generates the regular-season schedule for a league's teams and weeks and stores it. The draft
 * calls this when it starts. It is safe to call again: a stored schedule is returned unchanged,
 * and generation is deterministic (same teams, weeks, and `scheduleSeed` give the same schedule).
 */
export async function startSeasonSchedule(deps: { repos: Repos }, league: League): Promise<Matchup[]> {
  const existing = (await deps.repos.schedule.listMatchups(league.id)).filter((m) => m.kind === 'regular');
  if (existing.length > 0) return existing;

  const weeks = leagueWeeks(league.settings);
  if (!weeks.ok) throw scheduleError(weeks.issues);
  const teams = await deps.repos.teams.list(league.id);
  const generated = generateSchedule(
    teams.map((t) => t.id),
    {
      startWeek: weeks.value.startWeek,
      regularSeasonEndWeek: league.settings.schedule.regularSeasonEndWeek,
      seed: league.scheduleSeed
    }
  );
  if (!generated.ok) throw scheduleError(generated.issues);
  if (teams.length !== league.settings.teamCount) {
    throw new ApiError(
      'CONFLICT',
      `The league has ${teams.length} teams but its settings say ${league.settings.teamCount}.`,
      { fix: 'Make the seats match teamCount (update_league_settings) before the draft starts.' }
    );
  }

  const matchups: Matchup[] = generated.value.flatMap((week) =>
    week.matchups.map((m, i) => ({
      id: `${weekKey(week.week)}-${i + 1}`,
      leagueId: league.id,
      week: week.week,
      kind: 'regular' as const,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      homeScore: null,
      awayScore: null,
      status: 'scheduled' as const
    }))
  );
  await deps.repos.schedule.putMatchups(matchups);
  return matchups;
}
