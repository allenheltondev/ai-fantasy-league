import { LAST_NFL_WEEK } from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireMember, requireTeam } from '../../league/access.js';
import { actorTeam } from '../../league/phase.js';
import { LeagueIdSchema, matchupView, MatchupViewSchema, TeamIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';

export const getMatchup = defineOperation({
  name: 'get_matchup',
  method: 'GET',
  path: '/leagues/{leagueId}/matchup',
  summary: "A team's head-to-head matchup for a week",
  description: [
    "Returns one team's matchup for a week: both teams and their scores (null until the week is scored), and whether it is scheduled, in progress, or final.",
    'Defaults: your own team and the current week (before the season, the first week). Pass `teamId` for any team in the league and `week` for any week the league plays.',
    'Before the draft there is no schedule yet: `matchup` is null and a NO_SCHEDULE_YET warning says so. A week with no game for the team (a playoff bye, or eliminated) also returns null. Only members can read it.'
  ].join(' '),
  tags: ['leagues', 'season'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdSchema.optional().describe('Team to look up (default: your own team).'),
    week: z
      .number()
      .int()
      .min(1)
      .max(LAST_NFL_WEEK)
      .optional()
      .describe('NFL week (default: the current week).')
  }),
  output: z.object({
    week: z.number().int(),
    teamId: z.string(),
    matchup: MatchupViewSchema.nullable()
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const { league, teams } = access;
    const own = actorTeam(access.actor);
    if (input.teamId === undefined && own === null) {
      throw new ApiError('INVALID_INPUT', 'You do not manage a team, so there is no default team.', {
        fix: `Pass teamId, one of: ${teams.map((t) => t.id).join(', ')}.`
      });
    }
    const team = requireTeam(access, input.teamId ?? (own?.id as string));
    const { startWeek } = league.settings.schedule;
    const lastWeek = league.settings.playoffs.endWeek;
    const week = input.week ?? league.week ?? startWeek;
    if (week < startWeek || week > lastWeek) {
      throw new ApiError(
        'INVALID_INPUT',
        `This league plays weeks ${startWeek}-${lastWeek}, not week ${week}.`,
        {
          fix: `Pass a week from ${startWeek} to ${lastWeek}.`
        }
      );
    }
    const matchups = await ctx.repos.schedule.listMatchups(league.id, week);
    const matchup = matchups.find((m) => m.homeTeamId === team.id || m.awayTeamId === team.id);
    const data = {
      week,
      teamId: team.id,
      matchup: matchup === undefined ? null : matchupView(matchup, teams)
    };
    if (matchup !== undefined) return data;
    return withWarnings(data, [
      league.phase === 'setup' || league.phase === 'drafting'
        ? { code: 'NO_SCHEDULE_YET', message: 'The schedule is created when the draft starts.' }
        : { code: 'NO_MATCHUP', message: `${team.name} has no game in week ${week}.` }
    ]);
  }
});
