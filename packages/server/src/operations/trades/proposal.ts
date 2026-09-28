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
