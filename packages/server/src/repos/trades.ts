import type { Trade } from '@fantasy/core';
import { ApiError } from '../errors.js';

/**
 * Trade persistence (#63): one `TRADE#<tradeId>` item per offer in the league partition, holding
 * core's `Trade` (status, sides, counter chain, veto votes, history) plus what only the server
 * needs. Every write after the first is version-checked, so two racing responses to one offer can
 * never both land. A season has a few dozen trades, so listing is one `begins_with(TRADE#)` query.
 */

export interface TradeRecord {
  leagueId: string;
  trade: Trade;
  /** An optional note from the team that made this offer, shown only to the two teams. */
  message: string | null;
  /** The answering team's note with its reply (accept or reject), shown only to the two teams. */
  reply: string | null;
  /** Principal key of whoever made the offer (`user#<sub>` or `agent#<agentId>`). */
  createdBy: string;
  /**
   * Set once processing has validated the trade and started moving players. A crashed processing
   * run is finished from here without validating again (the rosters may already be half swapped).
   */
  processingAt: string | null;
  updatedAt: string;
  version: number;
}

export interface TradeRepository {
  /** Creates an offer; CONFLICT if the id exists. */
  create(record: TradeRecord): Promise<void>;
  get(leagueId: string, tradeId: string): Promise<TradeRecord | null>;
  /** Every trade in the league, oldest first. */
  list(leagueId: string): Promise<TradeRecord[]>;
  /** Writes `record` with `version + 1` if the stored version equals `record.version`; else CONFLICT. */
  update(record: TradeRecord): Promise<TradeRecord>;
}

export function tradeExists(tradeId: string): ApiError {
  return new ApiError('CONFLICT', `Trade ${tradeId} already exists.`, {
    fix: 'Retry with a new idempotency key; the trade was already created.'
  });
}

export function staleTrade(tradeId: string): ApiError {
  return new ApiError('CONFLICT', `Trade ${tradeId} changed while this request was running.`, {
    fix: 'Read the trade again (list_trades with tradeId) and retry if the action still makes sense.'
  });
}

export function byProposedAt(a: TradeRecord, b: TradeRecord): number {
  return (
    a.trade.proposedAt.localeCompare(b.trade.proposedAt) || a.trade.tradeId.localeCompare(b.trade.tradeId)
  );
}
