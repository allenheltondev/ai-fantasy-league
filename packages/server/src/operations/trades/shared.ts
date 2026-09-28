import { TRADE_STATUSES, vetoVotesRequired, type Trade } from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import type { LeagueAccess } from '../../league/access.js';
import { actorTeam } from '../../league/phase.js';
import { PlayerRefSchema, type PlayerRef } from '../../players/model.js';
import type { Team } from '../../repos/types.js';
import type { TradeRecord } from '../../repos/trades.js';
import { refsFor, tradePlayerIds } from '../../trades/lifecycle.js';
import type { TradeDeps, TradeWorld } from '../../trades/world.js';
import { refOf } from '../waivers/shared.js';

export const TradeIdField = z
  .string()
  .min(1)
  .max(64)
  .describe('The trade id (from list_trades or a trade event).');

export function playersField(description: string) {
  return z.array(z.string().min(1).max(80)).max(12).default([]).describe(description);
}

export const MessageField = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .optional()
  .describe('An optional note to the other team, shown with the offer (only the two teams see it).');

export const TRADE_ACTIONS = ['accept', 'reject', 'counter', 'withdraw', 'vote', 'approve'] as const;
export const PUBLIC_STATUSES: ReadonlySet<string> = new Set(['accepted', 'in_review', 'processed', 'vetoed']);

const TeamRefSchema = z.object({ id: z.string(), name: z.string() });
const IssueSchema = z.object({ code: z.string(), message: z.string(), fix: z.string() });

export const TradeViewSchema = z.object({
  id: z.string(),
  status: z.enum(TRADE_STATUSES),
  fromTeam: TeamRefSchema.describe('The team that made this offer.'),
  toTeam: TeamRefSchema.describe('The team that must answer it.'),
  fromSends: z.array(PlayerRefSchema).describe('Players fromTeam gives up.'),
  toSends: z.array(PlayerRefSchema).describe('Players toTeam gives up.'),
  fromDrops: z.array(PlayerRefSchema).describe('Players fromTeam releases to make room.'),
  toDrops: z.array(PlayerRefSchema).describe('Players toTeam releases to make room (chosen when accepting).'),
  message: z.string().nullable(),
  proposedAt: z.string(),
  expiresAt: z.string().describe('When an unanswered offer expires (48h or the next lineup lock).'),
  reviewEndsAt: z.string().nullable().describe('When league review ends and the trade processes.'),
  counterOf: z.string().nullable().describe('The offer this one counters.'),
  counterChain: z.array(z.string()).describe('Earlier offers in this negotiation, oldest first.'),
  round: z.number().int().describe('0 for an opening offer, 1 for the first counter, and so on.'),
  vetoVotes: z.number().int(),
  vetoVotesRequired: z.number().int(),
  youVotedToVeto: z.boolean(),
  voidReason: IssueSchema.nullable().describe('Why the trade was cancelled when it no longer worked.'),
  history: z.array(
    z.object({ status: z.enum(TRADE_STATUSES), at: z.string(), byTeamId: z.string().nullable() })
  ),
  direction: z
    .enum(['incoming', 'outgoing', 'league'])
    .describe('incoming: you must answer it; outgoing: your team made it; league: other teams’ trade.'),
  yourActions: z
    .array(z.enum(TRADE_ACTIONS))
    .describe(
      'What you can do now: accept/reject/counter (respond_to_trade, counter_trade), withdraw (withdraw_trade), vote (vote_trade with decision "veto"), approve (commissioner review: vote_trade with decision "approve").'
    )
});
export type TradeView = z.infer<typeof TradeViewSchema>;

export function tradeDepsOf(ctx: Ctx): TradeDeps {
  return { repos: ctx.repos, reference: ctx.data.reference, events: ctx.events, log: ctx.log };
}

/** Pending offers are private to the two teams; accepted and later trades are public for review. */
export function canSee(record: TradeRecord, team: Team | null): boolean {
  if (PUBLIC_STATUSES.has(record.trade.status)) return true;
  return team !== null && record.trade.sides.some((s) => s.teamId === team.id);
}

export async function loadTrade(ctx: Ctx, access: LeagueAccess, tradeId: string): Promise<TradeRecord> {
  const record = await ctx.repos.trades.get(access.league.id, tradeId);
  if (record === null || !canSee(record, actorTeam(access.actor))) {
    throw new ApiError('TRADE_NOT_FOUND', `No trade "${tradeId}" that you can see in this league.`, {
      fix: 'Call list_trades to see your offers and the trades under review, then use one of their ids.',
      details: { tradeId }
    });
  }
  return record;
}

function actionsFor(access: LeagueAccess, trade: Trade, now: Date): TradeView['yourActions'] {
  const team = actorTeam(access.actor);
  const { review } = access.league.settings.trades;
  if (trade.status === 'proposed' && now.toISOString() < trade.expiresAt) {
    if (team?.id === trade.sides[1].teamId) return ['accept', 'reject', 'counter'];
    if (team?.id === trade.sides[0].teamId) return ['withdraw'];
  }
  if (trade.status === 'in_review') {
    const open = trade.reviewEndsAt === null || now.toISOString() < trade.reviewEndsAt;
    const party = trade.sides.some((s) => s.teamId === team?.id);
    if (review === 'league_vote' && open && team !== null && !party && !trade.vetoVotes.includes(team.id))
      return ['vote'];
    if (review === 'commissioner' && access.actor.kind === 'user' && access.actor.isCommissioner)
      return ['approve', 'vote'];
  }
  return [];
}

export async function tradeViews(
  ctx: Ctx,
  access: LeagueAccess,
  records: readonly TradeRecord[],
  now: Date
): Promise<TradeView[]> {
  const refs = await refsFor(
    ctx.repos,
    records.flatMap((r) => tradePlayerIds(r.trade))
  );
  const team = actorTeam(access.actor);
  const name = (id: string) => ({ id, name: access.teams.find((t) => t.id === id)?.name ?? id });
  const list = (ids: readonly string[]): PlayerRef[] => ids.map((id) => refOf(refs, id));
  return records.map(({ trade, message }) => {
    const [from, to] = trade.sides;
    return {
      id: trade.tradeId,
      status: trade.status,
      fromTeam: name(from.teamId),
      toTeam: name(to.teamId),
      fromSends: list(from.sends),
      toSends: list(to.sends),
      fromDrops: list(from.drops),
      toDrops: list(to.drops),
      message,
      proposedAt: trade.proposedAt,
      expiresAt: trade.expiresAt,
      reviewEndsAt: trade.reviewEndsAt,
      counterOf: trade.counterOf,
      counterChain: [...trade.counterChain],
      round: trade.counterChain.length,
      vetoVotes: trade.vetoVotes.length,
      vetoVotesRequired: vetoVotesRequired(access.league.settings),
      youVotedToVeto: team !== null && trade.vetoVotes.includes(team.id),
      voidReason:
        trade.voidReason === null
          ? null
          : { code: trade.voidReason.code, message: trade.voidReason.message, fix: trade.voidReason.fix },
      history: trade.history.map((h) => ({ ...h })),
      direction: to.teamId === team?.id ? 'incoming' : from.teamId === team?.id ? 'outgoing' : 'league',
      yourActions: actionsFor(access, trade, now)
    };
  });
}

/**
 * Resolves players named for one side of a trade to ids: an id on the team's roster, a name that
 * matches one of the team's players, or else any player the directory resolves (validation then
 * says he is not on that roster, with a fix).
 */
export async function resolvePlayers(
  ctx: Ctx,
  world: TradeWorld,
  team: Team,
  tokens: readonly string[]
): Promise<string[]> {
  const ids: string[] = [];
  for (const token of tokens) {
    if (team.roster.includes(token)) {
      ids.push(token);
      continue;
    }
    const needle = token.trim().toLowerCase();
    const onRoster = team.roster.filter((id) => world.players.get(id)?.name.toLowerCase().includes(needle));
    if (onRoster.length === 1) {
      ids.push(onRoster[0] as string);
      continue;
    }
    const known = await ctx.repos.players.get(token);
    ids.push(known?.id ?? (await ctx.data.players.resolve({ player: token })).id);
  }
  return ids;
}
