import { randomUUID } from 'node:crypto';
import { counterTrade, proposeTrade } from '@fantasy/core';
import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import { requireMember, requireTeam } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import type { TradeRecord } from '../../repos/trades.js';
import { publishTradeEvent, scheduleOfferExpiry, tradeError } from '../../trades/lifecycle.js';
import { loadTradeWorld, nextLockAt } from '../../trades/world.js';
import { actingTeam, TeamIdField } from '../waivers/shared.js';
import { buildSides, clampToDeadline, guardLopsided } from './proposal.js';
import {
  loadTrade,
  MessageField,
  playersField,
  TradeIdField,
  tradeDepsOf,
  tradeViews,
  TradeViewSchema
} from './shared.js';

const sidesShape = {
  send: playersField('Your players to send (ids or names).'),
  receive: playersField('Their players you want (ids or names).'),
  drops: playersField(
    'Your players to release if your roster would be over the limit after the trade (ids or names).'
  ),
  message: MessageField
};

const ERRORS =
  'Errors carry a fix: PLAYER_NOT_ON_ROSTER (re-read both rosters), ROSTER_LIMIT_EXCEEDED (add `drops`), PLAYER_LOCKED (his game has kicked off this week), TRADE_DEADLINE_PASSED (trades are closed), TRADE_LOPSIDED (two AI teams, too one-sided), TRADE_INVALID (see details.issues).';

export const proposeTradeOperation = defineOperation({
  name: 'propose_trade',
  method: 'POST',
  path: '/leagues/{leagueId}/trades',
  summary: 'Offer a trade to another team',
  description: [
    'Creates a trade offer from your team to `withTeamId`: you `send` some of your players and `receive` some of theirs (ids or names). Only the two teams see a pending offer.',
    'The other team can accept, reject, or counter. The offer expires after the league’s offer window (48 hours by default) or at the next lineup lock, whichever comes first. If the other team would end up over the roster limit, it picks its drops when accepting (warning RESPONDER_MUST_DROP).',
    'Call preview_trade first to check legality and fairness.',
    ERRORS
  ].join(' '),
  tags: ['trades'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdField,
    withTeamId: z.string().min(1).max(64).describe('The team you are offering the trade to.'),
    ...sidesShape
  }),
  output: z.object({ trade: TradeViewSchema }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const { league } = access;
    const me = actingTeam(access, input.teamId);
    assertAction('propose_trade', league, access.actor, now);
    const other = requireTeam(access, input.withTeamId);
    const deps = tradeDepsOf(ctx);
    const world = await loadTradeWorld(deps, league, now, access.teams);
    const sides = await buildSides(ctx, world, me, other, input);
    const result = proposeTrade(
      league.settings,
      { tradeId: randomUUID(), sides, nextLockTime: await nextLockAt(ctx.data.reference, league, now) },
      world.context
    );
    if (!result.ok) throw tradeError(result.issues);
    const trade = clampToDeadline(result.trade, league.deadlines.tradeDeadlineAt);
    await guardLopsided(ctx, world, [me, other], trade);
    const record: TradeRecord = {
      leagueId: league.id,
      trade,
      message: input.message ?? null,
      createdBy: principalKey(ctx.principal),
      processingAt: null,
      updatedAt: now.toISOString(),
      version: 1
    };
    await ctx.repos.trades.create(record);
    await scheduleOfferExpiry(deps, record);
    await publishTradeEvent(deps, 'Trade Proposed', league, record);
    const [view] = await tradeViews(ctx, access, [record], now);
    return withWarnings(
      { trade: view as z.infer<typeof TradeViewSchema> },
      result.warnings.map((w) => ({ code: w.code, message: `${w.message} ${w.fix}` }))
    );
  }
});

export const counterTradeOperation = defineOperation({
  name: 'counter_trade',
  method: 'POST',
  path: '/leagues/{leagueId}/trades/{tradeId}/counter',
  summary: 'Answer a trade offer with a different offer',
  description: [
    'Counters an offer made to your team: the original closes as `countered` and your counter goes back to the team that offered, as a new offer they can accept, reject, or counter again.',
    '`send` is what you give, `receive` is what you want from them (ids or names). Only the team the offer was made to can counter, and only before it expires.',
    'The counter keeps the negotiation history in `counterChain`. AI managers have a limited number of counters per negotiation (their difficulty).',
    ERRORS
  ].join(' '),
  tags: ['trades'],
  mutation: true,
  input: z.object({ leagueId: LeagueIdSchema, tradeId: TradeIdField, teamId: TeamIdField, ...sidesShape }),
  output: z.object({
    trade: TradeViewSchema.describe('Your counter offer.'),
    countered: TradeViewSchema.describe('The offer you countered (now closed).')
  }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const { league } = access;
    const record = await loadTrade(ctx, access, input.tradeId);
    const me = actingTeam(access, input.teamId);
    assertAction('counter_trade', league, access.actor, now);
    const deps = tradeDepsOf(ctx);
    const world = await loadTradeWorld(deps, league, now, access.teams);
    const other = requireTeam(access, record.trade.sides[0].teamId);
    const sides = await buildSides(ctx, world, me, other, input);
    const result = counterTrade(
      league.settings,
      record.trade,
      {
        tradeId: randomUUID(),
        byTeamId: me.id,
        sides,
        nextLockTime: await nextLockAt(ctx.data.reference, league, now)
      },
      world.context
    );
    if (!result.ok) throw tradeError(result.issues);
    const trade = clampToDeadline(result.counter, league.deadlines.tradeDeadlineAt);
    await guardLopsided(ctx, world, [me, other], trade);
    const closed = await ctx.repos.trades.update({
      ...record,
      trade: result.original,
      updatedAt: now.toISOString()
    });
    const counter: TradeRecord = {
      leagueId: league.id,
      trade,
      message: input.message ?? null,
      createdBy: principalKey(ctx.principal),
      processingAt: null,
      updatedAt: now.toISOString(),
      version: 1
    };
    await ctx.repos.trades.create(counter);
    await scheduleOfferExpiry(deps, counter);
    await publishTradeEvent(deps, 'Trade Countered', league, counter);
    const [view, original] = await tradeViews(ctx, access, [counter, closed], now);
    return withWarnings(
      {
        trade: view as z.infer<typeof TradeViewSchema>,
        countered: original as z.infer<typeof TradeViewSchema>
      },
      result.warnings.map((w) => ({ code: w.code, message: `${w.message} ${w.fix}` }))
    );
  }
});
