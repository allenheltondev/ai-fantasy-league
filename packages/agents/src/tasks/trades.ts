import { hashString } from '@fantasy/core';
import type { Envelope } from '@fantasy/server';
import { z } from 'zod';
import { BaseDecisionSchema, defineTaskKind, type TaskContext, type TaskOutcome } from './kinds.js';

/**
 * Trade response task (#66): when an offer or a counter arrives for the agent's team, the agent
 * reads it (list_trades) and the trade value math (preview_trade: best-lineup and player value for
 * both sides over the next few weeks), then accepts, rejects, or counters.
 *
 * The deterministic evaluation is `lineupDelta + valueDelta × (1 - recencyBias)` for the agent's
 * side, blurred by the difficulty's `valuationNoise`. It must clear a bar set by the archetype's
 * `tradeFrequency` (a trade-happy agent accepts small losses; a cautious one wants a clear win).
 * Short of the bar, the agent counters (asking to keep its best player in the deal) if it has
 * negotiation rounds left (the difficulty's `negotiationRounds`, counted over the negotiation's
 * counter chain), and otherwise rejects. The model sees that suggestion and decides; only
 * respond_to_trade and counter_trade execute anything. Without a model the agent rejects.
 */

/** How far below the bar an offer can be and still be worth a counter. */
export const COUNTER_WINDOW = 40;

const PayloadSchema = z.object({ tradeId: z.string(), fromTeamId: z.string().optional() });
type Payload = z.infer<typeof PayloadSchema>;

export const TradeDecisionSchema = BaseDecisionSchema.extend({
  action: z.enum(['accept', 'reject', 'counter']),
  drops: z
    .array(z.string())
    .max(6)
    .optional()
    .describe('Accepting: your players to release so your roster fits.'),
  send: z.array(z.string()).max(6).optional().describe('Countering: your players you would give.'),
  receive: z.array(z.string()).max(6).optional().describe('Countering: their players you want.'),
  message: z.string().max(300).optional().describe('An optional short note to the other manager.')
});
type TradeDecision = z.infer<typeof TradeDecisionSchema>;

const Ref = z.object({ id: z.string(), name: z.string(), position: z.string() });
const TradeSchema = z.object({
  id: z.string(),
  status: z.string(),
  round: z.number(),
  fromTeam: z.object({ id: z.string(), name: z.string() }),
  fromSends: z.array(Ref),
  toSends: z.array(Ref),
  yourActions: z.array(z.string())
});
const SideSchema = z.object({
  team: z.object({ id: z.string() }),
  lineupDelta: z.number(),
  valueDelta: z.number(),
  dropsNeeded: z.number(),
  dropCandidates: z.array(Ref)
});
const PreviewSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ code: z.string(), message: z.string() })),
  sides: z.tuple([SideSchema, SideSchema]),
  players: z.array(z.object({ player: Ref, fromTeamId: z.string(), projectedPoints: z.number() }))
});

export interface TradeSuggestion {
  action: TradeDecision['action'];
  score: number;
  bar: number;
  drops: string[];
  counter: { send: string[]; receive: string[] } | null;
}

interface TradePrep {
  open: boolean;
  trade: z.infer<typeof TradeSchema> | null;
  preview: z.infer<typeof PreviewSchema> | null;
  roundsLeft: number;
  suggestion: TradeSuggestion;
}

function parse<T>(envelope: Envelope, schema: z.ZodType<T>): T | null {
  return 'error' in envelope ? null : schema.parse(envelope.data);
}

/** The bar an offer's score must clear: 5 points for a cautious agent, down to -4 for a trade-happy one. */
export function acceptBar(tradeFrequency: number): number {
  return Math.round((0.5 - tradeFrequency) * 20) / 2;
}

/** Counters this agent already made in the negotiation: every other offer back down the chain. */
export function countersUsed(round: number): number {
  return Math.floor(round / 2);
}

const REJECT: TradeSuggestion = { action: 'reject', score: 0, bar: 0, drops: [], counter: null };

async function prepare(ctx: TaskContext, payload: Payload): Promise<TradePrep> {
  const closed = { open: false, trade: null, preview: null, roundsLeft: 0, suggestion: REJECT };
  const listed = parse(
    await ctx.tools.call('list_trades', { tradeId: payload.tradeId }),
    z.object({ trades: z.array(TradeSchema) })
  );
  const trade = listed?.trades[0];
  if (trade === undefined || !trade.yourActions.includes('accept')) return closed;
  const preview = parse(await ctx.tools.call('preview_trade', { tradeId: trade.id }), PreviewSchema);
  if (preview === null) return { ...closed, open: true, trade };
  const me = preview.sides[1];
  const unit = (hashString(`${ctx.taskId}|${trade.id}`) % 2001) / 1000 - 1;
  const noise = 1 + unit * ctx.config.levers.valuationNoise;
  const score =
    Math.round(
      (me.lineupDelta + me.valueDelta * (1 - (ctx.config.valuation.recencyBias ?? 0))) * noise * 10
    ) / 10;
  const bar = acceptBar(ctx.config.tradeFrequency);
  const roundsLeft = Math.max(0, ctx.config.levers.negotiationRounds - countersUsed(trade.round));
  const drops = me.dropCandidates.slice(0, me.dropsNeeded).map((p) => p.id);
  const suggestion: TradeSuggestion = { action: 'reject', score, bar, drops, counter: null };
  if (preview.valid && score >= bar)
    return { open: true, trade, preview, roundsLeft, suggestion: { ...suggestion, action: 'accept' } };
  // Counter: keep my most valuable player out of the deal when I send more than one.
  const mine = preview.players
    .filter((p) => p.fromTeamId === me.team.id)
    .sort((a, b) => b.projectedPoints - a.projectedPoints);
  if (roundsLeft > 0 && mine.length > 1 && score >= bar - COUNTER_WINDOW) {
    suggestion.action = 'counter';
    suggestion.counter = {
      send: mine.slice(1).map((p) => p.player.id),
      receive: trade.fromSends.map((p) => p.id)
    };
  }
  return { open: true, trade, preview, roundsLeft, suggestion };
}

function names(list: readonly { name: string }[]): string {
  return list.map((p) => p.name).join(', ') || 'nothing';
}

async function respond(
  ctx: TaskContext,
  tradeId: string,
  response: 'accept' | 'reject',
  drops: string[] = [],
  message?: string
): Promise<Envelope> {
  return ctx.tools.call('respond_to_trade', {
    tradeId,
    response,
    ...(drops.length === 0 ? {} : { drops }),
    ...(message === undefined ? {} : { message })
  });
}

function outcome(action: string, summary: string, result: Envelope): TaskOutcome {
  return 'error' in result
    ? { action: `${action}_failed`, summary: `${summary} Refused: ${result.error.code}.` }
    : { action, summary };
}

export const tradeResponseTask = defineTaskKind<Payload, TradeDecision, TradePrep>({
  kind: 'trade_response',
  title: 'Answer a trade offer',
  modelRole: 'decision',
  payload: PayloadSchema,
  decision: TradeDecisionSchema,
  tools: [
    'get_league_state',
    'get_roster',
    'get_player',
    'get_projections',
    'get_news',
    'preview_trade',
    'list_trades'
  ],
  prepare,
  instructions(_ctx, _payload, prep) {
    if (!prep.open || prep.trade === null)
      return 'This offer can no longer be answered. Answer with action "reject" and a short summary.';
    const t = prep.trade;
    const s = prep.suggestion;
    const me = prep.preview?.sides[1];
    return [
      `${t.fromTeam.name} offers you ${names(t.fromSends)} for your ${names(t.toSends)}.`,
      me === undefined
        ? 'The trade preview is unavailable.'
        : `Trade value for you over the next weeks: best lineup ${me.lineupDelta >= 0 ? '+' : ''}${me.lineupDelta} points, player value ${me.valueDelta >= 0 ? '+' : ''}${me.valueDelta}. Your score ${s.score} against your bar ${s.bar}.`,
      prep.preview !== null && !prep.preview.valid
        ? `It is not legal right now: ${prep.preview.issues.map((i) => i.message).join(' ')}`
        : '',
      s.drops.length > 0 ? `Accepting needs drops; suggested: ${s.drops.join(', ')}.` : '',
      `You have ${prep.roundsLeft} counter-offer(s) left in this negotiation.`,
      `Suggested: ${s.action}${s.counter === null ? '' : ` (send ${s.counter.send.join(', ')}; receive ${s.counter.receive.join(', ')})`}.`,
      'Decide with `action` accept, reject, or counter. For counter give `send` (your player ids) and `receive` (theirs). Chat banter does not execute anything.'
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  },
  async apply(ctx, _payload, prep, decision) {
    if (!prep.open || prep.trade === null) return { action: 'none', summary: decision.summary };
    const id = prep.trade.id;
    if (decision.action === 'accept') {
      const result = await respond(
        ctx,
        id,
        'accept',
        decision.drops ?? prep.suggestion.drops,
        decision.message
      );
      return outcome('accept_trade', decision.summary, result);
    }
    if (
      decision.action === 'counter' &&
      prep.roundsLeft > 0 &&
      (decision.send ?? decision.receive) !== undefined
    ) {
      const result = await ctx.tools.call('counter_trade', {
        tradeId: id,
        send: decision.send ?? [],
        receive: decision.receive ?? [],
        ...(decision.message === undefined ? {} : { message: decision.message })
      });
      return outcome('counter_trade', decision.summary, result);
    }
    const out =
      decision.action === 'counter'
        ? `${decision.summary} No counters left, so rejecting.`
        : decision.summary;
    return outcome('reject_trade', out, await respond(ctx, id, 'reject', [], decision.message));
  },
  async fallback(ctx, _payload, prep) {
    if (!prep.open || prep.trade === null) return { action: 'none', summary: 'The offer is no longer open.' };
    return outcome(
      'reject_trade',
      'Rejected the offer without a model decision.',
      await respond(ctx, prep.trade.id, 'reject')
    );
  },
  fakeScript: (_ctx, _payload, prep) => ({
    steps: [],
    decision: {
      summary: `Suggested ${prep.suggestion.action} (score ${prep.suggestion.score}, bar ${prep.suggestion.bar}).`,
      action: prep.suggestion.action,
      ...(prep.suggestion.counter === null ? {} : prep.suggestion.counter)
    }
  })
});
