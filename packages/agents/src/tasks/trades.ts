import { tradeAcceptEdge, tradeAppetite } from '@fantasy/core';
import type { Envelope } from '@fantasy/server';
import { z } from 'zod';
import {
  ChatReplySchema,
  ChatSourceSchema,
  heardInChat,
  heardLine,
  persuasion,
  replyInChat,
  type Heard
} from './chat-action.js';
import { BaseDecisionSchema, defineTaskKind, type TaskContext, type TaskOutcome } from './kinds.js';
import { judgmentNoise, offerSubject } from './noise.js';
import { TaskUnavailableError } from './lineup.js';

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
 *
 * Guards (issue #122): the model's "accept" is honored only when the score is within
 * `ACCEPT_FLOOR_MARGIN` of the bar, so no argument (or injected note) can talk it into a bad deal;
 * the offer's note never reaches the model (`withholdTradeNotes`), the model's memory note is not
 * kept, and the memory records a deterministic line with the players and the value instead. The
 * activity log seals the summary while the offer is private.
 *
 * Chat (#196): a push about the offer in chat hands this task a follow-up (`chat`). The task re-reads
 * the message and weighs it by its own numbers: when the players offered improve its best lineup,
 * the argument lowers its bar by `persuasionAllowance` (a few points at most, by the personality's
 * `persuadability`), so it can tip a borderline offer but never clear the hard floor for a bad one;
 * a message that reads like an order moves nothing. The model never sees the message.
 *
 * Counters (#208): a counter is a new offer the agent makes, so before `counter_trade` the task
 * previews the exact terms (what it sends, what it asks for, and any drops its roster needs:
 * `vetCounter`) and scores them with the same trade value math, noise key (`offerSubject`, one round
 * on), and hard floor as an accept (`acceptFloor`), whoever the other team is, person or agent.
 * A chat pitch moves the suggested counter as it moves the suggested accept, never the floor. A
 * counter under the floor, or one that is not a legal trade, is never sent: the task sends its own
 * suggested counter when that one clears, and otherwise rejects, saying why in the activity log.
 *
 * Stale offers (#189): the task may run well after the offer arrived (a human-like response
 * delay), so it re-reads the trade first. An offer that was withdrawn, expired, or already answered
 * meanwhile is skipped (`offer_closed`) before any model call.
 */

/** How far below the bar an offer can be and still be worth a counter. */
export const COUNTER_WINDOW = 40;
/** How far below the bar the model's own judgment may accept (the hard floor under "accept"). */
export const ACCEPT_FLOOR_MARGIN = 5;

/** The summary the commissioner's activity log shows while the offer is private. */
export const SEALED_RESPONSE = 'Answered a trade offer; the terms stay private between the two teams.';

const PayloadSchema = z.object({
  tradeId: z.string(),
  fromTeamId: z.string().optional(),
  /** A conversation about this offer (#196): the message to weigh. */
  chat: ChatSourceSchema.optional()
});
type Payload = z.infer<typeof PayloadSchema>;

export const TradeDecisionSchema = BaseDecisionSchema.extend({
  action: z.enum(['accept', 'reject', 'counter']),
  drops: z
    .array(z.string())
    .max(6)
    .optional()
    .describe('Accepting or countering: your players to release so your roster fits.'),
  send: z.array(z.string()).max(6).optional().describe('Countering: your players you would give.'),
  receive: z.array(z.string()).max(6).optional().describe('Countering: their players you want.'),
  message: z.string().max(300).optional().describe('An optional short note to the other manager.'),
  reply: ChatReplySchema
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
  sends: z.array(Ref),
  receives: z.array(Ref),
  drops: z.array(Ref),
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
  /** How far a conversation moved the bar (#196); the hard floor stays at `bar`. */
  credit?: number;
  drops: string[];
  counter: { send: string[]; receive: string[] } | null;
}

interface TradePrep {
  trade: z.infer<typeof TradeSchema>;
  preview: z.infer<typeof PreviewSchema> | null;
  roundsLeft: number;
  suggestion: TradeSuggestion;
  /** The conversation that pushed for it (#196). */
  heard?: Heard;
}

function parse<T>(envelope: Envelope, schema: z.ZodType<T>): T | null {
  return 'error' in envelope ? null : schema.parse(envelope.data);
}

/** The bar an offer's score must clear: 5 points for a cautious agent, down to -4 for a trade-happy one. */
export function acceptBar(tradeFrequency: number): number {
  return tradeAcceptEdge(tradeFrequency);
}

/** Counters this agent already made in the negotiation: every other offer back down the chain. */
export function countersUsed(round: number): number {
  return Math.floor(round / 2);
}

/**
 * The agent's score for its side of a trade: `lineupDelta + valueDelta × (1 - recencyBias)`, times
 * the difficulty's valuation noise. The noise is keyed by what the offer is (teams, players, round),
 * never an id, so the same terms replay the same (noise.ts).
 */
export function tradeScore(
  ctx: Pick<TaskContext, 'config' | 'seat' | 'league'>,
  side: { lineupDelta: number; valueDelta: number },
  offer: Parameters<typeof offerSubject>[0]
): number {
  const noise = judgmentNoise(ctx, ...offerSubject(offer));
  const recency = ctx.config.valuation.recencyBias ?? 0;
  return Math.round((side.lineupDelta + side.valueDelta * (1 - recency)) * noise * 10) / 10;
}

const REJECT: TradeSuggestion = { action: 'reject', score: 0, bar: 0, drops: [], counter: null };

async function prepare(ctx: TaskContext, payload: Payload): Promise<TradePrep> {
  const listed = parse(
    await ctx.tools.call('list_trades', { tradeId: payload.tradeId }),
    z.object({ trades: z.array(TradeSchema) })
  );
  const trade = listed?.trades[0];
  if (trade === undefined || !trade.yourActions.includes('accept'))
    throw new TaskUnavailableError('offer_closed');
  const preview = parse(await ctx.tools.call('preview_trade', { tradeId: trade.id }), PreviewSchema);
  if (preview === null) return { trade, preview: null, roundsLeft: 0, suggestion: REJECT };
  const me = preview.sides[1];
  const score = tradeScore(ctx, me, {
    fromTeamId: trade.fromTeam.id,
    toTeamId: ctx.principal.teamId,
    fromSends: trade.fromSends.map((p) => p.id),
    toSends: trade.toSends.map((p) => p.id),
    round: trade.round
  });
  // The archetype's trade appetite (core behavior.ts) sets the bar and the counter budget.
  const appetite = tradeAppetite(ctx.config);
  const bar = appetite.acceptEdge;
  const roundsLeft = Math.max(0, appetite.maxCounters - countersUsed(trade.round));
  const drops = me.dropCandidates.slice(0, me.dropsNeeded).map((p) => p.id);
  // A pitch in chat: its argument holds up when the players offered improve my best lineup.
  const heard = payload.chat === undefined ? undefined : await heardInChat(ctx, payload.chat);
  const credit = heard === undefined ? 0 : persuasion(ctx, heard, me.lineupDelta > 0);
  const suggestion: TradeSuggestion = {
    action: 'reject',
    score,
    bar,
    drops,
    counter: null,
    ...(heard === undefined ? {} : { credit })
  };
  const extra = heard === undefined ? {} : { heard };
  if (preview.valid && score >= bar - credit)
    return { trade, preview, roundsLeft, suggestion: { ...suggestion, action: 'accept' }, ...extra };
  // Counter: keep my most valuable player out of the deal when I send more than one.
  const mine = preview.players
    .filter((p) => p.fromTeamId === me.team.id)
    .sort((a, b) => b.projectedPoints - a.projectedPoints);
  if (roundsLeft > 0 && mine.length > 1 && score >= bar - credit - COUNTER_WINDOW) {
    suggestion.action = 'counter';
    suggestion.counter = {
      send: mine.slice(1).map((p) => p.player.id),
      receive: trade.fromSends.map((p) => p.id)
    };
  }
  return { trade, preview, roundsLeft, suggestion, ...extra };
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

/**
 * True when an accept clears the hard floor: the trade value math must be within reach of the bar.
 * After a chat message that tried to give orders (#196), the model gets no leeway at all: only what
 * clears the bar by the numbers may be accepted.
 */
export function acceptAllowed(prep: Pick<TradePrep, 'preview' | 'suggestion' | 'heard'>): boolean {
  return prep.preview !== null && prep.suggestion.score >= acceptFloor(prep);
}

export function acceptFloor(prep: Pick<TradePrep, 'suggestion' | 'heard'>): number {
  return prep.suggestion.bar - (prep.heard?.instructions === true ? 0 : ACCEPT_FLOOR_MARGIN);
}

const VERB = { accept_trade: 'Accepted', reject_trade: 'Rejected', counter_trade: 'Countered' } as const;

/**
 * The result of answering an offer: the model's summary for the activity log (sealed while the
 * offer is private), and for memory a deterministic line with the players and the value, never the
 * model's words (they were written after reading the other team's offer).
 */
function outcome(
  ctx: TaskContext,
  action: keyof typeof VERB,
  summary: string,
  result: Envelope,
  prep: TradePrep,
  sentBack?: CounterCheck
): TaskOutcome {
  const trade = prep.trade;
  const failed = 'error' in result;
  const sent = trade.toSends.map((p) => p.name);
  const received = trade.fromSends.map((p) => p.name);
  const value = prep.preview === null ? undefined : prep.suggestion.score;
  const sentLine =
    sentBack === undefined
      ? ''
      : ` Asked instead for ${names(sentBack.receive)} for your ${names(sentBack.send)}${sentBack.drops.length === 0 ? '' : `, releasing ${names(sentBack.drops)}`} (value for you ${sentBack.score}).`;
  const line = `${VERB[action]} ${trade.fromTeam.id}'s offer: ${names(trade.fromSends)} for your ${names(trade.toSends)}${value === undefined ? '' : ` (value for you ${value}, bar ${prep.suggestion.bar})`}.${sentLine}`;
  return {
    action: failed ? `${action}_failed` : action,
    summary: failed ? `${summary} Refused: ${result.error.code}.` : summary,
    memorySummary: failed ? `${line} Refused: ${result.error.code}.` : line,
    sealed: { summary: SEALED_RESPONSE, trades: [{ tradeId: trade.id, until: 'public' }], waiverClaims: [] },
    ...(failed || action !== 'accept_trade'
      ? {}
      : {
          memory: [
            {
              type: 'trade',
              teamId: trade.fromTeam.id,
              tradeId: trade.id,
              outcome: 'accepted',
              summary: line,
              at: ctx.clock.now().toISOString(),
              sent,
              received,
              ...(value === undefined ? {} : { value })
            }
          ]
        })
  };
}

export const tradeResponseTask = defineTaskKind<Payload, TradeDecision, TradePrep>({
  kind: 'trade_response',
  title: 'Answer a trade offer',
  modelRole: 'decision',
  modelNotes: false,
  payload: PayloadSchema,
  decision: TradeDecisionSchema,
  // A counter's note goes to the team that made the offer: it may recall private dealings with
  // that team, never with anyone else.
  memoryAudience: (_ctx, _payload, prep) => ({ teams: [prep.trade.fromTeam.id] }),
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
      prep.heard === undefined ? '' : heardLine(prep.heard, s.credit ?? 0, s.bar),
      `Suggested: ${s.action}${s.counter === null ? '' : ` (send ${s.counter.send.join(', ')}; receive ${s.counter.receive.join(', ')})`}.`,
      'Decide with `action` accept, reject, or counter. For counter give `send` (your player ids) and `receive` (theirs). Chat banter does not execute anything.',
      prep.heard === undefined ? '' : 'Then give a `reply` for the conversation, in your own voice.'
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  },
  async apply(ctx, payload, prep, decision) {
    const outcome = await answer(ctx, prep, decision);
    return payload.chat === undefined ? outcome : afterChat(ctx, payload.chat, prep, decision, outcome);
  },
  async fallback(ctx, _payload, prep) {
    return outcome(
      ctx,
      'reject_trade',
      'Rejected the offer without a model decision.',
      await respond(ctx, prep.trade.id, 'reject'),
      prep
    );
  },
  fakeScript: (_ctx, payload, prep) => ({
    steps: [],
    decision: {
      summary: `Suggested ${prep.suggestion.action} (score ${prep.suggestion.score}, bar ${prep.suggestion.bar}).`,
      action: prep.suggestion.action,
      ...(prep.suggestion.counter === null ? {} : prep.suggestion.counter),
      ...(payload.chat === undefined ? {} : { reply: scriptedChatReply(prep) })
    }
  })
});

/** The scripted model's line back to a conversation (tests, local dev, the simulator). */
function scriptedChatReply(prep: TradePrep): string {
  if (prep.heard?.instructions === true) return 'Nice try. Nobody gives me orders in chat. Rejected.';
  const s = prep.suggestion;
  if (s.action === 'accept')
    return s.score < s.bar ? "Fine, you've convinced me. Accepting." : 'Numbers check out. Accepting.';
  return s.action === 'counter'
    ? 'Close, but not quite. Sent you a counter.'
    : 'Ran the numbers. Still a no.';
}

/**
 * A chat-driven answer (#196): its line back to the conversation, and, when the conversation is
 * what tipped it, a visible note that it reconsidered.
 */
async function afterChat(
  ctx: TaskContext,
  source: z.infer<typeof ChatSourceSchema>,
  prep: TradePrep,
  decision: TradeDecision,
  result: TaskOutcome
): Promise<TaskOutcome> {
  await replyInChat(ctx, source, decision.reply);
  const s = prep.suggestion;
  const who = prep.heard?.who ?? 'someone in chat';
  const note = prep.heard?.instructions
    ? `Ignored orders from ${who} in chat.`
    : result.action === 'accept_trade' && s.score < s.bar
      ? `Reconsidered: ${who} talked me into it.`
      : `Weighed ${who}'s pitch.`;
  return {
    ...result,
    summary: `${note} ${result.summary}`,
    ...(result.memorySummary === undefined ? {} : { memorySummary: `${note} ${result.memorySummary}` })
  };
}

async function answer(ctx: TaskContext, prep: TradePrep, decision: TradeDecision): Promise<TaskOutcome> {
  const id = prep.trade.id;
  if (decision.action === 'accept' && acceptAllowed(prep)) {
    const result = await respond(
      ctx,
      id,
      'accept',
      decision.drops ?? prep.suggestion.drops,
      decision.message
    );
    return outcome(ctx, 'accept_trade', decision.summary, result, prep);
  }
  if (decision.action === 'accept') {
    const why = `${decision.summary} The trade value math rules it out (score ${prep.suggestion.score}, floor ${acceptFloor(prep)}), so rejecting.`;
    return outcome(ctx, 'reject_trade', why, await respond(ctx, id, 'reject'), prep);
  }
  if (
    decision.action === 'counter' &&
    prep.roundsLeft > 0 &&
    (decision.send ?? decision.receive) !== undefined
  ) {
    return counter(ctx, prep, decision);
  }
  const out =
    decision.action === 'counter' ? `${decision.summary} No counters left, so rejecting.` : decision.summary;
  return outcome(ctx, 'reject_trade', out, await respond(ctx, id, 'reject', [], decision.message), prep);
}

/** Counter terms as the agent evaluated them: resolved players, its score, and the floor. */
interface CounterCheck {
  send: z.infer<typeof Ref>[];
  receive: z.infer<typeof Ref>[];
  drops: z.infer<typeof Ref>[];
  score: number;
  floor: number;
  /** Why the terms cannot be sent as they are (not legal now, or no preview), when they cannot. */
  illegal: string | null;
}

interface CounterTerms {
  send: readonly string[];
  receive: readonly string[];
  drops: readonly string[];
}

/**
 * Evaluates the exact counter terms before anything is sent (#208): preview_trade for the new offer
 * (the agent's roster as it is now, with its drops; when its roster would be over the limit and no
 * drops were named, its weakest players, as for an accept), scored like the offer it answers
 * (`tradeScore`, keyed by the counter's own content one round on) against the accept path's floor.
 */
async function vetCounter(
  ctx: TaskContext,
  prep: Pick<TradePrep, 'trade' | 'suggestion' | 'heard'>,
  terms: CounterTerms
): Promise<CounterCheck> {
  const look = async (drops: readonly string[]) => {
    const envelope = await ctx.tools.call('preview_trade', {
      withTeamId: prep.trade.fromTeam.id,
      send: [...terms.send],
      receive: [...terms.receive],
      ...(drops.length === 0 ? {} : { drops: [...drops] })
    });
    if ('error' in envelope) return { preview: null, why: envelope.error.message };
    const parsed = PreviewSchema.safeParse(envelope.data);
    return { preview: parsed.data ?? null, why: 'the trade preview was unreadable.' };
  };
  const floor = acceptFloor(prep);
  let seen = await look(terms.drops);
  const over = seen.preview?.sides[0];
  if (seen.preview?.valid === false && terms.drops.length === 0 && over !== undefined && over.dropsNeeded > 0)
    seen = await look(over.dropCandidates.slice(0, over.dropsNeeded).map((p) => p.id));
  const read = seen.preview;
  if (read === null) return { send: [], receive: [], drops: [], score: 0, floor, illegal: seen.why };
  const [me, them] = read.sides;
  const score = tradeScore(ctx, me, {
    fromTeamId: me.team.id,
    toTeamId: them.team.id,
    fromSends: me.sends.map((p) => p.id),
    toSends: me.receives.map((p) => p.id),
    round: prep.trade.round + 1
  });
  return {
    send: me.sends,
    receive: me.receives,
    drops: me.drops,
    score,
    floor,
    illegal: read.valid ? null : read.issues.map((i) => i.message).join(' ') || 'it is not legal right now.'
  };
}

const passes = (check: CounterCheck) => check.illegal === null && check.score >= check.floor;

const sameTerms = (a: Omit<CounterTerms, 'drops'>, b: Omit<CounterTerms, 'drops'>) =>
  (['send', 'receive'] as const).every((k) => [...a[k]].sort().join() === [...b[k]].sort().join());

/**
 * Sends a counter only when its exact terms clear the floor (#208). Otherwise the model's terms (and
 * its note, written for them) are dropped: the task's own suggested counter goes when it clears,
 * and the agent rejects when nothing does, with the numbers in the activity log.
 */
async function counter(ctx: TaskContext, prep: TradePrep, decision: TradeDecision): Promise<TaskOutcome> {
  const id = prep.trade.id;
  const proposed: CounterTerms = {
    send: decision.send ?? [],
    receive: decision.receive ?? [],
    drops: decision.drops ?? []
  };
  const check = await vetCounter(ctx, prep, proposed);
  if (passes(check)) return sendCounter(ctx, prep, check, decision.summary, decision.message);
  const why =
    check.illegal === null
      ? `That counter would cost me too much by the trade value math (score ${check.score}, floor ${check.floor}),`
      : `Those counter terms are not a legal trade right now (${check.illegal.trim()}),`;
  const own = prep.suggestion.counter;
  if (own !== null && !sameTerms(own, proposed)) {
    const mine = await vetCounter(ctx, prep, { ...own, drops: [] });
    if (passes(mine)) {
      const summary = `${decision.summary} ${why} so I sent my own counter: ${names(mine.receive)} for my ${names(mine.send)} (score ${mine.score}).`;
      return sendCounter(ctx, prep, mine, summary);
    }
  }
  const summary = `${decision.summary} ${why} so rejecting.`;
  return outcome(ctx, 'reject_trade', summary, await respond(ctx, id, 'reject'), prep);
}

async function sendCounter(
  ctx: TaskContext,
  prep: TradePrep,
  check: CounterCheck,
  summary: string,
  message?: string
): Promise<TaskOutcome> {
  const result = await ctx.tools.call('counter_trade', {
    tradeId: prep.trade.id,
    send: check.send.map((p) => p.id),
    receive: check.receive.map((p) => p.id),
    ...(check.drops.length === 0 ? {} : { drops: check.drops.map((p) => p.id) }),
    ...(message === undefined ? {} : { message })
  });
  return outcome(ctx, 'counter_trade', summary, result, prep, check);
}
