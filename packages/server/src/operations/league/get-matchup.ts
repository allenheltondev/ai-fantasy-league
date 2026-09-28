import { LAST_NFL_WEEK } from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireMember, requireTeam } from '../../league/access.js';
import { actorTeam } from '../../league/phase.js';
import { leagueManagers } from '../../league/managers.js';
import { LeagueIdSchema, matchupView, MatchupViewSchema, TeamIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import { detailFlag } from '../players.js';
import type { League, Matchup, Team } from '../../repos/types.js';
import { resolveLineup, rosterPlayers } from '../../season/lineups.js';
import type { Ctx } from '../../context.js';
import { loadWeekData, RosterEntrySchema, rosterEntries, startersTotal } from '../season/views.js';

const MatchupLineupSchema = z.object({
  teamId: z.string(),
  points: z.number().describe("The starters' points so far."),
  players: z.array(RosterEntrySchema).describe('Starters first in slot order, then the bench.')
});

export const getMatchup = defineOperation({
  name: 'get_matchup',
  method: 'GET',
  path: '/leagues/{leagueId}/matchup',
  summary: "A team's head-to-head matchup for a week",
  description: [
    "Returns one team's matchup for a week: both teams and their scores (null until the week is scored), and whether it is scheduled, in progress, or final.",
    'Defaults: your own team and the current week (before the season, the first week). Pass `teamId` for any team in the league and `week` for any week the league plays.',
    "`lineups` shows both teams' lineups with each player's projected and actual points; while the week is live the scores are recomputed from the latest stats on every read, so poll this for live scoring.",
    "A week before the league's first week (a draft that finished mid-season) is void: no scores, not in the standings, and a WEEK_VOID warning.",
    'Before the draft there is no schedule yet: `matchup` is null and a NO_SCHEDULE_YET warning says so. A week with no game for the team (a playoff bye, or eliminated) also returns null. Only members can read it.',
    '`detail: true` adds each player’s full record and the starting slots he can fill. For win probability and start/sit advice, use get_matchup_outlook.'
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
      .describe('NFL week (default: the current week).'),
    detail: detailFlag
  }),
  output: z.object({
    week: z.number().int(),
    teamId: z.string(),
    matchup: MatchupViewSchema.nullable(),
    lineups: z
      .object({ home: MatchupLineupSchema, away: MatchupLineupSchema })
      .nullable()
      .describe('Both lineups, or null when there is no matchup.')
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
    if (matchup !== undefined) {
      const lineups = await matchupLineups(ctx, league, teams, matchup, input.detail);
      const hasStats = [...lineups.home.players, ...lineups.away.players].some((p) => p.points !== null);
      const live =
        matchup.status !== 'final' && matchup.week === league.week && hasStats
          ? { ...matchup, homeScore: lineups.home.points, awayScore: lineups.away.points }
          : matchup;
      const result = {
        week,
        teamId: team.id,
        matchup: matchupView(live, teams, await leagueManagers(ctx, league.id, teams)),
        lineups
      };
      // A week before the league's first week (a draft that ran into the season) is void.
      if (matchup.status !== 'final' && league.week !== null && matchup.week < league.week) {
        return withWarnings(result, [
          {
            code: 'WEEK_VOID',
            message: `Week ${week} was played before this league's season began; it does not count.`
          }
        ]);
      }
      return result;
    }
    const data = { week, teamId: team.id, matchup: null, lineups: null };
    return withWarnings(data, [
      league.phase === 'setup' || league.phase === 'drafting'
        ? { code: 'NO_SCHEDULE_YET', message: 'The schedule is created when the draft starts.' }
        : { code: 'NO_MATCHUP', message: `${team.name} has no game in week ${week}.` }
    ]);
  }
});

/** Both sides' lineups for the matchup's week, with projected and live points. */
async function matchupLineups(
  ctx: Ctx,
  league: League,
  teams: readonly Team[],
  matchup: Matchup,
  detail: boolean
) {
  const now = ctx.clock.now();
  const side = async (teamId: string) => {
    const team = teams.find((t) => t.id === teamId);
    if (team === undefined) return { teamId, points: 0, players: [] };
    const [lineup, players, data] = await Promise.all([
      resolveLineup(ctx.repos, team, matchup.week),
      rosterPlayers(ctx.repos, team),
      loadWeekData(ctx, league, matchup.week, team.roster)
    ]);
    const entries = rosterEntries(lineup.entries, players, data, now, detail ? league.settings : null);
    return { teamId, points: startersTotal(entries), players: entries };
  };
  const [home, away] = await Promise.all([side(matchup.homeTeamId), side(matchup.awayTeamId)]);
  return { home, away };
}
