import {
  expireTrade,
  processTrade,
  reconcileLineup,
  reviewSettingsFor,
  ruleError,
  voidOffer,
  voidTrade,
  type LeagueSettings,
  type RuleIssue,
  type Trade,
  type TradeSide
} from '@fantasy/core';
import { ApiError, isApiError, type ErrorCode } from '../errors.js';
import type { TradeEventDetail } from '../events/details.js';
import type { FantasyEventType } from '../events/publisher.js';
import { scheduleName } from '../events/schedule-name.js';
import { toPlayerRef, type PlayerRef } from '../players/model.js';
import type { League, Repos, Team } from '../repos/types.js';
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
 * (`vetoed` with a `voidReason`), and so is one whose player a third team took before his lock
 * moved (the locks already moved go back first). While a trade is processing, `drop_player` and
 * waiver claims refuse its players (`assertNotInProcessingTrade`).
 *
 * When players move (a processed trade, a drop, a waiver award), every open offer that includes one
 * of them is voided (`voidStaleOffers`): it becomes `expired` with a `voidReason`.
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
export type { TradeEventDetail };

/** The state-machine events. */
export type TradeEventType = Extract<
  FantasyEventType,
  `Trade ${'Proposed' | 'Countered' | 'Accepted' | 'Rejected' | 'Expired' | 'Withdrawn' | 'Processed' | 'Vetoed'}`
>;

/** The commissioner's own team, if they hold a seat. */
export function commissionerTeamId(
  league: Pick<League, 'commissionerId'>,
  teams: readonly Team[]
): string | null {
  return teams.find((t) => t.ownerUserId === league.commissionerId)?.id ?? null;
}

/**
 * The league settings with the review mode that applies to this trade: under commissioner review,
 * the commissioner's own trade goes to a league vote instead (core `reviewSettingsFor`).
 */
export function tradeReviewSettings(
  league: Pick<League, 'settings' | 'commissionerId'>,
  teams: readonly Team[],
  trade: Pick<Trade, 'sides'>
): LeagueSettings {
  return reviewSettingsFor(league.settings, trade, commissionerTeamId(league, teams));
}

export async function publishTradeEvent(
  deps: Pick<TradeDeps, 'repos' | 'events'>,
  type: TradeEventType,
  league: League,
  record: TradeRecord,
  extra: Pick<TradeEventDetail, 'voided' | 'reason' | 'reasonCode'> = {}
): Promise<void> {
  const refs = await refsFor(deps.repos, tradePlayerIds(record.trade));
  const settings =
    league.settings.trades.review === 'commissioner'
      ? tradeReviewSettings(league, await deps.repos.teams.list(league.id), record.trade)
      : league.settings;
  await deps.events.publish(type, tradeEventDetail({ settings }, record, refs, extra));
}

export const offerExpiryName = (leagueId: string, tradeId: string) =>
  scheduleName('trade-expiry', leagueId, tradeId);
export const reviewEndName = (leagueId: string, tradeId: string) =>
  scheduleName('trade-review', leagueId, tradeId);
export const tradeDeadlineName = (leagueId: string) => scheduleName('trade-deadline', leagueId);

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
    const settings = tradeReviewSettings(league, world.teams, current.trade);
    const result = processTrade(settings, current.trade, world.context);
    if (!result.ok && result.issues.every((i) => i.code === 'PLAYER_LOCKED')) {
      // Yahoo rule (docs/rules.md): a trade with a player whose game has kicked off waits until the
      // week's locks release, then processes; lineups never change under a locked player.
      await scheduleReviewEnd(deps, current, await locksReleaseAt(deps.reference, league, now));
      return { outcome: 'waiting_for_locks', record: current };
    }
    if (!result.ok) {
      const issue = result.issues[0] as RuleIssue;
      if (NOT_READY.has(issue.code)) return { outcome: 'not_ready', record: current };
      return voidAccepted(deps, league, current, issue, now);
    }
    const stamped = await saveTrade(deps.repos, { ...current, processingAt: now.toISOString() }, now);
    if (stamped === null) return { outcome: 'raced', record: current };
    current = stamped;
  }
  const at = current.processingAt as string;
  const applied = await applyTrade(deps, league, current.trade, at, now);
  if (!applied.ok) {
    deps.log.warn('trade player taken by a third team; voiding the trade', {
      leagueId: league.id,
      tradeId: current.trade.tradeId,
      playerId: applied.playerId
    });
    const name = (await refsFor(deps.repos, [applied.playerId])).get(applied.playerId)?.name;
    const issue = ruleError(
      'PLAYER_NOT_AVAILABLE',
      `trades.${current.trade.tradeId}`,
      `${name ?? applied.playerId} joined ${applied.holder === null ? 'another team' : `team ${applied.holder}`} before this trade could move him.`,
      'This trade was cancelled. Re-read both rosters and propose a new trade if both teams are still interested.',
      { playerId: applied.playerId, teamId: applied.holder }
    );
    return voidAccepted(deps, league, current, issue, now);
  }
  const processed: Trade = {
    ...current.trade,
    status: 'processed',
    history: [...current.trade.history, { status: 'processed', at, byTeamId: null }]
  };
  const saved = await saveTrade(deps.repos, { ...current, trade: processed }, now);
  if (saved === null) return { outcome: 'raced', record: current };
  await publishTradeEvent(deps, 'Trade Processed', league, saved);
  deps.log.info('trade processed', { leagueId: league.id, tradeId: processed.tradeId });
  await voidStaleOffers(deps, league, tradePlayerIds(processed), now);
  return { outcome: 'processed', record: saved };
}

/** Cancels an accepted trade that can no longer process (`vetoed` with a `voidReason`). */
async function voidAccepted(
  deps: TradeDeps,
  league: League,
  current: TradeRecord,
  issue: RuleIssue,
  now: Date
): Promise<{ outcome: ProcessOutcome; record: TradeRecord }> {
  const voided = voidTrade(current.trade, issue, now.toISOString());
  if (!voided.ok) return { outcome: 'not_ready', record: current };
  const saved = await saveTrade(deps.repos, { ...current, trade: voided.trade }, now);
  if (saved === null) return { outcome: 'raced', record: current };
  await publishTradeEvent(deps, 'Trade Vetoed', league, saved, {
    voided: true,
    reason: `${issue.message} ${issue.fix}`,
    reasonCode: issue.code
  });
  return { outcome: 'voided', record: saved };
}

/**
 * Voids every open offer that includes one of `playerIds`, because those players just moved (a
 * processed trade, a drop, or a waiver award): each becomes `expired` with a `voidReason`, and
 * `Trade Expired` goes to the two teams. Returns how many were voided.
 */
export async function voidStaleOffers(
  deps: Pick<TradeDeps, 'repos' | 'events'>,
  league: League,
  playerIds: readonly (string | null)[],
  now: Date
): Promise<number> {
  const moved = new Set(playerIds.filter((id): id is string => id !== null));
  if (moved.size === 0) return 0;
  // Every trade with one of them; only open offers can be voided (`voidOffer` refuses the rest).
  const touched = (await deps.repos.trades.list(league.id)).filter((r) =>
    tradePlayerIds(r.trade).some((id) => moved.has(id))
  );
  if (touched.length === 0) return 0;
  const refs = await refsFor(deps.repos, [...moved]);
  let voided = 0;
  for (const record of touched) {
    const ids = tradePlayerIds(record.trade).filter((id) => moved.has(id));
    const names = ids.map((id) => refs.get(id)?.name ?? id).join(', ');
    const issue = ruleError(
      'PLAYER_MOVED',
      `trades.${record.trade.tradeId}`,
      `${names} changed rosters after this offer was made, so it no longer works.`,
      'Re-read both rosters (get_roster) and propose a new trade if both teams are still interested.',
      { playerIds: ids }
    );
    const result = voidOffer(record.trade, issue, now.toISOString());
    if (!result.ok) continue;
    const saved = await saveTrade(deps.repos, { ...record, trade: result.trade }, now);
    if (saved === null) continue;
    await publishTradeEvent(deps, 'Trade Expired', league, saved, {
      voided: true,
      reason: `${issue.message} ${issue.fix}`,
      reasonCode: issue.code
    });
    voided++;
  }
  return voided;
}

/** Players in a trade that has started processing (`processingAt` set, not yet processed or voided). */
export async function playersInProcessingTrades(
  repos: Pick<Repos, 'trades'>,
  leagueId: string
): Promise<Map<string, string>> {
  const players = new Map<string, string>();
  for (const record of await repos.trades.list(leagueId)) {
    if (record.processingAt === null) continue;
    if (record.trade.status !== 'accepted' && record.trade.status !== 'in_review') continue;
    for (const id of tradePlayerIds(record.trade)) players.set(id, record.trade.tradeId);
  }
  return players;
}

/** Throws PLAYER_IN_TRADE when one of `playerIds` is in a trade that is processing right now. */
export async function assertNotInProcessingTrade(
  repos: Pick<Repos, 'trades'>,
  leagueId: string,
  playerIds: readonly (string | null)[]
): Promise<void> {
  const trading = await playersInProcessingTrades(repos, leagueId);
  for (const playerId of playerIds) {
    const tradeId = playerId === null ? undefined : trading.get(playerId);
    if (playerId !== null && tradeId !== undefined) throw inTradeError(playerId, tradeId);
  }
}

/** The PLAYER_IN_TRADE error (also a waiver claim's failure reason). */
export function inTradeError(playerId: string, tradeId: string): ApiError {
  return new ApiError(
    'PLAYER_IN_TRADE',
    `Player ${playerId} is part of trade ${tradeId}, which is being processed right now.`,
    {
      fix: 'Wait a minute for the trade to finish (list_trades shows it as processed), then read your roster again and pick a player who is still on it.',
      details: { playerId, tradeId }
    }
  );
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

type ApplyResult = { ok: true } | { ok: false; playerId: string; holder: string | null };

/**
 * Moves a player's ownership lock from the team sending him to the team receiving him. A lock a
 * third team holds without having him on its roster is stale and is taken over; a third team that
 * does roster him keeps it (false).
 */
async function takeLock(
  repos: Repos,
  leagueId: string,
  playerId: string,
  to: string,
  from: string
): Promise<boolean> {
  if (await repos.waivers.acquirePlayer(leagueId, playerId, to, from)) return true;
  const holder = await repos.waivers.playerOwner(leagueId, playerId);
  const holderTeam = holder === null ? null : await repos.teams.get(leagueId, holder);
  if (holderTeam?.roster.includes(playerId) === true) return false;
  return repos.waivers.acquirePlayer(leagueId, playerId, to, holder ?? from);
}

async function applyTrade(
  deps: TradeDeps,
  league: League,
  trade: Trade,
  at: string,
  now: Date
): Promise<ApplyResult> {
  const { repos } = deps;
  const pairs = [
    [trade.sides[0], trade.sides[1]],
    [trade.sides[1], trade.sides[0]]
  ] as const;
  // Each received player's ownership lock moves to his new team first, so no add can take him. If a
  // third team already holds one (he left the roster and was picked up before the trade got here),
  // the locks moved so far go back and nothing else changes: the trade is voided, never half done.
  const moved: { playerId: string; from: string; to: string }[] = [];
  for (const [side, other] of pairs) {
    for (const playerId of other.sends) {
      if (await takeLock(repos, league.id, playerId, side.teamId, other.teamId)) {
        moved.push({ playerId, from: other.teamId, to: side.teamId });
        continue;
      }
      for (const m of moved) await repos.waivers.acquirePlayer(league.id, m.playerId, m.from, m.to);
      return { ok: false, playerId, holder: await repos.waivers.playerOwner(league.id, playerId) };
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
  return { ok: true };
}
