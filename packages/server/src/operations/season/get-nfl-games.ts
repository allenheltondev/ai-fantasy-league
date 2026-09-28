import { LAST_NFL_WEEK } from '@fantasy/core';
import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { weekGames } from '../../season/lineups.js';
import { NflGameSchema, nflWeekView, RedZoneTeamSchema } from '../../season/nfl-games.js';
import { leagueWeek } from './views.js';

export const getNflGames = defineOperation({
  name: 'get_nfl_games',
  method: 'GET',
  path: '/leagues/{leagueId}/nfl-games',
  summary: "The week's NFL games: scores, clock, possession, and the red zone",
  description: [
    "Returns every NFL game of the league's week, in kickoff order: teams, score, state (`pre`, `in`, `post`), status and clock, and for games in progress the team with the ball, down and distance, field position, and whether it is in the red zone (inside the opponent's 20).",
    '`redZone` lists the teams in the red zone right now: a started player on one of those teams is near a score.',
    'Live details come from a public scoreboard read every two minutes during games; possession and the red zone are left out when that read is more than ten minutes old, and a game not read yet shows as the schedule has it.',
    'Defaults to the current week (before the season, the first week). Only members can read it.'
  ].join(' '),
  tags: ['season'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    week: z
      .number()
      .int()
      .min(1)
      .max(LAST_NFL_WEEK)
      .optional()
      .describe('NFL week (default: the current week).')
  }),
  output: z.object({
    season: z.number().int(),
    week: z.number().int(),
    games: z.array(NflGameSchema),
    redZone: z.array(RedZoneTeamSchema),
    updatedAt: z.string().nullable().describe('When the live details were read, or null for none yet.')
  }),
  handler: async (ctx, input) => {
    const { league } = await requireMember(ctx, input.leagueId);
    const week = leagueWeek(league, input.week);
    const [schedule, stored] = await Promise.all([
      weekGames(ctx.data.reference, league.season, week),
      ctx.data.reference.nflGames.get(league.season, week)
    ]);
    return nflWeekView(league.season, week, schedule, stored, ctx.clock.now());
  }
});
