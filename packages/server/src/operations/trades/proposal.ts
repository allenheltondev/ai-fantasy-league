import type { Trade, TradeSide } from '@fantasy/core';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import type { Team } from '../../repos/types.js';
import { loadProjections, valueTrade, type TradeWorld } from '../../trades/world.js';
import { resolvePlayers } from './shared.js';

/** Input shared by preview_trade, propose_trade, and counter_trade. */
export interface SidesInput {
  send: readonly string[];
  receive: readonly string[];
  drops: readonly string[];
}

/** `[me, other]`: I send `send` and drop `drops`; the other team sends `receive`. */
export async function buildSides(
  ctx: Ctx,
  world: TradeWorld,
  me: Team,
  other: Team,
  input: SidesInput
): Promise<[TradeSide, TradeSide]> {
  return [
    {
      teamId: me.id,
      sends: await resolvePlayers(ctx, world, me, input.send),
      drops: await resolvePlayers(ctx, world, me, input.drops)
    },
    { teamId: other.id, sends: await resolvePlayers(ctx, world, other, input.receive), drops: [] }
  ];
}

/** An offer never outlives the trade deadline. */
export function clampToDeadline(trade: Trade, deadlineAt: string | null): Trade {
  return deadlineAt !== null && deadlineAt < trade.expiresAt ? { ...trade, expiresAt: deadlineAt } : trade;
}

/**
 * The lopsided-trade guard (SPEC §10): an offer between two agent teams that the trade value math
 * calls lopsided is refused, so agents cannot hand each other obviously unfair deals.
 */
export async function guardLopsided(
  ctx: Ctx,
  world: TradeWorld,
  teams: readonly [Team, Team],
  trade: Pick<Trade, 'sides'>
): Promise<void> {
  if (teams.some((t) => t.seatType !== 'agent')) return;
  const ids = Object.values(world.context.rosters).flatMap((r) => r.map((p) => p.playerId));
  const projections = await loadProjections(ctx.data.reference, world.league, ids, ctx.clock.now());
  const value = valueTrade(world, trade, projections);
  if (!value.lopsided) return;
  throw new ApiError('TRADE_LOPSIDED', 'This trade between two AI teams is too one-sided to allow.', {
    fix: `Balance the offer: the lineup gap is ${value.lineupGap} points and the value gap ${value.valueGap}. Call preview_trade to check fairness before proposing.`,
    details: { lineupGap: value.lineupGap, valueGap: value.valueGap, favors: value.favors }
  });
}

/** Open offers one team may have out to the same team at once. */
export const MAX_OPEN_OFFERS_PER_PAIR = 2;

/**
 * Refuses a new offer (or counter) when `from` already has `MAX_OPEN_OFFERS_PER_PAIR` unanswered
 * offers out to `to`, so an agent cannot flood a team with offers and burn both teams' budgets.
 */
export async function guardOpenOffers(ctx: Ctx, leagueId: string, from: Team, to: Team): Promise<void> {
  const now = ctx.clock.now().toISOString();
  const open = (await ctx.repos.trades.list(leagueId)).filter(
    ({ trade }) =>
      trade.status === 'proposed' &&
      trade.expiresAt > now &&
      trade.sides[0].teamId === from.id &&
      trade.sides[1].teamId === to.id
  );
  if (open.length < MAX_OPEN_OFFERS_PER_PAIR) return;
  const ids = open.map((r) => r.trade.tradeId);
  throw new ApiError(
    'TOO_MANY_OPEN_OFFERS',
    `You already have ${open.length} open offers to ${to.name}; the limit is ${MAX_OPEN_OFFERS_PER_PAIR}.`,
    {
      fix: `Wait for ${to.name} to answer, or withdraw one of your open offers (withdraw_trade with tradeId ${ids.join(' or ')}) before sending another.`,
      details: { tradeIds: ids, limit: MAX_OPEN_OFFERS_PER_PAIR }
    }
  );
}
