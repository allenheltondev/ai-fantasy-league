import { computeStandings, getModel, resolveAgentConfig, type StandingsRow } from '@fantasy/core';
import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema } from '../../league/views.js';
import type { AgentRepository } from '../../repos/agents.js';
import type { League } from '../../repos/types.js';
import { defineOperation } from '../../registry/operation.js';
import { budgetWeek } from './budget.js';

/**
 * "Which model wins the league?" (issue #76): every team's standing next to the model that plays
 * it, and the same numbers rolled up per model. People are grouped as `human`, so the league can
 * see whether the models beat them. Costs are estimates from the model catalog.
 */

const HUMAN = 'human';
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

const RecordFields = {
  wins: z.number().int(),
  losses: z.number().int(),
  ties: z.number().int(),
  winRate: z.number().nullable().describe('(wins + ties / 2) / games, 0 to 1; null before any game is final.'),
  pointsFor: z.number(),
  costUsd: z.number().describe('Estimated model spend this season (0 for people).')
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

export type ModelLeaderboardEntry = z.infer<typeof ModelEntrySchema>;

function winRate(wins: number, losses: number, ties: number): number | null {
  const games = wins + losses + ties;
  return games === 0 ? null : round((wins + ties / 2) / games, 3);
}

/** Estimated spend per agent id for the season so far (weeks 0 through the current week). */
async function seasonCost(agents: AgentRepository, league: League): Promise<Map<string, number>> {
  const weeks = Array.from({ length: budgetWeek(league) + 1 }, (_, week) => week);
  const rows = (await Promise.all(weeks.map((week) => agents.weekUsage(league.id, week)))).flat();
  const cost = new Map<string, number>();
  for (const row of rows) cost.set(row.agentId, (cost.get(row.agentId) ?? 0) + row.costUsd);
  return cost;
}

export const getModelLeaderboard = defineOperation({
  name: 'get_model_leaderboard',
  method: 'GET',
  path: '/leagues/{leagueId}/model-leaderboard',
  summary: 'Which model wins the league: standings and cost by model',
  description: [
    "Joins every team's standing (rank, record, win rate, points for) with the model that plays it: an agent seat's primary decision model, or \"human\" for a person. Then rolls the same numbers up per model, best win rate first, with estimated model spend and spend per win.",
    'Use it for "model power rankings" posts and to compare how model families value players. Standings are as of the last final week; costs are estimates from the model catalog, not billing data. Any league member can read it.',
    'Errors: FORBIDDEN if you are not in the league; LEAGUE_NOT_FOUND for an unknown league.'
  ].join(' '),
  tags: ['agents', 'season'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema }),
  output: z.object({
    throughWeek: z.number().int().nullable().describe('Last week included, or null when no week is final yet.'),
    teams: z.array(TeamEntrySchema).describe('One entry per team, in standings order.'),
    models: z.array(ModelEntrySchema).describe('One entry per model (and one for people), best first.')
  }),
  handler: async (ctx, input) => {
    const { league, teams } = await requireMember(ctx, input.leagueId);
    const [snapshot, seats, cost] = await Promise.all([
      ctx.repos.schedule.latestStandings(league.id),
      ctx.repos.agents.listSeats(league.id),
      seasonCost(ctx.repos.agents, league)
    ]);
    const rows: StandingsRow[] =
      snapshot?.rows ??
      computeStandings(league.settings, [], { teamIds: teams.map((t) => t.id), seed: league.scheduleSeed });

    const entries = rows.map((row): z.infer<typeof TeamEntrySchema> => {
      const team = teams.find((t) => t.id === row.teamId);
      const seat = team?.seatType === 'agent' ? seats.find((s) => s.teamId === row.teamId) : undefined;
      const config = seat === undefined ? null : resolveAgentConfig(seat.config);
      const modelKey = config?.models.decision[0] ?? HUMAN;
      const model = modelKey === HUMAN ? null : getModel(modelKey);
      return {
        teamId: row.teamId,
        teamName: team?.name ?? row.teamId,
        seatType: seat === undefined ? 'human' : 'agent',
        rank: row.rank,
        modelKey,
        modelName: model?.displayName ?? 'Human',
        provider: model?.provider ?? null,
        personality: config?.personality.displayName ?? null,
        difficulty: config?.difficulty.displayName ?? null,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
        winRate: winRate(row.wins, row.losses, row.ties),
        pointsFor: row.pointsFor,
        costUsd: seat === undefined ? 0 : round(cost.get(seat.agentId) ?? 0, 6)
      };
    });

    const byModel = new Map<string, z.infer<typeof TeamEntrySchema>[]>();
    for (const e of entries) byModel.set(e.modelKey, [...(byModel.get(e.modelKey) ?? []), e]);
    const models = [...byModel.entries()].map(([modelKey, group]): ModelLeaderboardEntry => {
      const sum = (f: (e: (typeof group)[number]) => number) => group.reduce((t, e) => t + f(e), 0);
      const wins = sum((e) => e.wins);
      const losses = sum((e) => e.losses);
      const ties = sum((e) => e.ties);
      const costUsd = round(sum((e) => e.costUsd), 6);
      const first = group[0] as (typeof group)[number];
      return {
        modelKey,
        modelName: first.modelName,
        provider: first.provider,
        teams: group.length,
        bestRank: Math.min(...group.map((e) => e.rank)),
        wins,
        losses,
        ties,
        winRate: winRate(wins, losses, ties),
        pointsFor: round(sum((e) => e.pointsFor)),
        pointsForPerTeam: round(sum((e) => e.pointsFor) / group.length),
        costUsd,
        costPerWinUsd: modelKey === HUMAN || wins === 0 ? null : round(costUsd / wins, 6)
      };
    });
    models.sort(
      (a, b) =>
        (b.winRate ?? -1) - (a.winRate ?? -1) ||
        b.pointsForPerTeam - a.pointsForPerTeam ||
        a.bestRank - b.bestRank ||
        a.modelKey.localeCompare(b.modelKey)
    );
    return { throughWeek: snapshot?.week ?? null, teams: entries, models };
  }
});
