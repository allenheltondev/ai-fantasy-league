import {
  autopick,
  PositionSchema,
  SLOT_ELIGIBILITY,
  valuationNoiseMultiplier,
  type AutopickChoice,
  type DraftablePlayer,
  type DraftState,
  type Position,
  type RosterSlot
} from '@fantasy/core';
import type { Envelope } from '@fantasy/server';
import { z } from 'zod';
import { BaseDecisionSchema, defineTaskKind, type TaskContext, type TaskOutcome } from './kinds.js';
import { TaskUnavailableError } from './lineup.js';

/**
 * Draft task (issue #49): on `Draft Turn Started` for its team, the agent reads the board, may
 * research, and names one player. Core autopick, bent by the agent's archetype (position weights)
 * and difficulty (valuation noise), recommends a pick and is the fallback when there is no model
 * decision or the model's pick is refused. The pick itself is made by the runtime with
 * `make_draft_pick`, pinned to the pick number, so a late answer never lands on a later pick.
 */

const PlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  team: z.string().nullable(),
  position: PositionSchema
});

/** The part of `get_draft_board` the task reads. */
const BoardSchema = z.object({
  status: z.string(),
  rounds: z.number().int(),
  pickSeconds: z.number().int(),
  order: z.array(z.object({ teamId: z.string() })),
  onTheClock: z
    .object({
      overall: z.number().int(),
      round: z.number().int(),
      teamId: z.string(),
      deadline: z.string().nullable()
    })
    .nullable(),
  yourNeeds: z.array(z.string()),
  picks: z.array(
    z.object({
      overall: z.number().int(),
      round: z.number().int(),
      pick: z.number().int(),
      teamId: z.string(),
      player: PlayerSchema,
      auto: z.boolean()
    })
  ),
  bestAvailable: z.array(z.object({ player: PlayerSchema, rank: z.number().nullable() }))
});
type Board = z.infer<typeof BoardSchema>;
type Candidate = Board['bestAvailable'][number];

const DraftPayloadSchema = z.object({
  pick: z.number().int().min(1).optional(),
  round: z.number().int().min(1).optional(),
  deadline: z.string().optional()
});
type DraftPayload = z.infer<typeof DraftPayloadSchema>;

export const DraftDecisionSchema = BaseDecisionSchema.extend({
  playerId: z
    .string()
    .min(1)
    .describe('The id of the available player you draft (from bestAvailable or search).')
});
type DraftDecision = z.infer<typeof DraftDecisionSchema>;

interface DraftPrep {
  overall: number;
  round: number;
  deadline: string | null;
  needs: string[];
  /** Available players, best first for this agent (archetype and difficulty applied). */
  candidates: Candidate[];
  recommended: (AutopickChoice & { name: string }) | null;
}

/** How many available players the task reads; enough for a model to weigh real alternatives. */
export const DRAFT_CANDIDATES = 40;
const UNRANKED = 999;

function dataOf(envelope: Envelope, tool: string): unknown {
  if ('error' in envelope) {
    throw new TaskUnavailableError(`${tool} failed: ${envelope.error.code} ${envelope.error.message}`);
  }
  return envelope.data;
}

async function readBoard(ctx: TaskContext, query: Record<string, unknown>): Promise<Board> {
  return BoardSchema.parse(dataOf(await ctx.tools.call('get_draft_board', query), 'get_draft_board'));
}

/** The board as a core draft state, so core autopick can run on it. */
function draftState(board: Board): DraftState {
  return {
    teamIds: board.order.map((o) => o.teamId),
    rounds: board.rounds,
    pickSeconds: board.pickSeconds,
    positionLimits: {},
    tradedPicks: [],
    picks: board.picks.map((p) => ({
      overall: p.overall,
      round: p.round,
      pick: p.pick,
      teamId: p.teamId,
      playerId: p.player.id,
      positions: [p.player.position],
      madeAt: null,
      auto: p.auto
    }))
  };
}

/**
 * The agent's own ranking: consensus rank divided by the archetype's position weight (a zero-RB
 * drafter pushes backs down) and by the difficulty's seeded valuation noise (a rookie misjudges).
 */
export function agentRank(ctx: Pick<TaskContext, 'config' | 'seat'>, candidate: Candidate): number {
  const weight = ctx.config.valuation.positionWeights?.[candidate.player.position] ?? 1;
  const noise = valuationNoiseMultiplier(
    ctx.config.levers.valuationNoise,
    ctx.seat.agentId,
    candidate.player.id
  );
  return (candidate.rank ?? UNRANKED) / (weight * noise);
}

async function pick(ctx: TaskContext, prep: DraftPrep, playerId: string): Promise<Envelope> {
  return ctx.tools.call('make_draft_pick', { teamId: ctx.principal.teamId, playerId, pick: prep.overall });
}

async function fallbackPick(ctx: TaskContext, prep: DraftPrep, why: string): Promise<TaskOutcome> {
  if (prep.recommended === null) return { action: 'none', summary: `${why} No draftable player found.` };
  const result = await pick(ctx, prep, prep.recommended.playerId);
  if ('error' in result) {
    return { action: 'draft_pick_failed', summary: `${why} make_draft_pick failed: ${result.error.message}` };
  }
  return { action: 'make_draft_pick', summary: `${why} Autopick: ${prep.recommended.name}.` };
}

function describeCandidate(c: Candidate): string {
  return `${c.player.name} (${c.player.id}, ${c.player.position}, ${c.player.team ?? 'FA'}, rank ${c.rank ?? 'unranked'})`;
}

export const draftTask = defineTaskKind<DraftPayload, DraftDecision, DraftPrep>({
  kind: 'draft_pick',
  title: 'Make your draft pick',
  modelRole: 'decision',
  payload: DraftPayloadSchema,
  decision: DraftDecisionSchema,
  tools: [
    'get_draft_board',
    'search_players',
    'get_player',
    'get_projections',
    'get_news',
    'get_trending_players'
  ],
  async prepare(ctx, payload) {
    const board = await readBoard(ctx, { limit: DRAFT_CANDIDATES });
    const clock = board.onTheClock;
    if (
      clock === null ||
      clock.teamId !== ctx.principal.teamId ||
      (payload.pick !== undefined && clock.overall !== payload.pick)
    ) {
      throw new TaskUnavailableError('not on the clock: the pick was already made');
    }
    // Make sure every empty starting slot has candidates, even a K or DEF ranked outside the top 40.
    const candidates = [...board.bestAvailable];
    const needed = new Set(board.yourNeeds.flatMap((slot) => SLOT_ELIGIBILITY[slot as RosterSlot] ?? []));
    for (const position of needed) {
      if (candidates.some((c) => c.player.position === position)) continue;
      const more = await readBoard(ctx, { position, limit: 5 });
      candidates.push(...more.bestAvailable);
    }
    const ranked = candidates
      .map((c) => ({ c, score: agentRank(ctx, c) }))
      .sort((a, b) => a.score - b.score || a.c.player.id.localeCompare(b.c.player.id))
      .map((r) => r.c);
    const choice = autopick(
      draftState(board),
      ranked.map((c): DraftablePlayer => ({
        playerId: c.player.id,
        positions: [c.player.position as Position]
      })),
      ranked.map((c) => c.player.id),
      ctx.league.settings
    );
    const name = (id: string) => ranked.find((c) => c.player.id === id)?.player.name ?? id;
    return {
      overall: clock.overall,
      round: clock.round,
      deadline: clock.deadline,
      needs: board.yourNeeds,
      candidates: ranked,
      recommended: choice === null ? null : { ...choice, name: name(choice.playerId) }
    };
  },
  instructions(_ctx, _payload, prep) {
    const top = prep.candidates.slice(0, 15).map((c, i) => `${i + 1}. ${describeCandidate(c)}`);
    return [
      `You are on the clock: round ${prep.round}, pick ${prep.overall}${prep.deadline === null ? '' : `, autopick at ${prep.deadline}`}. Decide quickly; the clock does not wait.`,
      `Empty starting slots: ${prep.needs.length === 0 ? 'none (take the best value)' : prep.needs.join(', ')}. Your remaining picks must fill them.`,
      'Best available for your strategy, best first:',
      ...top,
      prep.recommended === null
        ? 'No recommendation.'
        : `Recommended: ${prep.recommended.name} (${prep.recommended.playerId}).`,
      'Research with your tools if you like, then answer with the `playerId` of one available player. The runtime makes the pick; you do not call make_draft_pick yourself.'
    ].join('\n');
  },
  async apply(ctx, _payload, prep, decision) {
    const result = await pick(ctx, prep, decision.playerId);
    if (!('error' in result)) return { action: 'make_draft_pick', summary: decision.summary };
    ctx.log.warn('model draft pick refused; autopicking', {
      code: result.error.code,
      playerId: decision.playerId
    });
    return fallbackPick(ctx, prep, `Wanted ${decision.playerId} but ${result.error.code}.`);
  },
  fallback: (ctx, _payload, prep) => fallbackPick(ctx, prep, 'No model decision.'),
  fakeScript: (_ctx, _payload, prep) => ({
    steps: [],
    decision: {
      summary:
        prep.recommended === null
          ? 'Nothing left worth taking.'
          : `Taking ${prep.recommended.name}: ${prep.recommended.reason === 'starter_need' ? 'fills a starting slot' : 'best value on the board'}.`,
      playerId: prep.recommended?.playerId ?? 'none'
    }
  })
});
