import {
  autopick,
  byeClash,
  byeRemains,
  draftRiskMultiplier,
  isStarterSlot,
  likelyTakenBeforeNextTurn,
  picksBeforeNextTurn,
  POSITIONS,
  PositionSchema,
  recentPositionRun,
  ROSTER_SLOTS,
  seasonWindow,
  SLOT_ELIGIBILITY,
  slotCount,
  valuationNoiseMultiplier,
  type AutopickChoice,
  type DifficultyLevers,
  type DraftablePlayer,
  type DraftRiskPlayer,
  type DraftState,
  type LeagueSettings,
  type Position,
  type PositionCount,
  type RosterSlot,
  type SeasonWindow
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
 *
 * Draft context (issue #135): the prompt also shows the agent its roster by position against the
 * league's starting slots, each candidate's bye week and injury designation, and, in a mid-season
 * league, how many regular-season weeks are left. Autopick (recommendation and fallback) marks
 * down a candidate whose bye matches most of the team's players at his position, and a sidelined
 * player in a mid-season draft (core `draftRiskMultiplier`); human autopick is unchanged. How much
 * draft intel the prompt adds on top follows existing levers (see `draftIntel`).
 */

const PlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  team: z.string().nullable(),
  position: PositionSchema
});
const ByeSchema = z.number().int().nullable().default(null);

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
      auto: z.boolean(),
      bye: ByeSchema
    })
  ),
  bestAvailable: z.array(
    z.object({
      player: PlayerSchema,
      rank: z.number().nullable(),
      bye: ByeSchema,
      injuryStatus: z.string().nullable().default(null)
    })
  )
});
type Board = z.infer<typeof BoardSchema>;
type Candidate = Pick<Board['bestAvailable'][number], 'player' | 'rank'> &
  Partial<Pick<Board['bestAvailable'][number], 'bye' | 'injuryStatus'>>;
type RosterPlayer = Board['picks'][number]['player'] & { bye: number | null };

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
  /** Available players, best first for this agent (archetype, difficulty, and draft risk applied). */
  candidates: Candidate[];
  recommended: (AutopickChoice & { name: string }) | null;
  /** The team's drafted players, in pick order. */
  roster: RosterPlayer[];
  window: SeasonWindow;
  /** Picks other teams make before this team's next turn; null when this is its last pick. */
  picksBetween: number | null;
  /** Ids of the listed candidates the other teams will likely take before the next turn. */
  likelyGone: string[];
  /** Positions of the last `RUN_PICKS` picks, most first. */
  run: PositionCount[];
  settings: Pick<LeagueSettings, 'roster'>;
}

/** How many available players the task reads; enough for a model to weigh real alternatives. */
export const DRAFT_CANDIDATES = 40;
/** How many candidates the prompt lists. */
export const PROMPT_CANDIDATES = 15;
/** How many recent picks the positional-run line reads. */
export const RUN_PICKS = 8;
const UNRANKED = 999;

/**
 * How much draft intel a difficulty reads, from existing levers rather than a new one. Positional
 * runs are market reading, like trending adds in the waiver prompt, so they need `research.trending`
 * (Amateur and up). Predicting who goes before the next turn is planning ahead, so it needs more
 * than `low` reasoning effort, the lever that also sizes the memory budget (Pro and up). Every
 * difficulty sees its roster, byes, injuries, and the season: the basics any draft room shows.
 */
export function draftIntel(levers: Pick<DifficultyLevers, 'research' | 'reasoningEffort'>): {
  runs: boolean;
  nextTurn: boolean;
} {
  return { runs: levers.research.trending, nextTurn: levers.reasoningEffort !== 'low' };
}

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

/** The longest reason `make_draft_pick` keeps. */
export const PICK_REASON_MAX = 280;

async function pick(ctx: TaskContext, prep: DraftPrep, playerId: string, reason?: string): Promise<Envelope> {
  return ctx.tools.call('make_draft_pick', {
    teamId: ctx.principal.teamId,
    playerId,
    pick: prep.overall,
    // The agent's reasoning goes with the pick: the draft recap and notable-pick chat show it.
    ...(reason === undefined ? {} : { reason: reason.trim().slice(0, PICK_REASON_MAX) })
  });
}

async function fallbackPick(ctx: TaskContext, prep: DraftPrep, why: string): Promise<TaskOutcome> {
  if (prep.recommended === null) return { action: 'none', summary: `${why} No draftable player found.` };
  const result = await pick(ctx, prep, prep.recommended.playerId);
  if ('error' in result) {
    return { action: 'draft_pick_failed', summary: `${why} make_draft_pick failed: ${result.error.message}` };
  }
  return { action: 'make_draft_pick', summary: `${why} Autopick: ${prep.recommended.name}.` };
}

function riskOf(p: RosterPlayer | Candidate): DraftRiskPlayer {
  return 'player' in p
    ? { position: p.player.position, bye: p.bye ?? null, injuryStatus: p.injuryStatus ?? null }
    : { position: p.position, bye: p.bye };
}

function byeText(bye: number | null | undefined, window: SeasonWindow): string {
  if (bye === null || bye === undefined) return '';
  return window.midSeason && !byeRemains(bye, window) ? `, bye ${bye} played` : `, bye ${bye}`;
}

function describeCandidate(c: Candidate, prep: DraftPrep): string {
  const injury = c.injuryStatus ? `, ${c.injuryStatus}` : '';
  const clash = byeClash(riskOf(c), prep.roster.map(riskOf), prep.window) ? ' (bye clash)' : '';
  return `${c.player.name} (${c.player.id}, ${c.player.position}, ${c.player.team ?? 'FA'}, rank ${c.rank ?? 'unranked'}${byeText(c.bye, prep.window)}${injury})${clash}`;
}

/**
 * The team's roster by position with depth against the starting slots, e.g.
 * `QB 1/1: Patrick Mahomes (KC, bye 10) · RB 3/2+flex: ...`. Positions with no starting slot and
 * no players are left out.
 */
export function rosterSummary(
  roster: readonly RosterPlayer[],
  settings: Pick<LeagueSettings, 'roster'>,
  window: SeasonWindow
): string {
  if (roster.length === 0) return 'Your roster: empty.';
  const flexSlots = ROSTER_SLOTS.filter(
    (slot) => isStarterSlot(slot) && SLOT_ELIGIBILITY[slot].length > 1 && slotCount(settings, slot) > 0
  );
  const parts = POSITIONS.flatMap((position) => {
    const mine = roster.filter((p) => p.position === position);
    const starters = slotCount(settings, position as RosterSlot);
    if (mine.length === 0 && starters === 0) return [];
    const flex = flexSlots.some((slot) => SLOT_ELIGIBILITY[slot].includes(position)) ? '+flex' : '';
    const names = mine.map((p) => `${p.name} (${p.team ?? 'FA'}${byeText(p.bye, window)})`).join(', ');
    return [`${position} ${mine.length}/${starters}${flex}${names === '' ? '' : `: ${names}`}`];
  });
  return `Your roster (drafted/starting slots): ${parts.join(' · ')}.`;
}

/** The season line: only a league that starts after NFL week 1 gets one. */
export function seasonLine(window: SeasonWindow, currentWeek: number | null): string | null {
  if (!window.midSeason) return null;
  const now = currentWeek === null ? '' : ` (NFL week ${currentWeek} now)`;
  const base = `Season: you play weeks ${window.firstWeek}-${window.lastWeek}${now}, ${window.weeksRemaining} regular-season week(s) left, so an injured player costs weeks that count.`;
  return window.shortSeason
    ? `${base} Few weeks remain: favour healthy players producing now over long-term upside, and weigh the byes still to come.`
    : base;
}

/** Picks until the next turn, and which listed candidates will likely be gone by then. */
export function nextTurnLine(prep: Pick<DraftPrep, 'picksBetween' | 'likelyGone' | 'candidates'>): string {
  if (prep.picksBetween === null) return 'This is your last pick.';
  const when =
    prep.picksBetween === 0
      ? 'You pick again right after this.'
      : `Your next pick is ${prep.picksBetween} picks after this one.`;
  if (prep.likelyGone.length === 0) return `${when} Your top candidates should still be there.`;
  const name = (id: string) => prep.candidates.find((c) => c.player.id === id)?.player.name ?? id;
  return `${when} Likely gone by then: ${prep.likelyGone.map(name).join(', ')}.`;
}

/** The last picks by position, e.g. `Last 8 picks: 3 TE, 2 WR, 2 RB, 1 QB.` */
export function runLine(run: readonly PositionCount[]): string | null {
  const total = run.reduce((n, r) => n + r.count, 0);
  if (total === 0) return null;
  return `Last ${total} picks: ${run.map((r) => `${r.count} ${r.position}`).join(', ')}.`;
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
    const teamId = ctx.principal.teamId;
    const roster = board.picks.filter((p) => p.teamId === teamId).map((p) => ({ ...p.player, bye: p.bye }));
    const window = seasonWindow(ctx.league.settings.schedule, ctx.league.week);
    const risk = roster.map(riskOf);
    const ranked = candidates
      .map((c) => ({ c, score: agentRank(ctx, c) * draftRiskMultiplier(riskOf(c), risk, window) }))
      .sort((a, b) => a.score - b.score || a.c.player.id.localeCompare(b.c.player.id))
      .map((r) => r.c);
    const state = draftState(board);
    const draftable = ranked.map((c): DraftablePlayer => ({
      playerId: c.player.id,
      positions: [c.player.position as Position]
    }));
    const choice = autopick(
      state,
      draftable,
      ranked.map((c) => c.player.id),
      ctx.league.settings
    );
    // Other teams pick by consensus rank, not by this agent's strategy.
    const consensus = Object.fromEntries(ranked.map((c) => [c.player.id, c.rank ?? UNRANKED]));
    const gone = new Set(likelyTakenBeforeNextTurn(state, teamId, draftable, consensus, ctx.league.settings));
    const name = (id: string) => ranked.find((c) => c.player.id === id)?.player.name ?? id;
    return {
      overall: clock.overall,
      round: clock.round,
      deadline: clock.deadline,
      needs: board.yourNeeds,
      candidates: ranked,
      recommended: choice === null ? null : { ...choice, name: name(choice.playerId) },
      roster,
      window,
      picksBetween: picksBeforeNextTurn(state, teamId),
      likelyGone: ranked
        .slice(0, PROMPT_CANDIDATES)
        .filter((c) => gone.has(c.player.id))
        .map((c) => c.player.id),
      run: recentPositionRun(state.picks, RUN_PICKS),
      settings: ctx.league.settings
    };
  },
  instructions(ctx, _payload, prep) {
    const intel = draftIntel(ctx.config.levers);
    const top = prep.candidates
      .slice(0, PROMPT_CANDIDATES)
      .map((c, i) => `${i + 1}. ${describeCandidate(c, prep)}`);
    const run = intel.runs ? runLine(prep.run) : null;
    const season = seasonLine(prep.window, ctx.league.week);
    return [
      `You are on the clock: round ${prep.round}, pick ${prep.overall}${prep.deadline === null ? '' : `, autopick at ${prep.deadline}`}. Decide quickly; the clock does not wait.`,
      ...(season === null ? [] : [season]),
      rosterSummary(prep.roster, prep.settings, prep.window),
      `Empty starting slots: ${prep.needs.length === 0 ? 'none (take the best value)' : prep.needs.join(', ')}. Your remaining picks must fill them.`,
      ...(intel.nextTurn ? [nextTurnLine(prep)] : []),
      ...(run === null ? [] : [run]),
      'Best available for your strategy, best first:',
      ...top,
      prep.recommended === null
        ? 'No recommendation.'
        : `Recommended: ${prep.recommended.name} (${prep.recommended.playerId}).`,
      'Research with your tools if you like, then answer with the `playerId` of one available player. The runtime makes the pick; you do not call make_draft_pick yourself.',
      'Your `summary` is posted with the pick as your reasoning: the league reads it in the draft recap.'
    ].join('\n');
  },
  async apply(ctx, _payload, prep, decision) {
    const result = await pick(ctx, prep, decision.playerId, decision.summary);
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
