import { dmRoomId, hashString, tradeAppetite, type MemoryEvent } from '@fantasy/core';
import type { Envelope } from '@fantasy/server';
import { z } from 'zod';
import { BaseDecisionSchema, defineTaskKind, type TaskContext, type TaskOutcome } from './kinds.js';
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
  /** `draft_complete`: the post-draft kickoff's early look (#175), at most one offer. */
  reason: z.enum(['week', 'draft_complete']).default('week')
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
    .describe('The candidate offers to send, best first. An empty list proposes nothing.')
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

export interface ProposalCandidate {
  team: { id: string; name: string; seatType?: string | undefined };
  send: { id: string; name: string; position: string };
  receive: { id: string; name: string; position: string };
  /** The agent's score by the value math (lineup + discounted value, with its noise). */
  score: number;
  /** The other team's gain by the same math, unblurred. */
  partnerScore: number;
}

export interface ProposalPrep {
  limit: number;
  bar: number;
  candidates: ProposalCandidate[];
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

/** Offers the early trade look right after the draft may send. */
export const EARLY_LOOK_OFFERS = 1;

async function prepare(ctx: TaskContext, payload: Payload): Promise<ProposalPrep> {
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
  for (const team of state.teams) {
    if (team.id === me || pending.has(team.id)) continue;
    const theirs = await rosterOf(team.id);
    ideas.push(
      ...swapIdeas(mine, theirs)
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
    const unit =
      (hashString(`${ctx.taskId}|${idea.send.player.id}|${idea.receive.player.id}`) % 2001) / 1000 - 1;
    const score = round1(
      (mySide.lineupDelta + mySide.valueDelta * (1 - recency)) * (1 + unit * ctx.config.levers.valuationNoise)
    );
    const partnerScore = round1(theirSide.lineupDelta + theirSide.valueDelta);
    if (score < bar || partnerScore < PARTNER_FLOOR) continue;
    candidates.push({
      team: idea.team,
      send: idea.send.player,
      receive: idea.receive.player,
      score,
      partnerScore
    });
  }
  candidates.sort((a, b) => b.score - a.score || b.partnerScore - a.partnerScore);
  // One offer per team: the best one.
  const best = candidates.filter((c, i) => candidates.findIndex((d) => d.team.id === c.team.id) === i);
  if (best.length === 0) throw new TaskUnavailableError('no_trade_found');
  return { limit, bar, candidates: best };
}

export function describeCandidate(c: ProposalCandidate, i: number): string {
  return `${i + 1}. To ${c.team.name}: your ${c.send.name} (${c.send.position}) for their ${c.receive.name} (${c.receive.position}). Value for you ${c.score}, for them ${c.partnerScore}.`;
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
      send: [c.send.id],
      receive: [c.receive.id],
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
    summary: `Offered ${c.send.name} for ${c.receive.name}.`,
    at,
    sent: [c.send.name],
    received: [c.receive.name],
    value: c.score
  }));
  const outcome: TaskOutcome = {
    action: made.length > 0 ? 'propose_trade' : refused.length > 0 ? 'propose_trade_failed' : 'none',
    summary: [summary, refused.length > 0 ? `Refused: ${refused.join(', ')}.` : '']
      .filter((s) => s !== '')
      .join(' '),
    memorySummary: made.length > 0 ? `Offered ${lines.join('; ')}.` : 'Made no trade offers this week.',
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
  payload: PayloadSchema,
  decision: TradeProposalDecisionSchema,
  tools: ['get_league_state', 'get_roster', 'get_player', 'get_projections', 'get_news', 'preview_trade'],
  prepare: (ctx, payload) => prepare(ctx, payload),
  instructions(_ctx, payload, prep) {
    return [
      payload.reason === 'draft_complete'
        ? `The draft just ended and you like to deal: take an early look for a trade. You may send up to ${prep.limit} offer(s) now.`
        : `A new week: time to shop for trades. You may send up to ${prep.limit} offer(s) this week, one per team.`,
      `Your scouting found these one-for-one swaps that help your roster by the trade value math (your bar is ${prep.bar}); each is legal and fair enough to offer:`,
      ...prep.candidates.map(describeCandidate),
      'Check anything you doubt with your tools, then answer with `offers`: the candidate numbers to send, best first, each with an optional short `message` to the other manager. You cannot change the players. An empty list sends nothing.'
    ].join('\n');
  },
  apply: (ctx, _payload, prep, decision) => propose(ctx, prep, decision.offers, decision.summary),
  fallback: async () => ({ action: 'none', summary: 'No trade offers without a model decision.' }),
  fakeScript: (_ctx, _payload, prep) => ({
    steps: [],
    decision: {
      summary: `Offering the best ${Math.min(prep.limit, prep.candidates.length)} swap(s) my scouting found.`,
      offers: prep.candidates.slice(0, prep.limit).map((_, i) => ({ candidate: i + 1 }))
    }
  })
});
