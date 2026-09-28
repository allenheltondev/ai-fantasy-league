import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { actorTeam } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { canSee, TradeIdField, tradeViews, TradeViewSchema } from './shared.js';

const GROUPS: Record<string, readonly string[]> = {
  open: ['proposed'],
  review: ['accepted', 'in_review'],
  closed: ['countered', 'rejected', 'expired', 'withdrawn', 'processed', 'vetoed']
};

export const listTrades = defineOperation({
  name: 'list_trades',
  method: 'GET',
  path: '/leagues/{leagueId}/trades',
  summary: 'Your trade offers and the league’s trades under review',
  description: [
    'Lists trades you can see, newest first: offers your team made (`direction: "outgoing"`) or received (`"incoming"`) in any state, and every other team’s trade once it is accepted (`"league"`: under review, processed, or vetoed). Pending offers between other teams are private.',
    'Filter with `status` (`open`: waiting for an answer; `review`: accepted and under review; `closed`: everything finished) or `tradeId`. `yourActions` on each trade says what you can do now.'
  ].join(' '),
  tags: ['trades'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    tradeId: TradeIdField.optional().describe('Only this trade.'),
    status: z.enum(['open', 'review', 'closed']).optional(),
    limit: z.number().int().min(1).max(100).default(50)
  }),
  output: z.object({ trades: z.array(TradeViewSchema) }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const team = actorTeam(access.actor);
    const statuses = input.status === undefined ? null : GROUPS[input.status];
    const records = (await ctx.repos.trades.list(access.league.id))
      .filter((r) => canSee(r, team))
      .filter((r) => input.tradeId === undefined || r.trade.tradeId === input.tradeId)
      .filter((r) => statuses == null || statuses.includes(r.trade.status))
      .reverse()
      .slice(0, input.limit);
    return { trades: await tradeViews(ctx, access, records, now) };
  }
});
