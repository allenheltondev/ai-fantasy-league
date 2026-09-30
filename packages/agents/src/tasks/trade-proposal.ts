import {
  agendaPriority,
  attachmentAdjustment,
  attachmentPrompt,
  attachmentSummary,
  dmRoomId,
  reasonLine,
  tradeAppetite,
  type AttachmentAdjustment,
  type Commitment,
  type CommitmentFacts,
  type CommitmentReason,
  type MemoryEvent,
  type RosterSlot
} from '@fantasy/core';
import type { Envelope } from '@fantasy/server';
import { z } from 'zod';
import { effectiveBehavior } from '../situation.js';
import {
  CommitmentRefSchema,
  beginLook,
  closeLook,
  failureLines,
  refusalLines,
  type CommitmentRef
} from '../commitments.js';
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
 * Trade proposal task (issue #66): once a week, when the league rolls over, an agent with a trade
 * appetite looks for trades that help its roster and offers them on its own.
 *
 * - Cadence: at most `tradeAppetite(config).proposalsPerWeek` offers a week (0 for an archetype
 *   that only answers offers), and never more than the difficulty's `actionsPerTrigger`. The router
 *   fires the task once per league week (`Week Rolled Over`), behind the per-kind cooldown.
 * - Search (deterministic): one-for-one swaps of a bench player at a position the agent is deep at
 *   for another team's player who beats the agent's weakest starter at his position, and who the
 *   other team can spare (its own weakest starter there is worse than what it gets). The most
 *   promising few go through preview_trade, the same trade value math the trade screen shows; an
 *   offer must be legal, not lopsided, clear the agent's own accept bar by the value math (blurred
 *   by the difficulty's `valuationNoise`), and not insult the other side.
 * - The model sees the candidates and picks which to send (by number), with an optional note. It
 *   cannot change the players: only the vetted offers can be proposed, through propose_trade.
 * - Right after the draft, a high-appetite archetype takes one early look (`draft_complete`, a
 *   follow-up of the post-draft kickoff, #175): at most `EARLY_LOOK_OFFERS` offer.
 * - No model (kill switch, budget, every model unavailable): no proposals.
 * - The trade deadline and the season phase close it (`allowedActions` lacks propose_trade), and
 *   a team that already has an offer pending from this agent is not offered another.
 *
 * - A pitch in chat (#196, `reason: 'chat'`, a chat reply's follow-up): the one swap that was talked
 *   about (`withTeamId`, `send`, `receive`), through the same preview and value math. The pitch's
 *   argument holds up when the players it brings improve the agent's best lineup; then it lowers the
 *   bar by `persuasionAllowance`. A lopsided or illegal swap is never offered, whatever was said,
 *   and a message that reads like an order moves nothing. The model never sees the message.
 *
 * - Attachments (#216): an idea that sends a player the agent is attached to must clear its bar plus
 *   a small, capped premium (core `attachmentAdjustment`; set aside when the player received
 *   repairs an active agenda need), and so must a chat pitch for him. The prompt names attachments
 *   among the candidates (public evidence), never the premium.
 *
 * Proposals are private to the two teams, so the activity log seals the summary until a trade
 * becomes public.
 */

/** How many swap ideas get the full trade value math (each is one preview_trade call). */
export const CANDIDATES_TO_PREVIEW = 5;
/** Ideas per partner team, so the previews spread over the league. */
const PER_TEAM = 2;
/** The least an offer must gain the agent by the trade value math. */
export const MIN_PROPOSAL_GAIN = 1;
/** The most an offer may cost the other team: agents do not send insulting offers. */
export const PARTNER_FLOOR = -8;
/** Positions worth trading for (kickers and defenses come off waivers). */
const TRADE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

export const SEALED_PROPOSAL = 'Made trade offers; the terms stay private between the two teams.';

const PayloadSchema = z.object({
  week: z.number().int().optional(),
  /**
   * `draft_complete`: the post-draft kickoff's early look (#175), at most one offer. `chat`: a
   * trade talked about in chat (#196), the swap in `withTeamId`, `send`, and `receive`.
   */
  reason: z.enum(['week', 'draft_complete', 'chat']).default('week'),
  withTeamId: z.string().optional(),
  send: z.array(z.string()).max(3).optional(),
  receive: z.array(z.string()).max(3).optional(),
  chat: ChatSourceSchema.optional(),
  /** The durable commitment this look fulfils (#215): a pitch the agent said it would consider. */
  commitment: CommitmentRefSchema.optional()
});
type Payload = z.infer<typeof PayloadSchema>;

export const TradeProposalDecisionSchema = BaseDecisionSchema.extend({
  offers: z
    .array(
      z.object({
        candidate: z.number().int().min(1).describe('The number of a candidate offer from the list.'),
        message: z.string().max(300).optional().describe('An optional short note to the other manager.')
      })
    )
    .max(4)
    .describe('The candidate offers to send, best first. An empty list proposes nothing.'),
  reply: ChatReplySchema
});
type TradeProposalDecision = z.infer<typeof TradeProposalDecisionSchema>;

const StateSchema = z.object({
  week: z.number().int().nullable(),
  allowedActions: z.array(z.string()),
  yourTeam: z.object({ id: z.string() }).nullable(),
  teams: z.array(z.object({ id: z.string(), name: z.string(), seatType: z.string().optional() }))
});
const RosterSchema = z.object({
  players: z.array(
    z.object({
      player: z.object({ id: z.string(), name: z.string(), position: z.string() }),
      slot: z.string(),
      projectedPoints: z.number().nullable()
    })
  )
});
type RosterEntry = z.infer<typeof RosterSchema>['players'][number];
const SideSchema = z.object({ lineupDelta: z.number(), valueDelta: z.number() });
const PreviewSchema = z.object({
  valid: z.boolean(),
  sides: z.tuple([SideSchema, SideSchema]),
  fairness: z.object({ lopsided: z.boolean() })
});
const OpenSchema = z.object({
  trades: z.array(z.object({ direction: z.string(), toTeam: z.object({ id: z.string() }) }))
});
const ProposedSchema = z.object({ trade: z.object({ id: z.string() }) });

type PlayerRef = { id: string; name: string; position: string };

export interface ProposalCandidate {
  team: { id: string; name: string; seatType?: string | undefined };
  send: PlayerRef;
  receive: PlayerRef;
  /** A chat pitch may swap more than one player a side (#196); `send` and `receive` are the first. */
  sends?: PlayerRef[];
  receives?: PlayerRef[];
  /** The agent's score by the value math (lineup + discounted value, with its noise). */
  score: number;
  /** The other team's gain by the same math, unblurred. */
  partnerScore: number;
  /** Sending a player the agent is attached to (#216): the premium it had to clear on top of the bar. */
  attachment?: AttachmentAdjustment;
}

export interface ProposalPrep {
  limit: number;
  bar: number;
  candidates: ProposalCandidate[];
  /** A chat pitch (#196): who made it, and how far it moved the bar. */
  pitch?: { heard: Heard; credit: number };
  /** The commitment behind the pitch (#215), the decision before this look, and this look's facts. */
  interest?: {
    ref: CommitmentRef;
    previous: Commitment['decision'];
    facts: CommitmentFacts;
    verification: Commitment['claims'][number]['verification'];
  };
}

const pts = (p: RosterEntry) => p.projectedPoints ?? 0;
const starter = (p: RosterEntry) => p.slot !== 'BN' && p.slot !== 'IR';
const round1 = (x: number) => Math.round(x * 10) / 10;

function data<T>(envelope: Envelope, schema: z.ZodType<T>): T | null {
  return 'error' in envelope ? null : schema.parse(envelope.data);
}

/** The weakest starter's points at each position (a team with no starter there counts 0). */
function weakest(roster: readonly RosterEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of roster.filter(starter)) {
    const at = out.get(p.player.position);
    out.set(p.player.position, at === undefined ? pts(p) : Math.min(at, pts(p)));
  }
  return out;
}

/** Swap ideas with another team, most promising first (by the smaller of the two rough gains). */
export function swapIdeas(
  mine: readonly RosterEntry[],
  theirs: readonly RosterEntry[]
): { send: RosterEntry; receive: RosterEntry; rough: number }[] {
  const myWeak = weakest(mine);
  const theirWeak = weakest(theirs);
  const ideas: { send: RosterEntry; receive: RosterEntry; rough: number }[] = [];
  for (const receive of theirs) {
    const q = receive.player.position;
    if (!TRADE_POSITIONS.has(q) || receive.slot === 'IR') continue;
    const myGain = pts(receive) - (myWeak.get(q) ?? 0);
    if (myGain <= 0) continue;
    // What losing him costs them: nothing from the bench, his edge over their next best if a starter.
    const theirLoss = starter(receive) ? pts(receive) - (theirWeak.get(q) ?? 0) / 2 : 0;
    for (const send of mine) {
      const p = send.player.position;
      if (send.slot !== 'BN' || p === q || !TRADE_POSITIONS.has(p)) continue;
      const theirGain = pts(send) - (theirWeak.get(p) ?? 0) - theirLoss;
      if (theirGain <= 0) continue;
      ideas.push({ send, receive, rough: Math.min(myGain, theirGain) });
    }
  }
  return ideas.sort((a, b) => b.rough - a.rough || a.send.player.id.localeCompare(b.send.player.id));
}

/** The attachment premium on one swap (#216), from the task's attachments and agenda. */
function attachmentFor(ctx: TaskContext, sends: readonly PlayerRef[], receives: readonly PlayerRef[]) {
  return attachmentAdjustment({
    attachments: ctx.attachments,
    at: ctx.clock.now().toISOString(),
    sends,
    receives,
    agenda: ctx.agenda,
    tradeFrequency: ctx.config.tradeFrequency
  });
}

/** Prompt lines for the attached players an offer would send (public evidence, no numbers). */
function attachedLines(ctx: TaskContext, candidates: readonly ProposalCandidate[]): string[] {
  const ids = candidates.flatMap((c) =>
    (c.attachment?.players ?? []).filter((p) => !p.waived).map((p) => p.playerId)
  );
  if (ids.length === 0) return [];
  return attachmentPrompt(ctx.attachments, ctx.clock.now().toISOString(), 'public', ids).map(
    (line) => `You are attached to ${line}`
  );
}

/** Offers the early trade look right after the draft may send. */
export const EARLY_LOOK_OFFERS = 1;

async function prepare(ctx: TaskContext, payload: Payload): Promise<ProposalPrep> {
  if (payload.reason === 'chat')
    return payload.commitment === undefined
      ? weighPitch(ctx, payload)
      : considerInterest(ctx, payload, payload.commitment);
  const limit = Math.min(
    tradeAppetite(ctx.config).proposalsPerWeek,
    ctx.config.levers.actionsPerTrigger,
    payload.reason === 'draft_complete' ? EARLY_LOOK_OFFERS : Number.POSITIVE_INFINITY
  );
  if (limit === 0) throw new TaskUnavailableError('no_trade_appetite');
  return scoutProposals(ctx, limit);
}

/**
 * The trade search (see the top of this file): the vetted one-for-one offers, at most one per
 * team, best first, for up to `limit` offers. Throws `TaskUnavailableError` when trades are closed
 * (`trades_closed`) or nothing clears the bars (`no_trade_found`). The check-in (#195) shops with it
 * too.
 */
export async function scoutProposals(ctx: TaskContext, limit: number): Promise<ProposalPrep> {
  const appetite = tradeAppetite(ctx.config);
  const state = data(await ctx.tools.call('get_league_state', {}), StateSchema);
  if (state === null || state.yourTeam === null || !state.allowedActions.includes('propose_trade'))
    throw new TaskUnavailableError('trades_closed');
  const me = state.yourTeam.id;
  const pending = new Set(
    (data(await ctx.tools.call('list_trades', { status: 'open' }), OpenSchema)?.trades ?? [])
      .filter((t) => t.direction === 'outgoing')
      .map((t) => t.toTeam.id)
  );
  let week = state.week ?? undefined;
  const rosterOf = async (teamId: string) =>
    data(
      await ctx.tools.call('get_roster', { teamId, ...(week === undefined ? {} : { week }) }),
      RosterSchema
    )?.players ?? [];
  let mine = await rosterOf(me);
  // Right after the rollover the new week's projections are not out yet: scout with last week's
  // (the trade value math does the same).
  if (week !== undefined && week > 1 && mine.length > 0 && mine.every((p) => p.projectedPoints === null)) {
    week -= 1;
    mine = await rosterOf(me);
  }
  const ideas: (ReturnType<typeof swapIdeas>[number] & { team: ProposalCandidate['team'] })[] = [];
  // A contender keeps its last healthy cover at a thin position (#217): those players are not offered.
  const protectedDepth = new Set<string>(effectiveBehavior(ctx).protectDepth);
  for (const team of state.teams) {
    if (team.id === me || pending.has(team.id)) continue;
    const theirs = await rosterOf(team.id);
    // Keep the strongest baseline ideas in the preview pool. Agenda preference is applied only
    // after legality and value checks, so a failed repair idea cannot hide a valid fallback.
    ideas.push(
      ...swapIdeas(mine, theirs)
        .filter((idea) => !protectedDepth.has(idea.send.player.position))
        .slice(0, PER_TEAM)
        .map((idea) => ({ ...idea, team }))
    );
  }
  ideas.sort((a, b) => b.rough - a.rough || a.team.id.localeCompare(b.team.id));

  const bar = Math.max(appetite.acceptEdge, MIN_PROPOSAL_GAIN);
  const recency = ctx.config.valuation.recencyBias ?? 0;
  const candidates: ProposalCandidate[] = [];
  for (const idea of ideas.slice(0, CANDIDATES_TO_PREVIEW)) {
    const preview = data(
      await ctx.tools.call('preview_trade', {
        withTeamId: idea.team.id,
        send: [idea.send.player.id],
        receive: [idea.receive.player.id]
      }),
      PreviewSchema
    );
    if (preview === null || !preview.valid || preview.fairness.lopsided) continue;
    const [mySide, theirSide] = preview.sides;
    const noise = judgmentNoise(ctx, 'proposal', idea.team.id, idea.send.player.id, idea.receive.player.id);
    const score = round1((mySide.lineupDelta + mySide.valueDelta * (1 - recency)) * noise);
    const partnerScore = round1(theirSide.lineupDelta + theirSide.valueDelta);
    const attachment = attachmentFor(ctx, [idea.send.player], [idea.receive.player]);
    if (score < bar + attachment.adjustment || partnerScore < PARTNER_FLOOR) continue;
    candidates.push({
      team: idea.team,
      send: idea.send.player,
      receive: idea.receive.player,
      score,
      partnerScore,
      ...(attachment.players.length === 0 ? {} : { attachment })
    });
  }
  candidates.sort(
    (a, b) =>
      agendaPriority(ctx.agenda, b.receive.position) - agendaPriority(ctx.agenda, a.receive.position) ||
      b.score - a.score ||
      b.partnerScore - a.partnerScore
  );
  // One offer per team: the best one.
  const best = candidates.filter((c, i) => candidates.findIndex((d) => d.team.id === c.team.id) === i);
  if (best.length === 0) throw new TaskUnavailableError('no_trade_found');
  return { limit, bar, candidates: best };
}

type Verification = Commitment['claims'][number]['verification'];

/** What weighing a pitch came to: a candidate to offer, or why not, with what it rested on. */
type PitchVerdict =
  | { ok: true; prep: ProposalPrep; facts: CommitmentFacts; verification: Verification }
  | {
      ok: false;
      code: 'no_trade_found' | 'trades_closed' | 'not_convinced';
      reason: CommitmentReason;
      summary?: string;
      facts: CommitmentFacts | null;
      verification?: Verification;
    };

/** How the pitch's argument checked out, by the agent's own numbers (never its words). */
function verificationOf(heard: Heard, credit: number): Verification {
  if (!heard.found) return 'unreadable';
  if (heard.instructions) return 'ignored_orders';
  return credit > 0 ? 'supported' : 'unsupported';
}

/**
 * A trade talked about in chat (#196), weighed by the agent's own numbers: the swap's preview, its
 * score with the difficulty's noise, and the bar lowered by what the pitch is worth
 * (`persuasionAllowance`, only when the players offered improve the best lineup). Throws
 * `not_convinced` (with the numbers, for the activity log) when it does not clear.
 */
async function weighPitch(ctx: TaskContext, payload: Payload): Promise<ProposalPrep> {
  const verdict = await assessPitch(ctx, payload, []);
  if (!verdict.ok) throw new TaskUnavailableError(verdict.code, undefined, verdict.summary);
  return verdict.prep;
}

/**
 * `weighPitch`'s math, reporting instead of throwing (#215): the structured reason and the facts a
 * commitment keeps. `needs` are the agent's open starting slots, recorded so a later need can reopen
 * the question. With a commitment, every pitched player must still be on his team.
 */
async function assessPitch(
  ctx: TaskContext,
  payload: Payload,
  needs: readonly RosterSlot[]
): Promise<PitchVerdict> {
  const { withTeamId, chat } = payload;
  const send = payload.send ?? [];
  const receive = payload.receive ?? [];
  const gone = { ok: false, code: 'no_trade_found', reason: 'player_unavailable', facts: null } as const;
  if (withTeamId === undefined || chat === undefined || send.length === 0 || receive.length === 0)
    return gone;
  const state = data(await ctx.tools.call('get_league_state', {}), StateSchema);
  if (state === null || state.yourTeam === null || !state.allowedActions.includes('propose_trade'))
    return { ok: false, code: 'trades_closed', reason: 'trades_closed', facts: null };
  const team = state.teams.find((t) => t.id === withTeamId);
  // Only players the two teams really roster (the chat names them; the rosters decide).
  let projected = false;
  const owned = async (teamId: string, ids: readonly string[]) => {
    const roster = data(await ctx.tools.call('get_roster', { teamId }), RosterSchema)?.players ?? [];
    const found = ids.flatMap((id) => roster.filter((p) => p.player.id === id));
    if (found.some((p) => p.projectedPoints !== null)) projected = true;
    return found.map((p) => p.player);
  };
  const sends = await owned(state.yourTeam.id, send);
  const receives = team === undefined ? [] : await owned(team.id, receive);
  const strict = payload.commitment !== undefined;
  if (
    team === undefined ||
    sends.length === 0 ||
    receives.length === 0 ||
    (strict && (sends.length < send.length || receives.length < receive.length))
  )
    return gone;
  const heard = await heardInChat(ctx, chat);
  const preview = data(
    await ctx.tools.call('preview_trade', {
      withTeamId: team.id,
      send: sends.map((p) => p.id),
      receive: receives.map((p) => p.id)
    }),
    PreviewSchema
  );
  const swap = `${sends.map((p) => p.name).join(', ')} for ${receives.map((p) => p.name).join(', ')}`;
  const receivePositions = [...new Set(receives.map((p) => p.position))].slice(0, 3);
  const facts = (values: Partial<CommitmentFacts> = {}): CommitmentFacts => ({
    score: null,
    bar: null,
    credit: null,
    lineupDelta: null,
    attachmentPremium: null,
    needs: [...needs].slice(0, 6),
    receivePositions,
    ...values
  });
  const no = (why: string, reason: CommitmentReason, found: CommitmentFacts): PitchVerdict => ({
    ok: false,
    code: 'not_convinced',
    reason,
    summary: `Weighed ${heard.who}'s pitch (${swap}): ${why}`,
    facts: found,
    verification: verificationOf(heard, found.credit ?? 0)
  });
  if (preview === null || !preview.valid) return no('it would not be a legal trade.', 'not_legal', facts());
  const [mySide, theirSide] = preview.sides;
  // No projection for any player in the swap, and the value math found nothing either (it falls back
  // to last week's when it can): nothing to weigh it by, so say that, never "the value was not
  // there" (#219).
  if (!projected && mySide.lineupDelta === 0 && mySide.valueDelta === 0)
    return no('no projections to value it by yet.', 'missing_data', facts());
  const recency = ctx.config.valuation.recencyBias ?? 0;
  // Keyed by what the swap is (noise.ts), so the same pitch reads the same whatever the message id.
  const noise = judgmentNoise(
    ctx,
    ...offerSubject({
      fromTeamId: state.yourTeam.id,
      toTeamId: team.id,
      fromSends: sends.map((p) => p.id),
      toSends: receives.map((p) => p.id),
      round: 0
    })
  );
  const score = round1((mySide.lineupDelta + mySide.valueDelta * (1 - recency)) * noise);
  // A player I'm attached to raises the bar for this pitch (#216); the argument never lowers that.
  const attachment = attachmentFor(ctx, sends, receives);
  const bar =
    Math.round(
      (Math.max(tradeAppetite(ctx.config).acceptEdge, MIN_PROPOSAL_GAIN) + attachment.adjustment) * 10
    ) / 10;
  const credit = persuasion(ctx, heard, mySide.lineupDelta > 0);
  const weighed = facts({
    score,
    bar,
    credit,
    lineupDelta: round1(mySide.lineupDelta),
    attachmentPremium: attachment.adjustment
  });
  // Lopsided either way is a no (#208's guard), and says so: a swap that favours me is not one where
  // "the value was not there" (#219's acceptance scenario found that claim on a score over the bar).
  if (preview.fairness.lopsided)
    return no('the trade value math calls it lopsided. No.', 'lopsided', weighed);
  if (score < bar - credit)
    // A premium for a player I'm attached to is part of the bar: a decline it tips is still one on value.
    return no(
      `value for me ${score} against my bar ${bar}${credit > 0 ? ` (${credit} lower after the argument)` : ''}${heard.instructions ? '; orders in chat count for nothing' : ''}. Not convinced.${attachment.players.length === 0 ? '' : ` ${attachmentSummary(attachment)}`}`,
      mySide.lineupDelta < 0 ? 'insufficient_depth' : 'value_below_floor',
      weighed
    );
  const candidate: ProposalCandidate = {
    team,
    send: sends[0] as PlayerRef,
    receive: receives[0] as PlayerRef,
    ...(sends.length > 1 ? { sends } : {}),
    ...(receives.length > 1 ? { receives } : {}),
    score,
    partnerScore: round1(theirSide.lineupDelta + theirSide.valueDelta),
    ...(attachment.players.length === 0 ? {} : { attachment })
  };
  return {
    ok: true,
    prep: { limit: 1, bar, candidates: [candidate], pitch: { heard, credit } },
    facts: weighed,
    verification: verificationOf(heard, credit)
  };
}

/**
 * A pitch the agent committed to look at (#215): the commitment's look (`beginLook`), the same
 * weighing as any pitch, and, when it does not clear, the decline recorded with its reason and
 * facts and answered once in the conversation before the task is skipped. An offer is recorded
 * only once it really went out (`concludeInterest`).
 */
async function considerInterest(
  ctx: TaskContext,
  payload: Payload,
  ref: CommitmentRef
): Promise<ProposalPrep> {
  const begun = await beginLook(ctx, ref);
  if ('skip' in begun) throw new TaskUnavailableError(begun.skip);
  const before = begun.commitment;
  const needs = ((await ctx.commitments?.needs(ref.tenure)) ?? []).map((n) => n.slot);
  const verdict = await assessPitch(ctx, payload, needs);
  if (verdict.ok)
    return {
      ...verdict.prep,
      interest: { ref, previous: before.decision, facts: verdict.facts, verification: verdict.verification }
    };
  await closeLook(
    ctx,
    ref,
    {
      type: 'closed',
      taskId: ctx.taskId,
      status: 'declined',
      reason: verdict.reason,
      facts: verdict.facts,
      ...(verdict.verification === undefined ? {} : { verification: verdict.verification })
    },
    refusalLines(before, verdict.reason, ref.change)
  );
  throw new TaskUnavailableError(
    verdict.code,
    undefined,
    verdict.summary ?? `Looked at a pitch I said I would consider: ${reasonLine(verdict.reason)}.`
  );
}

const OFFER_SENT_ROOM = 'Took a proper look at that trade idea: check your offers.';

/** The committed look's result, recorded before its one closing line (#215). */
async function concludeInterest(
  ctx: TaskContext,
  prep: ProposalPrep,
  outcome: TaskOutcome,
  reply: string | undefined
): Promise<void> {
  const { ref, facts, verification, previous } = prep.interest as NonNullable<ProposalPrep['interest']>;
  const tradeId = outcome.sealed?.trades[0]?.tradeId;
  const said = (reply ?? '').trim();
  if (outcome.action === 'propose_trade' && tradeId !== undefined) {
    // A reconsideration recalls why it said no before, and what changed (the two teams only).
    const recalled =
      previous !== null && ref.change !== undefined
        ? `Earlier I passed because ${reasonLine(previous.reason)}. My ${ref.change} situation changed, so I sent you an offer.`
        : null;
    await closeLook(
      ctx,
      ref,
      { type: 'offered', taskId: ctx.taskId, tradeId, facts, verification },
      { dm: recalled ?? (said.length > 0 ? said : 'Ran the numbers: offer sent.'), room: OFFER_SENT_ROOM }
    );
    return;
  }
  if (outcome.action === 'propose_trade_failed') {
    // The model's line was written before the result: a failure never borrows it.
    await closeLook(
      ctx,
      ref,
      { type: 'closed', taskId: ctx.taskId, status: 'failed', reason: 'send_failed', facts, verification },
      failureLines('send_failed')
    );
    return;
  }
  // It cleared the bar and the model passed anyway: the model's own line only where it stays private.
  const pass = refusalLines({ reconsiderations: 0 }, 'model_passed');
  await closeLook(
    ctx,
    ref,
    { type: 'closed', taskId: ctx.taskId, status: 'declined', reason: 'model_passed', facts, verification },
    { dm: said.length > 0 ? said : pass.dm, room: pass.room }
  );
}

const OpenOffersSchema = z.object({
  trades: z.array(
    z.object({
      id: z.string(),
      direction: z.string(),
      toTeam: z.object({ id: z.string() }),
      fromSends: z.array(z.object({ id: z.string() })),
      toSends: z.array(z.object({ id: z.string() }))
    })
  )
});

/**
 * No model decision on a committed look (the kill switch, the budget, or a retry after an earlier
 * attempt acted): an offer that already went out is recorded as it is; otherwise nothing is sent
 * and the commitment ends `cancelled` (`autopilot`), saying so once.
 */
async function interestFallback(ctx: TaskContext, prep: ProposalPrep): Promise<TaskOutcome> {
  const { ref, facts, verification } = prep.interest as NonNullable<ProposalPrep['interest']>;
  const c = prep.candidates[0] as ProposalCandidate;
  const ids = (list: readonly { id: string }[]) =>
    list
      .map((p) => p.id)
      .sort()
      .join();
  const open = data(await ctx.tools.call('list_trades', { status: 'open' }), OpenOffersSchema);
  const sent = open?.trades.find(
    (t) =>
      t.direction === 'outgoing' &&
      t.toTeam.id === c.team.id &&
      ids(t.fromSends) === ids(c.sends ?? [c.send]) &&
      ids(t.toSends) === ids(c.receives ?? [c.receive])
  );
  if (sent !== undefined) {
    await closeLook(
      ctx,
      ref,
      { type: 'offered', taskId: ctx.taskId, tradeId: sent.id, facts, verification },
      { dm: 'Ran the numbers: offer sent.', room: OFFER_SENT_ROOM }
    );
    return {
      action: 'propose_trade',
      summary: 'Recorded the offer an earlier attempt sent.',
      sealed: { summary: SEALED_PROPOSAL, trades: [{ tradeId: sent.id, until: 'public' }], waiverClaims: [] }
    };
  }
  await closeLook(
    ctx,
    ref,
    { type: 'closed', taskId: ctx.taskId, status: 'cancelled', reason: 'autopilot', facts },
    failureLines('autopilot')
  );
  return {
    action: 'none',
    summary: 'Could not give a pitch I said I would consider a proper look without a model; sent nothing.'
  };
}

const sideNames = (one: PlayerRef, many: PlayerRef[] | undefined) =>
  (many ?? [one]).map((p) => `${p.name} (${p.position})`).join(', ');

export function describeCandidate(c: ProposalCandidate, i: number): string {
  return `${i + 1}. To ${c.team.name}: your ${sideNames(c.send, c.sends)} for their ${sideNames(c.receive, c.receives)}. Value for you ${c.score}, for them ${c.partnerScore}.`;
}

export async function propose(
  ctx: TaskContext,
  prep: ProposalPrep,
  picks: TradeProposalDecision['offers'],
  summary: string
) {
  // Each candidate once (its first mention), only real candidates, and no more than the limit.
  const chosen = picks
    .filter((o, i) => picks.findIndex((p) => p.candidate === o.candidate) === i)
    .filter((o) => o.candidate <= prep.candidates.length)
    .slice(0, prep.limit);
  const made: { id: string; c: ProposalCandidate; message: string | undefined }[] = [];
  const refused: string[] = [];
  for (const o of chosen) {
    const c = prep.candidates[o.candidate - 1] as ProposalCandidate;
    const result = await ctx.tools.call('propose_trade', {
      withTeamId: c.team.id,
      send: (c.sends ?? [c.send]).map((p) => p.id),
      receive: (c.receives ?? [c.receive]).map((p) => p.id),
      ...(o.message === undefined ? {} : { message: o.message })
    });
    if ('error' in result) refused.push(`${c.team.id} (${result.error.code})`);
    else made.push({ id: ProposedSchema.parse(result.data).trade.id, c, message: o.message });
  }
  await pitchByDm(ctx, made);
  const at = ctx.clock.now().toISOString();
  const lines = made.map(
    ({ c }) => `${c.send.name} to ${c.team.id} for ${c.receive.name} (value for you ${c.score})`
  );
  const memory: MemoryEvent[] = made.map(({ id, c }) => ({
    type: 'trade',
    teamId: c.team.id,
    tradeId: id,
    outcome: 'proposed',
    direction: 'outgoing',
    summary: `Offered ${c.send.name} for ${c.receive.name}.`,
    at,
    sent: [c.send.name],
    received: [c.receive.name],
    value: c.score
  }));
  // Which way an attachment conflict went for each offer sent (#216): a need may be named in the
  // sealed activity log, never in the agent's own record.
  const attached = (audience: 'activity' | 'memory') =>
    made.map(({ c }) => (c.attachment === undefined ? '' : attachmentSummary(c.attachment, audience)));
  const outcome: TaskOutcome = {
    action: made.length > 0 ? 'propose_trade' : refused.length > 0 ? 'propose_trade_failed' : 'none',
    summary: [summary, refused.length > 0 ? `Refused: ${refused.join(', ')}.` : '', ...attached('activity')]
      .filter((s) => s !== '')
      .join(' '),
    memorySummary:
      made.length > 0
        ? [`Offered ${lines.join('; ')}.`, ...attached('memory')].filter((s) => s !== '').join(' ')
        : 'Made no trade offers this week.',
    memory,
    ...(made.length === 0
      ? {}
      : {
          sealed: {
            summary: SEALED_PROPOSAL,
            trades: made.map(({ id }) => ({ tradeId: id, until: 'public' as const })),
            waiverClaims: []
          }
        })
  };
  return outcome;
}

/** Agents from this difficulty up (by `negotiationRounds`) follow an offer up with a DM pitch. */
export const DM_PITCH_MIN_NEGOTIATION_ROUNDS = 2;

/**
 * The DM pitch (#144): when the agent sent an offer with a note to a team a person manages, a
 * negotiating agent (difficulty `negotiationRounds` >= 2) also sends that person one direct
 * message, in its own voice (the model wrote the note in its personality), naming the offer. One
 * pitch per task; post_message applies the chat budgets and moderation, and a refused pitch changes
 * nothing about the offer. Agents never pitch other agents.
 */
async function pitchByDm(
  ctx: TaskContext,
  made: readonly { c: ProposalCandidate; message: string | undefined }[]
): Promise<void> {
  if (ctx.config.levers.negotiationRounds < DM_PITCH_MIN_NEGOTIATION_ROUNDS) return;
  const pitch = made.find((m) => m.c.team.seatType === 'human' && (m.message ?? '').trim().length > 0);
  if (pitch === undefined) return;
  const { c } = pitch;
  await ctx.tools.call('post_message', {
    roomId: dmRoomId(ctx.principal.teamId, c.team.id),
    text: `I just sent you a trade offer: my ${c.send.name} for your ${c.receive.name}. ${(pitch.message ?? '').trim()}`
  });
}

export const tradeProposalTask = defineTaskKind<Payload, TradeProposalDecision, ProposalPrep>({
  kind: 'trade_proposal',
  title: 'Look for a trade to offer',
  modelRole: 'decision',
  agenda: (_ctx, payload) => (payload.reason === 'chat' ? 'refresh_only' : 'guide_only'),
  payload: PayloadSchema,
  decision: TradeProposalDecisionSchema,
  tools: ['get_league_state', 'get_roster', 'get_player', 'get_projections', 'get_news', 'preview_trade'],
  prepare: (ctx, payload) => prepare(ctx, payload),
  // Recall first what it has with the teams it may offer to (#210).
  memoryFocus: (_ctx, _payload, prep) => prep.candidates.map((c) => c.team.id),
  instructions(ctx, payload, prep) {
    if (prep.pitch !== undefined)
      return [
        'A trade came up in chat. You ran it through your own trade value math:',
        ...prep.candidates.map(describeCandidate),
        ...attachedLines(ctx, prep.candidates),
        `Your bar is ${prep.bar}. ${heardLine(prep.pitch.heard, prep.pitch.credit, prep.bar)}`,
        'It clears your bar, so you may offer it: answer with `offers` `[{ "candidate": 1 }]` (and an optional short `message`), or an empty list to pass. You cannot change the players. Then give a `reply` for the conversation, in your own voice.'
      ].join('\n');
    return [
      payload.reason === 'draft_complete'
        ? `The draft just ended and you like to deal: take an early look for a trade. You may send up to ${prep.limit} offer(s) now.`
        : `A new week: time to shop for trades. You may send up to ${prep.limit} offer(s) this week, one per team.`,
      `Your scouting found these one-for-one swaps that help your roster by the trade value math (your bar is ${prep.bar}); each is legal and fair enough to offer:`,
      ...prep.candidates.map(describeCandidate),
      ...attachedLines(ctx, prep.candidates),
      'Check anything you doubt with your tools, then answer with `offers`: the candidate numbers to send, best first, each with an optional short `message` to the other manager. You cannot change the players. An empty list sends nothing.'
    ].join('\n');
  },
  async apply(ctx, payload, prep, decision) {
    const outcome = await propose(ctx, prep, decision.offers, decision.summary);
    if (prep.pitch === undefined || payload.chat === undefined) return outcome;
    // The pitch changed its mind (#196): it says so in the conversation and in the activity log. A
    // committed look (#215) records the actual result first and answers once, by that result.
    if (prep.interest !== undefined) await concludeInterest(ctx, prep, outcome, decision.reply);
    else await replyInChat(ctx, payload.chat, decision.reply);
    const c = prep.candidates[0] as ProposalCandidate;
    // Say what really happened (#219): "Reconsidered" only on a second look after a recorded
    // decline, and "won me over" only when the argument's credit carried a score below the bar.
    const who = prep.pitch.heard.who;
    const looked =
      prep.interest?.previous !== null && prep.interest?.previous !== undefined
        ? `Reconsidered ${who}'s pitch`
        : `Weighed ${who}'s pitch`;
    const persuaded = c.score < prep.bar ? '; the argument won me over' : '';
    const note =
      outcome.action === 'propose_trade'
        ? `${looked}${persuaded}; offered ${sideNames(c.send, c.sends)} for ${sideNames(c.receive, c.receives)}.`
        : `${looked}; sent nothing.`;
    return {
      ...outcome,
      summary: `${note} ${outcome.summary}`.trim(),
      memorySummary: `${note} ${outcome.memorySummary ?? ''}`.trim()
    };
  },
  fallback: async (ctx, _payload, prep) =>
    prep.interest === undefined
      ? { action: 'none', summary: 'No trade offers without a model decision.' }
      : interestFallback(ctx, prep),
  fakeScript: (_ctx, _payload, prep) => ({
    steps: [],
    decision: {
      summary: `Offering the best ${Math.min(prep.limit, prep.candidates.length)} swap(s) my scouting found.`,
      offers: prep.candidates.slice(0, prep.limit).map((_, i) => ({ candidate: i + 1 })),
      ...(prep.pitch === undefined ? {} : { reply: scriptedPitchReply(prep) })
    }
  })
});

/** The scripted model's line back to a pitch (tests, local dev, the simulator). */
function scriptedPitchReply(prep: ProposalPrep): string {
  const c = prep.candidates[0] as ProposalCandidate;
  return c.score < prep.bar
    ? "Fine, you've convinced me. Sending it over."
    : 'Numbers check out. Offer is on its way.';
}
