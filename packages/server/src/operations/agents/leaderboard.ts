import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { modelLeaderboard } from '../../season/model-stats.js';

/**
 * "Which model wins the league?" (issue #76): every team's standing next to the model that plays
 * it, and the same numbers rolled up per model (`season/model-stats.ts`). People are grouped as
 * `human`, so the league can see whether the models beat them. Costs are estimates from the model
 * catalog.
 */

const RecordFields = {
  wins: z.number().int(),
  losses: z.number().int(),
  ties: z.number().int(),
  winRate: z
    .number()
    .nullable()
    .describe('(wins + ties / 2) / games, 0 to 1; null before any game is final.'),
  pointsFor: z.number(),
  costUsd: z.number().describe('Estimated model spend this season (0 for people).'),
  trades: z.number().int().describe('Processed trades this season (a trade counts once per side).'),
  tradesWon: z.number().int().describe('Trades whose player value came out positive.'),
  tradesLost: z.number().int(),
  tradeValue: z
    .number()
    .describe(
      'Player value won (+) or lost (-) in trades: rest-of-season points over replacement received, minus sent and dropped, projected from the week of each trade.'
    ),
  waiverClaims: z
    .number()
    .int()
    .describe('Awarded waiver claims with at least one final week rostered (the ones that can be judged).'),
  waiverHits: z
    .number()
    .int()
    .describe('Claims whose player outscored the dropped player over the weeks he was rostered.'),
  waiverHitRate: z.number().nullable().describe('waiverHits / waiverClaims, 0 to 1; null without a claim.'),
  waiverNetPoints: z.number().describe('Points the claimed players scored over the dropped players, summed.')
};

const TeamEntrySchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  seatType: z.enum(['agent', 'human']),
  rank: z.number().int(),
  modelKey: z.string().describe('The primary decision model, or "human" for a person.'),
  modelName: z.string(),
  provider: z.string().nullable(),
  personality: z.string().nullable(),
  difficulty: z.string().nullable(),
  ...RecordFields
});

const ModelEntrySchema = z.object({
  modelKey: z.string(),
  modelName: z.string(),
  provider: z.string().nullable(),
  teams: z.number().int(),
  bestRank: z.number().int(),
  pointsForPerTeam: z.number(),
  costPerWinUsd: z.number().nullable().describe('Estimated spend per win; null without a win or for people.'),
  ...RecordFields
});

export const getModelLeaderboard = defineOperation({
  name: 'get_model_leaderboard',
  method: 'GET',
  path: '/leagues/{leagueId}/model-leaderboard',
  summary: 'Which model wins the league: standings, trades, waivers, and cost by model',
  description: [
    'Joins every team\'s standing (rank, record, win rate, points for) with the model that plays it: an agent seat\'s primary decision model, or "human" for a person. Then rolls the same numbers up per model, best win rate first, with estimated model spend and spend per win, trade value won or lost, and waiver hit rate.',
    'Use it for "model power rankings" posts and to compare how model families value players. Standings are as of the last final week; costs are estimates from the model catalog, not billing data. Any league member can read it.',
    'It is observational: one league mixes each model with its strategy, difficulty, roster luck, settings changes, and fallbacks, so present it as how this league went, never as proof that one model is better.',
    'Errors: FORBIDDEN if you are not in the league; LEAGUE_NOT_FOUND for an unknown league.'
  ].join(' '),
  tags: ['agents', 'season'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema }),
  output: z.object({
    throughWeek: z
      .number()
      .int()
      .nullable()
      .describe('Last week included, or null when no week is final yet.'),
    teams: z.array(TeamEntrySchema).describe('One entry per team, in standings order.'),
    models: z.array(ModelEntrySchema).describe('One entry per model (and one for people), best first.')
  }),
  handler: async (ctx, input) => {
    const { league, teams } = await requireMember(ctx, input.leagueId);
    const deps = { repos: ctx.repos, reference: ctx.data.reference, log: ctx.log };
    return modelLeaderboard(deps, league, teams, ctx.clock.now());
  }
});
