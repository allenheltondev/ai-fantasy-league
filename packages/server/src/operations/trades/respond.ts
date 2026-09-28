import {
  acceptTrade,
  castVetoVote,
  commissionerReview,
  rejectTrade,
  startReview,
  withdrawTrade,
  type Trade
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import type { LeagueAccess } from '../../league/access.js';
import { requireMember } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import type { TradeRecord } from '../../repos/trades.js';
import {
  processAccepted,
  publishTradeEvent,
  scheduleReviewEnd,
  tradeError,
  tradeReviewSettings
} from '../../trades/lifecycle.js';
import { loadTradeWorld } from '../../trades/world.js';
import { actingTeam, TeamIdField } from '../waivers/shared.js';
import { resolvePlayers } from './shared.js';
import {
  loadTrade,
  MessageField,
  playersField,
  TradeIdField,
  tradeDepsOf,
  tradeViews,
  TradeViewSchema
} from './shared.js';

const Output = z.object({ trade: TradeViewSchema });

async function save(ctx: Ctx, record: TradeRecord, trade: Trade, now: Date): Promise<TradeRecord> {
  return ctx.repos.trades.update({ ...record, trade, updatedAt: now.toISOString() });
}

async function view(ctx: Ctx, access: LeagueAccess, record: TradeRecord, now: Date) {
  return { trade: (await tradeViews(ctx, access, [record], now))[0] as z.infer<typeof TradeViewSchema> };
}

/**
 * Starts review for an accepted trade, or processes it at once in a league without review. Returns
 * the record as it ends up.
 */
async function afterAcceptance(ctx: Ctx, access: LeagueAccess, record: TradeRecord, now: Date) {
  const deps = tradeDepsOf(ctx);
  await publishTradeEvent(deps, 'Trade Accepted', access.league, record);
  if (record.trade.status === 'in_review') {
    await scheduleReviewEnd(deps, record);
    return record;
  }
  return processNow(ctx, access, record, now);
}

/**
 * Processes a cleared trade inline. `Trade Review Ended` is scheduled for now first, so a run that
 * fails partway (after the `processingAt` stamp) is finished by the timer instead of staying stuck;
 * when the inline run succeeds, the timer finds the trade processed and does nothing.
 */
async function processNow(ctx: Ctx, access: LeagueAccess, record: TradeRecord, now: Date) {
  const deps = tradeDepsOf(ctx);
  await scheduleReviewEnd(deps, record, now.toISOString());
  return (await processAccepted(deps, access.league, record, now)).record;
}

export const respondToTrade = defineOperation({
  name: 'respond_to_trade',
  method: 'POST',
  path: '/leagues/{leagueId}/trades/{tradeId}/respond',
  summary: 'Accept or reject a trade offer made to your team',
  description: [
    '`response: "accept"` or `"reject"` for an offer made to your team (direction `incoming` in list_trades). To propose different terms, use counter_trade instead.',
    'Accepting re-checks the trade. If your roster would be over the limit, pass `drops` (ids or names; preview_trade lists `dropCandidates`), or it fails with ROSTER_LIMIT_EXCEEDED.',
    'An accepted trade goes to league review for the review period (other teams can vote to veto with vote_trade) and then processes; in a league without review it processes at once.',
    'Errors: TRADE_EXPIRED, NOT_YOUR_TRADE_ACTION (only the team the offer was made to responds), ILLEGAL_TRADE_TRANSITION (already answered), PLAYER_NOT_ON_ROSTER, PLAYER_LOCKED, TRADE_DEADLINE_PASSED.'
  ].join(' '),
  tags: ['trades'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    tradeId: TradeIdField,
    teamId: TeamIdField,
    response: z.enum(['accept', 'reject']),
    drops: playersField('Accepting only: your players to release so your roster fits (ids or names).'),
    message: MessageField
  }),
  output: Output,
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const { league } = access;
    const record = await loadTrade(ctx, access, input.tradeId);
    const me = actingTeam(access, input.teamId);
    assertAction('respond_to_trade', league, access.actor, now);
    // The answer's note is kept apart from the offer's, which stays as the proposer wrote it.
    const noted = input.message === undefined ? record : { ...record, reply: input.message };
    if (input.response === 'reject') {
      const rejected = rejectTrade(record.trade, me.id, now.toISOString());
      if (!rejected.ok) throw tradeError(rejected.issues);
      const saved = await save(ctx, noted, rejected.trade, now);
      await publishTradeEvent(tradeDepsOf(ctx), 'Trade Rejected', league, saved);
      return view(ctx, access, saved, now);
    }
    const world = await loadTradeWorld(tradeDepsOf(ctx), league, now, access.teams);
    const drops = input.drops.length === 0 ? undefined : await resolvePlayers(ctx, world, me, input.drops);
    const accepted = acceptTrade(
      league.settings,
      record.trade,
      { byTeamId: me.id, ...(drops === undefined ? {} : { drops }) },
      world.context
    );
    if (!accepted.ok) throw tradeError(accepted.issues);
    let trade = accepted.trade;
    if (league.settings.trades.review !== 'none') {
      const review = startReview(league.settings, trade, now.toISOString());
      if (review.ok) trade = review.trade;
    }
    const saved = await save(ctx, noted, trade, now);
    return view(ctx, access, await afterAcceptance(ctx, access, saved, now), now);
  }
});

export const withdrawTradeOperation = defineOperation({
  name: 'withdraw_trade',
  method: 'POST',
  path: '/leagues/{leagueId}/trades/{tradeId}/withdraw',
  summary: 'Take back a trade offer your team made',
  description:
    'Withdraws an unanswered offer your team made (direction `outgoing`, status `proposed`). Errors: NOT_YOUR_TRADE_ACTION (only the offering team can withdraw) and ILLEGAL_TRADE_TRANSITION (it was already answered, countered, or expired).',
  tags: ['trades'],
  mutation: true,
  input: z.object({ leagueId: LeagueIdSchema, tradeId: TradeIdField, teamId: TeamIdField }),
  output: Output,
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const record = await loadTrade(ctx, access, input.tradeId);
    const me = actingTeam(access, input.teamId);
    assertAction('withdraw_trade', access.league, access.actor, now);
    const withdrawn = withdrawTrade(record.trade, me.id, now.toISOString());
    if (!withdrawn.ok) throw tradeError(withdrawn.issues);
    const saved = await save(ctx, record, withdrawn.trade, now);
    await publishTradeEvent(tradeDepsOf(ctx), 'Trade Withdrawn', access.league, saved);
    return view(ctx, access, saved, now);
  }
});

export const voteTrade = defineOperation({
  name: 'vote_trade',
  method: 'POST',
  path: '/leagues/{leagueId}/trades/{tradeId}/votes',
  summary: 'Vote to veto an accepted trade under league review',
  description: [
    'Trades other teams accepted are under review for a few days (status `in_review`, see `reviewEndsAt`). In a league-vote league any team not in the trade can vote to veto it once (`decision: "veto"`); when enough teams veto (`vetoVotesRequired`), the trade is cancelled. To let a trade pass, do nothing.',
    'In a commissioner-review league only the commissioner decides: `"approve"` processes it now and `"veto"` cancels it. A trade the commissioner’s own team is part of goes to a league vote instead, so the commissioner never reviews their own trade.',
    'Review continues into the playoffs for trades accepted before the deadline.',
    'Errors: VOTE_NOT_ALLOWED (you are in the trade, already voted, the review is over, or this league does not vote), TRADE_NOT_IN_REVIEW.'
  ].join(' '),
  tags: ['trades'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    tradeId: TradeIdField,
    teamId: TeamIdField,
    decision: z.enum(['veto', 'approve']).default('veto')
  }),
  output: Output,
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const { league } = access;
    const record = await loadTrade(ctx, access, input.tradeId);
    assertAction('vote_trade', league, access.actor, now);
    const deps = tradeDepsOf(ctx);
    const at = now.toISOString();
    const settings = tradeReviewSettings(league, access.teams, record.trade);
    if (settings.trades.review === 'commissioner') {
      if (access.actor.kind !== 'user' || !access.actor.isCommissioner) {
        throw new ApiError('FORBIDDEN', 'Only the commissioner reviews trades in this league.', {
          fix: 'No action needed; the commissioner approves or vetoes accepted trades.'
        });
      }
      const reviewed = commissionerReview(settings, record.trade, input.decision, at);
      if (!reviewed.ok) throw tradeError(reviewed.issues);
      const saved = await save(ctx, record, reviewed.trade, now);
      if (saved.trade.status === 'vetoed') {
        await publishTradeEvent(deps, 'Trade Vetoed', league, saved);
        return view(ctx, access, saved, now);
      }
      return view(ctx, access, await processNow(ctx, access, saved, now), now);
    }
    const isCommissioner = access.actor.kind === 'user' && access.actor.isCommissioner;
    if (input.decision === 'approve' && league.settings.trades.review === 'commissioner' && isCommissioner) {
      throw new ApiError(
        'VOTE_NOT_ALLOWED',
        'Your own team is in this trade, so the league reviews it by vote instead of the commissioner.',
        {
          fix: 'No action needed: the trade processes when the review ends unless enough other teams vote to veto it.'
        }
      );
    }
    if (input.decision === 'approve') {
      throw new ApiError('VOTE_NOT_ALLOWED', 'Only veto votes count in a league vote.', {
        fix: 'To let the trade pass, do nothing; it processes when the review ends. Send decision "veto" to vote against it.'
      });
    }
    const me = actingTeam(access, input.teamId);
    const voted = castVetoVote(settings, record.trade, me.id, at);
    if (!voted.ok) throw tradeError(voted.issues);
    const saved = await save(ctx, record, voted.trade, now);
    if (saved.trade.status === 'vetoed') await publishTradeEvent(deps, 'Trade Vetoed', league, saved);
    return view(ctx, access, saved, now);
  }
});
