import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { AgentTaskRecordSchema, type AgentTaskRecord, type AgentTaskSeal } from '../../repos/agents.js';
import { defineOperation } from '../../registry/operation.js';
import type { Repos } from '../../repos/types.js';
import { PUBLIC_STATUSES } from '../trades/shared.js';
import { LeagueBudgetSchema, SeasonSpendSchema, leagueBudget, seasonSpend } from './budget.js';
import { TeamIdSchema, requireCommissioner } from './shared.js';

/** Trade statuses after which nothing about the trade is secret any more. */
const FINAL_STATUSES: ReadonlySet<string> = new Set(['processed', 'vetoed']);

const AgentTaskViewSchema = AgentTaskRecordSchema.omit({ sealed: true }).extend({
  redacted: z
    .boolean()
    .describe(
      'True when the task is withheld because it holds sealed information (a waiver bid still pending, a trade offer only its two teams can see, a vote while the review is open): `reasoningSummary` says what kind of move it was, `finalAction` is `sealed`, and the tools, status, and cost are masked. The real record appears once the claim or trade resolves; the weekly spend totals always include it.'
    )
});

export const getAgentActivity = defineOperation({
  name: 'get_agent_activity',
  method: 'GET',
  path: '/leagues/{leagueId}/agent-activity',
  summary: "Review the league's agents: recent decisions and model spend",
  description: [
    'Commissioner only. Lists recent agent tasks, newest first: what triggered each one, the tools it called, its final action, a short reasoning summary, latency, and tokens and estimated cost per model.',
    'Summaries that would reveal sealed information (pending waiver bids, private trade offers, veto votes while the review is open) are withheld (`redacted: true`) until it resolves, so a commissioner who also plays learns nothing the other managers cannot see.',
    "Also returns the week's estimated spend against the league's weekly ceiling (the commissioner's `settings.ai.weeklyBudgetUsd`, or automatic from the seats' difficulties) and any overage allowed past it, per agent with each agent's allowance; the spend of every budget week so far (`season`); and whether the global kill switch is engaged. When spend reaches the ceiling plus the overage, or the kill switch is on, agents use deterministic fallbacks instead of models.",
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
  output: z.object({
    tasks: z.array(AgentTaskViewSchema),
    budget: LeagueBudgetSchema,
    season: SeasonSpendSchema,
    killSwitch: z
      .object({
        configured: z.boolean().describe('False when this deployment has no kill switch parameter.'),
        engaged: z
          .boolean()
          .describe(
            'True while every agent is in deterministic mode (no model calls). Unreadable counts as engaged.'
          )
      })
      .describe('The global agent kill switch, set by the operators (not per league).')
  }),
  handler: async (ctx, input) => {
    const { league } = await requireCommissioner(ctx, input.leagueId);
    const [tasks, budget, season, engaged] = await Promise.all([
      ctx.repos.agents.listTasks(league.id, { teamId: input.teamId, limit: input.limit }),
      leagueBudget(ctx.repos.agents, league, input.week),
      seasonSpend(ctx.repos.agents, league),
      ctx.agentKillSwitch?.engaged() ?? Promise.resolve(false)
    ]);
    const views = [];
    for (const task of tasks) views.push(await taskView(ctx, task));
    return {
      tasks: views,
      budget,
      season,
      killSwitch: { configured: ctx.agentKillSwitch !== undefined, engaged }
    };
  }
});

async function taskView(ctx: Ctx, task: AgentTaskRecord): Promise<z.infer<typeof AgentTaskViewSchema>> {
  const { sealed, ...rest } = task;
  if (sealed === undefined || !(await stillSealed(ctx.repos, task.leagueId, sealed))) {
    return { ...rest, redacted: false };
  }
  // Everything else that could give the move away is masked too: the action, the tools called,
  // and whether a model ran (a veto costs a model call; letting a trade pass does not).
  const { errorDetail: _errorDetail, ...unsealed } = rest;
  return {
    ...unsealed,
    status: 'completed',
    fallbackReason: null,
    finalAction: 'sealed',
    toolsCalled: [],
    usage: [],
    costUsd: 0,
    reasoningSummary: sealed.summary,
    redacted: true
  };
}

/**
 * True while any sealed move is unresolved: a trade not yet public (or final), a pending waiver
 * claim, or one that cannot be found. A `withheld` seal never lifts. Shared with the agents runtime,
 * which applies the same rules to private memory (#206).
 */
export async function stillSealed(
  repos: Pick<Repos, 'trades' | 'waivers'>,
  leagueId: string,
  seal: Pick<AgentTaskSeal, 'trades' | 'waiverClaims' | 'withheld'>
): Promise<boolean> {
  if (seal.withheld === true) return true;
  for (const ref of seal.trades) {
    const status = (await repos.trades.get(leagueId, ref.tradeId))?.trade.status;
    const open = ref.until === 'final' ? FINAL_STATUSES : PUBLIC_STATUSES;
    if (status === undefined || !open.has(status)) return true;
  }
  for (const claimId of seal.waiverClaims) {
    const claim = await repos.waivers.getClaim(leagueId, claimId);
    if (claim === null || claim.status === 'pending') return true;
  }
  return false;
}
