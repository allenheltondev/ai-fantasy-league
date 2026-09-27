import { z } from 'zod';
import { AgentTaskRecordSchema } from '../../repos/agents.js';
import { defineOperation } from '../../registry/operation.js';
import { LeagueBudgetSchema, leagueBudget } from './budget.js';
import { TeamIdSchema, requireCommissioner } from './shared.js';

export const getAgentActivity = defineOperation({
  name: 'get_agent_activity',
  method: 'GET',
  path: '/leagues/{leagueId}/agent-activity',
  summary: "Review the league's agents: recent decisions and model spend",
  description: [
    'Commissioner only. Lists recent agent tasks, newest first: what triggered each one, the tools it called, its final action, a short reasoning summary, latency, and tokens and estimated cost per model.',
    "Also returns the week's estimated spend against the league's weekly ceiling; when the ceiling is exceeded (or the global kill switch is on), agents use deterministic fallbacks instead of models.",
    'Filter to one team with `teamId`; pick a past week with `week`. Costs are estimates from the model catalog, not billing data.',
    'Errors: FORBIDDEN if you are not the commissioner; LEAGUE_NOT_FOUND for an unknown league.'
  ].join(' '),
  tags: ['agents'],
  mutation: false,
  auth: 'user',
  input: z.object({
    leagueId: z.string(),
    teamId: TeamIdSchema.optional(),
    week: z.number().int().min(0).max(25).optional().describe('Week for the spend summary; defaults to now.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum tasks (1-100, default 25).')
  }),
  output: z.object({ tasks: z.array(AgentTaskRecordSchema), budget: LeagueBudgetSchema }),
  handler: async (ctx, input) => {
    const league = await requireCommissioner(ctx, input.leagueId);
    const [tasks, budget] = await Promise.all([
      ctx.repos.agents.listTasks(league.id, { teamId: input.teamId, limit: input.limit }),
      leagueBudget(ctx.repos.agents, league, input.week)
    ]);
    return { tasks, budget };
  }
});
