import {
  PlayerStatusSchema,
  PositionSchema,
  RosterSlotSchema,
  optimizeLineup,
  validateLineup,
  yahooDefaultSettings,
  type LineupEntry,
  type OptimizedLineup,
  type RosterPlayer
} from '@fantasy/core';
import type { Envelope } from '@fantasy/server';
import { z } from 'zod';
import { BaseDecisionSchema, defineTaskKind, type TaskContext, type TaskOutcome } from './kinds.js';

/**
 * Lineup task: the optimizer proposes, the model confirms or suggests swaps, and the optimizer's
 * lineup is the fallback. Triggered before lineup lock and when news or a status change hits a
 * rostered player.
 *
 * Tool contract this task expects from the lineup stream (parsed defensively; the task is skipped
 * with a clear reason until those operations exist):
 * - `get_roster({ leagueId, teamId, week? })` → `{ week, roster: [{ playerId, name?, positions,
 *   status, nflTeam, slot, projectedPoints? }] }`
 * - `get_projections({ leagueId, week, playerIds })` → `{ projections: [{ playerId, points }] }`
 *   (optional; falls back to `projectedPoints` on the roster)
 * - `set_lineup({ leagueId, teamId, week, lineup: [{ playerId, slot }] })`
 */

export class TaskUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskUnavailableError';
  }
}

const RosterEntrySchema = z.object({
  playerId: z.string(),
  name: z.string().optional(),
  positions: z.array(PositionSchema),
  status: PlayerStatusSchema,
  nflTeam: z.string().nullable(),
  slot: RosterSlotSchema,
  projectedPoints: z.number().optional()
});
const RosterDataSchema = z.object({ week: z.number().int().optional(), roster: z.array(RosterEntrySchema) });
const ProjectionsDataSchema = z.object({
  projections: z.array(z.object({ playerId: z.string(), points: z.number() }))
});

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
  week: number | undefined;
  roster: RosterPlayer[];
  current: LineupEntry[];
  projections: Record<string, number>;
  optimized: OptimizedLineup;
}

function dataOf(envelope: Envelope, tool: string): unknown {
  if ('error' in envelope) {
    throw new TaskUnavailableError(`${tool} failed: ${envelope.error.code} ${envelope.error.message}`);
  }
  return envelope.data;
}

function settingsFor(ctx: TaskContext) {
  // TODO: use the league's stored settings once leagues persist them.
  return yahooDefaultSettings(ctx.league.teamCount);
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
  const result = await ctx.tools.call('set_lineup', {
    teamId: ctx.principal.teamId,
    ...(prep.week === undefined ? {} : { week: prep.week }),
    lineup
  });
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
    const week = payload.week ?? rosterData.week ?? ctx.league.week ?? undefined;
    const roster: RosterPlayer[] = rosterData.roster.map((p) => ({
      playerId: p.playerId,
      ...(p.name === undefined ? {} : { name: p.name }),
      positions: p.positions,
      status: p.status,
      nflTeam: p.nflTeam
    }));
    const projections: Record<string, number> = {};
    for (const p of rosterData.roster)
      if (p.projectedPoints !== undefined) projections[p.playerId] = p.projectedPoints;
    if (week !== undefined) {
      const response = await ctx.tools.call('get_projections', {
        week,
        playerIds: roster.map((p) => p.playerId)
      });
      if (!('error' in response)) {
        const parsed = ProjectionsDataSchema.safeParse(response.data);
        if (parsed.success) for (const p of parsed.data.projections) projections[p.playerId] = p.points;
      }
    }
    const current = rosterData.roster.map((p) => ({ playerId: p.playerId, slot: p.slot }));
    const optimized = optimizeLineup(settingsFor(ctx), roster, projections, { previousLineup: current });
    return { week, roster, current, projections, optimized };
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
      const check = validateLineup(settingsFor(ctx), prep.roster, swapped, { previousLineup: prep.current });
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
