import type { Trade, TradeStatus } from '@fantasy/core';
import type { Repos } from '../../src/repos/types.js';
import type { TradeRecord } from '../../src/repos/trades.js';
import { START } from './harness.js';

/** Writes a trade straight to the repository (tests that need a known id or state). */
export async function seedTrade(
  repos: Repos,
  input: {
    leagueId: string;
    id: string;
    from: string;
    to: string;
    fromSends: string[];
    toSends: string[];
    status?: TradeStatus;
    expiresAt?: string;
    reviewEndsAt?: string | null;
  }
): Promise<TradeRecord> {
  const trade: Trade = {
    tradeId: input.id,
    sides: [
      { teamId: input.from, sends: input.fromSends, drops: [] },
      { teamId: input.to, sends: input.toSends, drops: [] }
    ],
    status: input.status ?? 'proposed',
    proposedAt: START,
    expiresAt: input.expiresAt ?? '2026-09-12T12:00:00.000Z',
    counterOf: null,
    counterChain: [],
    vetoVotes: [],
    reviewEndsAt: input.reviewEndsAt ?? null,
    commissionerApproved: false,
    voidReason: null,
    history: [{ status: 'proposed', at: START, byTeamId: input.from }]
  };
  const record: TradeRecord = {
    leagueId: input.leagueId,
    trade,
    message: null,
    reply: null,
    createdBy: 'user#seed',
    processingAt: null,
    updatedAt: START,
    version: 1
  };
  await repos.trades.create(record);
  return record;
}
