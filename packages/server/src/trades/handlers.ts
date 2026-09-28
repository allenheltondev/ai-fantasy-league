import { z } from 'zod';
import type { Services } from '../context.js';
import { expireOffer, processAccepted, type ExpireOutcome, type ProcessOutcome } from './lifecycle.js';
import type { TradeDeps } from './world.js';

/**
 * Timed trade events the API function handles (the rsc-core scheduler publishes them):
 * - `Trade Offer Deadline` at an offer's `expiresAt`: expire it if it is still unanswered.
 * - `Trade Review Ended` at the end of a review period: process the trade unless it was vetoed.
 * - `Trade Deadline Passed` at the deadline week's first kickoff: every open offer expires.
 * A stale event (the trade moved on, or the league is gone) is a no-op.
 */

export const TRADE_TIMER_EVENTS = ['Trade Offer Deadline', 'Trade Review Ended', 'Trade Deadline Passed'];

export type TradeTimerOutcome = ExpireOutcome | ProcessOutcome | 'ignored' | { expired: number };

const TradeDetail = z.object({ leagueId: z.string().min(1), tradeId: z.string().min(1) });
const LeagueDetail = z.object({ leagueId: z.string().min(1) });

export function tradeDeps(services: Pick<Services, 'repos' | 'events' | 'log' | 'data'>): TradeDeps {
  return {
    repos: services.repos,
    reference: services.data.reference,
    events: services.events,
    log: services.log
  };
}

export async function handleTradeTimer(
  services: Pick<Services, 'repos' | 'events' | 'log' | 'data' | 'clock'>,
  detailType: string,
  detail: unknown
): Promise<TradeTimerOutcome> {
  const deps = tradeDeps(services);
  const now = services.clock.now();
  if (detailType === 'Trade Deadline Passed') {
    const parsed = LeagueDetail.safeParse(detail);
    const league = parsed.success ? await deps.repos.leagues.get(parsed.data.leagueId) : null;
    if (league === null) return 'ignored';
    let expired = 0;
    for (const record of await deps.repos.trades.list(league.id)) {
      if ((await expireOffer(deps, league, record, now, { force: true })) === 'expired') expired++;
    }
    return { expired };
  }
  const parsed = TradeDetail.safeParse(detail);
  if (!parsed.success) return 'ignored';
  const [league, record] = await Promise.all([
    deps.repos.leagues.get(parsed.data.leagueId),
    deps.repos.trades.get(parsed.data.leagueId, parsed.data.tradeId)
  ]);
  if (league === null || record === null) return 'ignored';
  if (detailType === 'Trade Offer Deadline') return expireOffer(deps, league, record, now);
  if (record.trade.status !== 'in_review' && record.trade.status !== 'accepted') return 'stale';
  return (await processAccepted(deps, league, record, now)).outcome;
}
