import {
  expireTrade,
  processTrade,
  reconcileLineup,
  voidTrade,
  type RuleIssue,
  type Trade,
  type TradeSide
} from '@fantasy/core';
import { ApiError, isApiError, type ErrorCode } from '../errors.js';
import type { FantasyEventType } from '../events/publisher.js';
import { toPlayerRef, type PlayerRef } from '../players/model.js';
import type { League, Repos } from '../repos/types.js';
import type { TradeRecord } from '../repos/trades.js';
import type { TransactionRecord } from '../repos/waivers.js';
import { putOnWaivers } from '../waivers/rosters.js';
import { loadTradeWorld, locksReleaseAt, tradeWeek, type TradeDeps } from './world.js';

/**
 * The trade lifecycle around core's state machine (#63, #65, #79): saving transitions
 * (version-checked), the events for each one, scheduling offer expiry and review ends through the
 * rsc-core deferred scheduler, and processing an accepted trade.
 *
 * Processing is idempotent. It validates the trade once more (rosters, deadline, locks) and then
 * stamps the record with `processingAt`: from that commit point on, a retry never validates again,
 * it only finishes the moves. Each step is safe to repeat: the players' `OWN#` locks move to the
 * receiving team, each roster is rewritten from its own diff (a roster already swapped is left
 * alone), the required drops go on waivers, the `TXN#` records have ids derived from the trade, and
 * the current week's saved lineups are reconciled with the new rosters. Only then does the trade
 * become `processed` and `Trade Processed` go out. A trade that no longer validates is voided
 * (`vetoed` with a `voidReason`).
 */

/** Core issue codes that already are API error codes. */
const DIRECT_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'TRADE_DEADLINE_PASSED',
  'TRADE_EXPIRED',
  'ILLEGAL_TRADE_TRANSITION',
  'NOT_YOUR_TRADE_ACTION',
  'ROSTER_LIMIT_EXCEEDED',
  'TRADE_NOT_IN_REVIEW',
  'PLAYER_NOT_ON_ROSTER',
  'PLAYER_LOCKED'
]);
const VOTE_CODES = new Set([
  'PARTY_CANNOT_VOTE',
  'ALREADY_VOTED',
  'REVIEW_CLOSED',
  'VOTING_NOT_ENABLED',
  'COMMISSIONER_REVIEW_NOT_ENABLED'
]);

export function issueJson(issue: RuleIssue): { code: string; message: string; fix: string } {
  return { code: issue.code, message: issue.message, fix: issue.fix };
}

/** Core's rule issues as one API error: the first issue's code, every message and fix. */
export function tradeError(issues: readonly RuleIssue[]): ApiError {
  const code = issues[0]?.code ?? 'TRADE_INVALID';
  const apiCode: ErrorCode = DIRECT_CODES.has(code)
    ? (code as ErrorCode)
    : VOTE_CODES.has(code)
      ? 'VOTE_NOT_ALLOWED'
      : 'TRADE_INVALID';
  return new ApiError(apiCode, issues.map((i) => i.message).join(' '), {
    fix: issues.map((i) => i.fix).join(' ') || 'Check the trade with preview_trade and try again.',
    details: { issues: issues.map(issueJson) }
  });
}

/** Version-checked save; null when another writer got there first. */
export async function saveTrade(repos: Repos, record: TradeRecord, now: Date): Promise<TradeRecord | null> {
  try {
    return await repos.trades.update({ ...record, updatedAt: now.toISOString() });
  } catch (error) {
    if (isApiError(error) && error.code === 'CONFLICT') return null;
    throw error;
  }
}

/** Players as refs, for events and views. */
export async function refsFor(repos: Repos, ids: readonly string[]): Promise<Map<string, PlayerRef>> {
  const players = await repos.players.getMany([...new Set(ids)]);
  return new Map(players.map((p) => [p.id, toPlayerRef(p)]));
}

export function tradePlayerIds(trade: Pick<Trade, 'sides'>): string[] {
  return trade.sides.flatMap((s) => [...s.sends, ...s.drops]);
}

/** The detail of every `Trade *` event (Proposed, Countered, Accepted, Rejected, Expired, Processed, Vetoed). */
export interface TradeEventDetail {
  leagueId: string;
  tradeId: string;
  status: Trade['status'];
  /** The team that made this offer. */
  fromTeamId: string;
  /** The team that must answer it (the router's agent trigger target). */
  toTeamId: string;
  teamIds: [string, string];
  /** Players `fromTeamId` sends, as refs. */
  fromPlayers: PlayerRef[];
  /** Players `toTeamId` sends, as refs. */
  toPlayers: PlayerRef[];
  fromDrops: PlayerRef[];
  toDrops: PlayerRef[];
  counterOf: string | null;
  expiresAt: string;
  reviewEndsAt: string | null;
  review: League['settings']['trades']['review'];
  /** `Trade Vetoed` only: true when the trade was cancelled because it no longer validated. */
  voided?: boolean;
  /** `Trade Vetoed` only, with `voided`: what went wrong and its rule code. */
  reason?: string;
  reasonCode?: string;
}

/** Builds a trade event's detail (pure; exported for the event contract tests). */
export function tradeEventDetail(
  league: Pick<League, 'settings'>,
  record: Pick<TradeRecord, 'leagueId' | 'trade'>,
  refs: ReadonlyMap<string, PlayerRef>,
  extra: Pick<TradeEventDetail, 'voided' | 'reason' | 'reasonCode'> = {}
): TradeEventDetail {
  const { trade } = record;
  const [from, to] = trade.sides;
  const list = (ids: readonly string[]): PlayerRef[] =>
    ids.map((id) => refs.get(id) ?? { id, name: id, team: null, position: 'WR' });
  return {
    leagueId: record.leagueId,
    tradeId: trade.tradeId,
    status: trade.status,
    fromTeamId: from.teamId,
    toTeamId: to.teamId,
    teamIds: [from.teamId, to.teamId],
    fromPlayers: list(from.sends),
    toPlayers: list(to.sends),
    fromDrops: list(from.drops),
    toDrops: list(to.drops),
    counterOf: trade.counterOf,
    expiresAt: trade.expiresAt,
    reviewEndsAt: trade.reviewEndsAt,
    review: league.settings.trades.review,
    ...extra
  };
}

/** Publishes a trade event with `tradeEventDetail`. */
export async function publishTradeEvent(
  deps: Pick<TradeDeps, 'repos' | 'events'>,
  type: FantasyEventType,
  league: League,
  record: TradeRecord,
  extra: Pick<TradeEventDetail, 'voided' | 'reason' | 'reasonCode'> = {}
): Promise<void> {
  const refs = await refsFor(deps.repos, tradePlayerIds(record.trade));
  await deps.events.publish(type, { ...tradeEventDetail(league, record, refs, extra) });
}

export const offerExpiryName = (leagueId: string, tradeId: string) => `trade-expiry-${leagueId}-${tradeId}`;
export const reviewEndName = (leagueId: string, tradeId: string) => `trade-review-${leagueId}-${tradeId}`;
export const tradeDeadlineName = (leagueId: string) => `trade-deadline-${leagueId}`;

export async function scheduleOfferExpiry(
  deps: Pick<TradeDeps, 'events'>,
  record: TradeRecord
): Promise<void> {
  await deps.events.scheduleAt({
    at: new Date(record.trade.expiresAt),
    name: offerExpiryName(record.leagueId, record.trade.tradeId),
    whenPast: 'send',
    event: {
      detailType: 'Trade Offer Deadline',
      detail: { leagueId: record.leagueId, tradeId: record.trade.tradeId, expiresAt: record.trade.expiresAt }
    }
  });
}

export async function scheduleReviewEnd(
  deps: Pick<TradeDeps, 'events'>,
  record: TradeRecord,
  at: string | null = record.trade.reviewEndsAt
): Promise<void> {
  if (at === null) return;
  await deps.events.scheduleAt({
    at: new Date(at),
    name: reviewEndName(record.leagueId, record.trade.tradeId),
    whenPast: 'send',
    event: {
      detailType: 'Trade Review Ended',
      detail: {
        leagueId: record.leagueId,
        tradeId: record.trade.tradeId,
        reviewEndsAt: record.trade.reviewEndsAt
      }
    }
  });
}

/** Schedules `Trade Deadline Passed` at the league's trade deadline (a stable name, so it moves). */
export async function scheduleTradeDeadline(deps: Pick<TradeDeps, 'events'>, league: League): Promise<void> {
  const at = league.deadlines.tradeDeadlineAt;
  if (at === null) return;
  await deps.events.scheduleAt({
    at: new Date(at),
    name: tradeDeadlineName(league.id),
    whenPast: 'send',
    event: {
      detailType: 'Trade Deadline Passed',
      detail: { leagueId: league.id, deadlineWeek: league.settings.trades.deadlineWeek, deadlineAt: at }
    }
  });
}

export type ExpireOutcome = 'expired' | 'stale' | 'early' | 'raced';

/**
 * Expires an unanswered offer once its time is up. `force` (the trade deadline) expires it now even
 * when `expiresAt` is later. Anything but an open offer is a stale no-op.
 */
export async function expireOffer(
  deps: Pick<TradeDeps, 'repos' | 'events'>,
  league: League,
  record: TradeRecord,
  now: Date,
  options: { force?: boolean } = {}
): Promise<ExpireOutcome> {
  if (record.trade.status !== 'proposed') return 'stale';
  const at = now.toISOString();
  const trade =
    options.force === true && record.trade.expiresAt > at ? { ...record.trade, expiresAt: at } : record.trade;
  const expired = expireTrade(trade, at);
  if (!expired.ok) return 'early';
  const saved = await saveTrade(deps.repos, { ...record, trade: expired.trade }, now);
  if (saved === null) return 'raced';
  await publishTradeEvent(deps, 'Trade Expired', league, saved);
  return 'expired';
}

export type ProcessOutcome = 'processed' | 'voided' | 'not_ready' | 'waiting_for_locks' | 'raced';

/** Codes that mean "not yet": the trade waits for its review rather than being voided. */
const NOT_READY = new Set(['REVIEW_PENDING', 'AWAITING_COMMISSIONER', 'REVIEW_REQUIRED']);

/** Processes an accepted (or reviewed) trade; see the module comment. */
export async function processAccepted(
  deps: TradeDeps,
  league: League,
  record: TradeRecord,
  now: Date
): Promise<{ outcome: ProcessOutcome; record: TradeRecord }> {
  let current = record;
  if (current.processingAt === null) {
    const world = await loadTradeWorld(deps, league, now);
    const result = processTrade(league.settings, current.trade, world.context);
    if (!result.ok && result.issues.every((i) => i.code === 'PLAYER_LOCKED')) {
      // Yahoo rule (docs/rules.md): a trade with a player whose game has kicked off waits until the
      // week's locks release, then processes; lineups never change under a locked player.
      await scheduleReviewEnd(deps, current, await locksReleaseAt(deps.reference, league, now));
      return { outcome: 'waiting_for_locks', record: current };
    }
    if (!result.ok) {
      const issue = result.issues[0] as RuleIssue;
      const voided = NOT_READY.has(issue.code) ? null : voidTrade(current.trade, issue, now.toISOString());
      if (voided === null || !voided.ok) return { outcome: 'not_ready', record: current };
      const saved = await saveTrade(deps.repos, { ...current, trade: voided.trade }, now);
      if (saved === null) return { outcome: 'raced', record: current };
      await publishTradeEvent(deps, 'Trade Vetoed', league, saved, {
        voided: true,
        reason: `${issue.message} ${issue.fix}`,
        reasonCode: issue.code
      });
      return { outcome: 'voided', record: saved };
    }
    const stamped = await saveTrade(deps.repos, { ...current, processingAt: now.toISOString() }, now);
    if (stamped === null) return { outcome: 'raced', record: current };
    current = stamped;
  }
  const at = current.processingAt as string;
  await applyTrade(deps, league, current.trade, at, now);
  const processed: Trade = {
    ...current.trade,
    status: 'processed',
    history: [...current.trade.history, { status: 'processed', at, byTeamId: null }]
  };
  const saved = await saveTrade(deps.repos, { ...current, trade: processed }, now);
  if (saved === null) return { outcome: 'raced', record: current };
  await publishTradeEvent(deps, 'Trade Processed', league, saved);
  deps.log.info('trade processed', { leagueId: league.id, tradeId: processed.tradeId });
  return { outcome: 'processed', record: saved };
}

const MAX_WRITE_ATTEMPTS = 4;

/** Rewrites one team's roster from the trade: its sends and drops leave, the other side's sends join. */
async function writeRoster(
  repos: Repos,
  leagueId: string,
  side: TradeSide,
  receives: readonly string[],
  now: Date
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const team = await repos.teams.get(leagueId, side.teamId);
    if (team === null) return;
    const leaving = new Set([...side.sends, ...side.drops, ...receives]);
    const roster = [...team.roster.filter((id) => !leaving.has(id)), ...receives];
    if (roster.length === team.roster.length && roster.every((id, i) => id === team.roster[i])) return;
    try {
      await repos.teams.update({ ...team, roster, updatedAt: now.toISOString() });
      return;
    } catch (error) {
      if (!isApiError(error) || error.code !== 'CONFLICT' || attempt >= MAX_WRITE_ATTEMPTS) throw error;
    }
  }
}

async function applyTrade(
  deps: TradeDeps,
  league: League,
  trade: Trade,
  at: string,
  now: Date
): Promise<void> {
  const { repos } = deps;
  const pairs = [
    [trade.sides[0], trade.sides[1]],
    [trade.sides[1], trade.sides[0]]
  ] as const;
  // Each received player's ownership lock moves to his new team first, so no add can take him.
  for (const [side, other] of pairs) {
    for (const playerId of other.sends) {
      if (!(await repos.waivers.acquirePlayer(league.id, playerId, side.teamId, other.teamId))) {
        deps.log.warn('trade player lock held by a third team', { leagueId: league.id, playerId });
      }
    }
  }
  for (const [side, other] of pairs) await writeRoster(repos, league.id, side, other.sends, now);

  const week = tradeWeek(league);
  const transactions: TransactionRecord[] = [];
  const txn = (id: string, teamId: string, add: string | null, drop: string | null): TransactionRecord => ({
    id: `${trade.tradeId}.${id}`,
    leagueId: league.id,
    at,
    week,
    type: add === null ? 'drop' : 'trade',
    teamId,
    addPlayerId: add,
    dropPlayerId: drop,
    cost: null,
    claimId: null,
    tradeId: trade.tradeId
  });
  for (const [side, other] of pairs) {
    for (const playerId of other.sends) transactions.push(txn(playerId, side.teamId, playerId, null));
    for (const playerId of side.drops) {
      await repos.waivers.releasePlayer(league.id, playerId, side.teamId);
      await putOnWaivers(repos, league.settings, {
        leagueId: league.id,
        playerId,
        teamId: side.teamId,
        droppedAt: new Date(at)
      });
      transactions.push(txn(`drop.${playerId}`, side.teamId, null, playerId));
    }
  }
  await repos.waivers.addTransactions(transactions);

  // Saved lineups for this week follow the new rosters (departed players out, arrivals on the bench).
  for (const side of trade.sides) {
    const [team, lineup] = await Promise.all([
      repos.teams.get(league.id, side.teamId),
      repos.lineups.get(league.id, side.teamId, week)
    ]);
    if (team === null || lineup === null) continue;
    await repos.lineups.put([
      {
        ...lineup,
        entries: reconcileLineup(lineup.entries, team.roster),
        updatedAt: now.toISOString(),
        updatedBy: 'system'
      }
    ]);
  }
}
