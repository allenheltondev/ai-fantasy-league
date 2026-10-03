import { z } from 'zod';
import { currentWeek } from '../../players/current-form.js';
import { NFL_TEAMS, POSITIONS, PositionSchema } from '../../players/model.js';
import { loadPointsAllowed } from '../../players/points-allowed.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import { seasonField } from './shared.js';

/** After week 18 every regular-season week of a past season counts. */
const PAST_SEASON_WEEK = 19;

export const PositionAllowedSchema = z.object({
  perGame: z.number().describe('PPR fantasy points allowed to the position per game.'),
  rank: z
    .number()
    .int()
    .describe(
      '1 allows the most points (the easiest matchup) through `of` (the toughest); ties share a rank.'
    ),
  of: z.number().int().describe('How many defenses are ranked.')
});

export const getPointsAllowed = defineOperation({
  name: 'get_points_allowed',
  method: 'GET',
  path: '/nfl-teams/points-allowed',
  summary: 'Fantasy points each NFL defense allows by position (matchup strength)',
  description: [
    'Returns, for every NFL defense, the fantasy points per game it has allowed to opposing QBs, RBs, WRs, TEs, kickers, and team defenses this season, with a rank at each position: 1 allows the most (the easiest matchup), 32 the fewest (the toughest).',
    'Points are Sleeper’s PPR scoring, so use the ranks more than the exact points when your league scores differently. Only completed weeks count (`throughWeek`); early in the season the sample is small, so weigh `games`.',
    'Pass `team` for one defense, or `position` to sort every defense by that position’s rank, easiest first. `season` defaults to the current one; a past season counts all 18 weeks.',
    'Use it for start/sit calls, streaming a quarterback, tight end, or defense, and judging a waiver pickup’s upcoming schedule. Before week 2 there is no data and the list is empty with a NO_POINTS_ALLOWED warning.'
  ].join(' '),
  tags: ['research'],
  mutation: false,
  input: z.object({
    team: z.enum(NFL_TEAMS).optional().describe('Only this defense, e.g. "KC".'),
    position: PositionSchema.optional().describe(
      'Sort by this position’s rank, easiest matchup first. Default: team order.'
    ),
    season: seasonField
  }),
  output: z.object({
    season: z
      .number()
      .int()
      .nullable()
      .describe('The season counted, or null when the NFL state is unknown.'),
    throughWeek: z.number().int().nullable().describe('The last week counted, or null with no data.'),
    scoring: z.literal('ppr').describe('Sleeper’s PPR scoring, whatever the league’s.'),
    teams: z.array(
      z.object({
        team: z.enum(NFL_TEAMS),
        games: z.number().int().describe('Games counted.'),
        positions: z.object(
          Object.fromEntries(POSITIONS.map((p) => [p, PositionAllowedSchema])) as Record<
            (typeof POSITIONS)[number],
            typeof PositionAllowedSchema
          >
        )
      })
    )
  }),
  handler: async (ctx, input) => {
    const current = currentWeek(await ctx.data.reference.nflState.get());
    const season = input.season ?? current?.season ?? null;
    const week =
      season === null
        ? null
        : current !== null && current.season === season
          ? current.week
          : PAST_SEASON_WEEK;
    const table =
      season === null || week === null
        ? null
        : await loadPointsAllowed(ctx.data.reference.stats, season, week);
    if (table === null) {
      return withWarnings({ season, throughWeek: null, scoring: 'ppr' as const, teams: [] }, [
        {
          code: 'NO_POINTS_ALLOWED',
          message:
            'No completed weeks with team defense stats are stored for that season yet. They fill in after week 1 is final.'
        }
      ]);
    }
    const position = input.position;
    const teams = table.teams
      .filter((t) => input.team === undefined || t.team === input.team)
      .sort((a, b) => (position === undefined ? 0 : a.positions[position].rank - b.positions[position].rank))
      .map((t) => ({ ...t, team: t.team as (typeof NFL_TEAMS)[number] }));
    return { season: table.season, throughWeek: table.throughWeek, scoring: 'ppr' as const, teams };
  }
});
