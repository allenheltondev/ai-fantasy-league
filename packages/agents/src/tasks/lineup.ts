import {
  PlayerStatusSchema,
  PositionSchema,
  RosterSlotSchema,
  optimizeLineup,
  validateLineup,
  type LineupContext,
  type LineupEntry,
  type OptimizedLineup,
  type RosterPlayer
} from '@fantasy/core';
import type { Envelope } from '@fantasy/server';
import { z } from 'zod';
import { BaseDecisionSchema, defineTaskKind, type TaskContext, type TaskOutcome } from './kinds.js';

/**
 * Lineup task: the optimizer proposes, the model confirms or suggests swaps, and the optimizer's
 * lineup is the fallback. Triggered by `Lineup Lock Approaching` (scheduled before each game
 * window) and when news or a status change hits a rostered player.
 *
 * It works through the real season operations, with the agent's own principal:
 * - `get_roster({ leagueId, teamId, week? })` gives the players, their slots, statuses, kickoffs,
 *   locks, and projected points under league scoring;
 * - `set_lineup({ leagueId, teamId, week, moves: [{ playerId, slot }] })` moves the players whose
 *   slot changed. Locked players keep their slots (the optimizer honors the kickoffs).
 */

export class TaskUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskUnavailableError';
  }
}

/** The part of `get_roster`'s response the lineup task reads. */
const RosterEntrySchema = z.object({
  player: z.object({
    id: z.string(),
    name: z.string(),
    team: z.string().nullable(),
    position: PositionSchema
  }),
  slot: RosterSlotSchema,
  status: PlayerStatusSchema,
  kickoff: z.string().nullable(),
  projectedPoints: z.number().nullable()
});
const RosterDataSchema = z.object({ week: z.number().int(), players: z.array(RosterEntrySchema) });

const LineupPayloadSchema = z.object({
  week: z.number().int().min(1).max(18).optional(),
  reason: z.enum(['lock', 'news', 'status']).default('lock'),
  playerId: z.string().optional()
});
type LineupPayload = z.infer<typeof LineupPayloadSchema>;

export const LineupDecisionSchema = BaseDecisionSchema.extend({
  confirm: z.boolean().describe('True to start the proposed lineup as is.'),
  swaps: z
    .array(z.object({ bench: z.string(), starter: z.string() }))
    .max(5)
    .optional()
    .describe('When not confirming: pairs of (bench player id, starter player id) to swap.')
});
type LineupDecision = z.infer<typeof LineupDecisionSchema>;

interface LineupPrep {
  week: number;
  roster: RosterPlayer[];
  current: LineupEntry[];
  projections: Record<string, number>;
  /** Lock and bye context for the core rules; empty when the week's games are not known. */
  context: LineupContext;
  optimized: OptimizedLineup;
}

function dataOf(envelope: Envelope, tool: string): unknown {
  if ('error' in envelope) {
    throw new TaskUnavailableError(`${tool} failed: ${envelope.error.code} ${envelope.error.message}`);
  }
  return envelope.data;
}

function settingsFor(ctx: TaskContext) {
  return ctx.league.settings;
}

function sameLineup(a: readonly LineupEntry[], b: readonly LineupEntry[]): boolean {
  const slots = new Map(b.map((e) => [e.playerId, e.slot]));
  return a.length === b.length && a.every((e) => slots.get(e.playerId) === e.slot);
}

export function applySwaps(
  lineup: readonly LineupEntry[],
  swaps: readonly { bench: string; starter: string }[]
) {
  const slots = new Map(lineup.map((e) => [e.playerId, e.slot]));
  for (const { bench, starter } of swaps) {
    const a = slots.get(bench);
    const b = slots.get(starter);
    if (a === undefined || b === undefined) continue;
    slots.set(bench, b);
    slots.set(starter, a);
  }
  return lineup.map((e) => ({ playerId: e.playerId, slot: slots.get(e.playerId) ?? e.slot }));
}

function describe(
  lineup: readonly LineupEntry[],
  roster: readonly RosterPlayer[],
  pts: Record<string, number>
) {
  const names = new Map(roster.map((p) => [p.playerId, p.name ?? p.playerId]));
  return lineup
    .filter((e) => e.slot !== 'BN' && e.slot !== 'IR')
    .map((e) => `${e.slot}: ${names.get(e.playerId)} (${e.playerId}, ${pts[e.playerId] ?? 0} pts)`)
    .join('\n');
}

async function setLineup(
  ctx: TaskContext,
  prep: LineupPrep,
  lineup: LineupEntry[],
  why: string
): Promise<TaskOutcome> {
  if (sameLineup(lineup, prep.current)) return { action: 'lineup_unchanged', summary: why };
  const before = new Map(prep.current.map((e) => [e.playerId, e.slot]));
  const moves = lineup.filter((e) => before.get(e.playerId) !== e.slot);
  const result = await ctx.tools.call('set_lineup', { teamId: ctx.principal.teamId, week: prep.week, moves });
  if ('error' in result) {
    return { action: 'set_lineup_failed', summary: `${why} set_lineup failed: ${result.error.message}` };
  }
  return { action: 'set_lineup', summary: why };
}

export const lineupTask = defineTaskKind<LineupPayload, LineupDecision, LineupPrep>({
  kind: 'lineup',
  title: 'Set your lineup',
  modelRole: 'decision',
  payload: LineupPayloadSchema,
  decision: LineupDecisionSchema,
  tools: [
    'get_roster',
    'get_player',
    'search_players',
    'get_projections',
    'get_news',
    'get_matchup_outlook',
    'get_trending_players'
  ],
  async prepare(ctx, payload) {
    const rosterData = RosterDataSchema.parse(
      dataOf(
        await ctx.tools.call('get_roster', {
          teamId: ctx.principal.teamId,
          ...(payload.week === undefined ? {} : { week: payload.week })
        }),
        'get_roster'
      )
    );
    const roster: RosterPlayer[] = rosterData.players.map((p) => ({
      playerId: p.player.id,
      name: p.player.name,
      positions: [p.player.position],
      status: p.status,
      nflTeam: p.player.team
    }));
    const projections: Record<string, number> = {};
    for (const p of rosterData.players)
      if (p.projectedPoints !== null) projections[p.player.id] = p.projectedPoints;
    const current = rosterData.players.map((p) => ({ playerId: p.player.id, slot: p.slot }));
    // Kickoffs by NFL team: players lock at kickoff and teams without a game are on bye. When the
    // week's games are unknown (no kickoff anywhere), bye and lock checks are left out.
    const games: Record<string, { kickoff: string }> = {};
    for (const p of rosterData.players) {
      if (p.kickoff !== null && p.player.team !== null) games[p.player.team] = { kickoff: p.kickoff };
    }
    const context: LineupContext =
      Object.keys(games).length === 0
        ? { previousLineup: current }
        : { games, now: ctx.clock.now(), previousLineup: current };
    const optimized = optimizeLineup(settingsFor(ctx), roster, projections, context);
    return { week: rosterData.week, roster, current, projections, context, optimized };
  },
  instructions(_ctx, payload, prep) {
    const why =
      payload.reason === 'lock'
        ? 'Lineups lock soon.'
        : `News or a status change just hit ${payload.playerId ?? 'one of your players'}.`;
    return [
      `${why} The lineup optimizer proposes this lineup (${prep.optimized.projectedPoints} projected points):`,
      describe(prep.optimized.lineup, prep.roster, prep.projections),
      'Check anything you are unsure about with your research tools, then answer with `confirm: true` to start it, or `confirm: false` with up to 5 `swaps` of (bench player id, starter player id).',
      'Never start a player who is out, on IR, or on bye.'
    ].join('\n');
  },
  async apply(ctx, _payload, prep, decision) {
    let lineup = prep.optimized.lineup;
    let summary = decision.summary;
    if (!decision.confirm && decision.swaps !== undefined && decision.swaps.length > 0) {
      const swapped = applySwaps(lineup, decision.swaps);
      const check = validateLineup(settingsFor(ctx), prep.roster, swapped, prep.context);
      if (check.valid) lineup = check.lineup;
      else summary = `${summary} (Suggested swaps were not legal; kept the optimizer lineup.)`;
    }
    return setLineup(ctx, prep, lineup, summary);
  },
  fallback: (ctx, _payload, prep) =>
    setLineup(
      ctx,
      prep,
      prep.optimized.lineup,
      `Optimizer lineup (${prep.optimized.projectedPoints} projected points).`
    ),
  fakeScript: (_ctx, _payload, prep) => ({
    steps: [],
    decision: {
      summary: `Going with the optimizer: ${prep.optimized.projectedPoints} projected points.`,
      confirm: true
    }
  })
});
