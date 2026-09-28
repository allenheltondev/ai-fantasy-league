import { hashString, suggestFaabBid } from '@fantasy/core';
import type { Envelope } from '@fantasy/server';
import { z } from 'zod';
import { BaseDecisionSchema, defineTaskKind, type TaskContext, type TaskOutcome } from './kinds.js';

/**
 * Waiver task (#57): when a waiver window opens, the agent looks at trending pickups, checks each
 * one with preview_waiver_claim (is he available, does the roster need a drop), projects him against
 * the weakest player on the roster, and proposes FAAB bids with `suggestFaabBid`. The bid grows
 * with the archetype's `waiverAggressiveness` (a waiver hawk bids big) and is blurred by the
 * difficulty's `valuationNoise`; the number of claims is capped by the difficulty's action budget.
 * The persona shapes the model's judgment and summary through the system prompt.
 *
 * The model reviews the suggestions (and can dig into news, projections, and trending itself) and
 * answers with the claims to make. Only then are they submitted through claim_waiver, the same
 * tool a person's UI uses. With no model decision the fallback makes no claims (docs/ARCHITECTURE.md).
 */

/** Trending pickups to look at, and how many of them to preview. */
export const TRENDING_LOOKBACK_HOURS = 72;
export const MAX_CANDIDATES = 8;
/** Projected weekly points a pickup must add to be worth suggesting. */
export const MIN_GAIN = 0.5;

const WaiverPayloadSchema = z.object({
  week: z.number().int().min(1).max(18).optional(),
  closesAt: z.string().optional(),
  reason: z.enum(['window', 'news', 'status']).default('window'),
  playerId: z.string().optional()
});
type WaiverPayload = z.infer<typeof WaiverPayloadSchema>;

export const WaiverDecisionSchema = BaseDecisionSchema.extend({
  claims: z
    .array(
      z.object({
        playerId: z.string().describe('The player to add.'),
        dropPlayerId: z
          .string()
          .optional()
          .describe('Your player to release (required when your roster is full).'),
        bid: z.number().int().min(0).describe('FAAB bid in whole dollars (free agents cost nothing).')
      })
    )
    .max(5)
    .describe('Claims to submit, most wanted first. An empty list makes no moves.')
});
type WaiverDecision = z.infer<typeof WaiverDecisionSchema>;

const PlayerRef = z.object({
  id: z.string(),
  name: z.string(),
  position: z.string(),
  team: z.string().nullable()
});
const StateSchema = z.object({
  flags: z.object({ waiversOpen: z.boolean() }),
  yourTeam: z.object({ faabRemaining: z.number() }).nullable()
});
const TrendingSchema = z.object({ players: z.array(z.object({ player: PlayerRef, count: z.number() })) });
const PreviewSchema = z.object({
  outcome: z.enum(['add_now', 'claim_pending', 'blocked']),
  issues: z.array(z.object({ code: z.string() })),
  currentRoster: z.array(PlayerRef)
});
const ProjectionsSchema = z.object({
  projections: z.array(z.object({ player: z.object({ id: z.string() }), points: z.number() }))
});

export interface WaiverSuggestion {
  player: z.infer<typeof PlayerRef>;
  kind: 'add_now' | 'claim_pending';
  drop: z.infer<typeof PlayerRef> | null;
  points: number;
  gain: number;
  bid: number;
  trendingCount: number;
}

interface WaiverPrep {
  open: boolean;
  faabRemaining: number;
  roster: z.infer<typeof PlayerRef>[];
  suggestions: WaiverSuggestion[];
}

/** The data of a successful call, else null (research the agent can live without). */
function optional<T>(envelope: Envelope, schema: z.ZodType<T>): T | null {
  return 'error' in envelope ? null : schema.parse(envelope.data);
}

/** A deterministic multiplier in [1 - noise, 1 + noise] per task and player. */
function noiseFor(ctx: TaskContext, playerId: string): number {
  const spread = ctx.config.levers.valuationNoise;
  const unit = (hashString(`${ctx.taskId}|${playerId}`) % 2001) / 1000 - 1;
  return 1 + unit * spread;
}

async function prepare(ctx: TaskContext): Promise<WaiverPrep> {
  const state = optional(await ctx.tools.call('get_league_state', {}), StateSchema);
  if (state === null || !state.flags.waiversOpen || state.yourTeam === null) {
    return { open: false, faabRemaining: 0, roster: [], suggestions: [] };
  }
  const faabRemaining = state.yourTeam.faabRemaining;
  // Previews bid the minimum, so a league without $0 bids does not block every waiver claim.
  const minBid = ctx.league.settings.waivers.allowZeroBids ? 0 : 1;
  const trending =
    optional(
      await ctx.tools.call('get_trending_players', {
        type: 'add',
        lookbackHours: TRENDING_LOOKBACK_HOURS,
        limit: 20
      }),
      TrendingSchema
    )?.players ?? [];

  const candidates: {
    player: z.infer<typeof PlayerRef>;
    /** `blocked` only by a full roster: known once a drop is picked. */
    kind: 'add_now' | 'claim_pending' | 'blocked';
    needsDrop: boolean;
    count: number;
  }[] = [];
  let roster: z.infer<typeof PlayerRef>[] = [];
  for (const entry of trending.slice(0, MAX_CANDIDATES)) {
    const preview = optional(
      await ctx.tools.call('preview_waiver_claim', { playerId: entry.player.id, bid: minBid }),
      PreviewSchema
    );
    const codes = preview?.issues.map((i) => i.code) ?? ['UNAVAILABLE'];
    if (preview === null || codes.some((c) => c !== 'ROSTER_FULL')) continue;
    roster = preview.currentRoster;
    const needsDrop = codes.includes('ROSTER_FULL');
    candidates.push({ player: entry.player, kind: preview.outcome, needsDrop, count: entry.count });
  }

  if (candidates.length === 0) return { open: true, faabRemaining, roster, suggestions: [] };
  const ids = [...new Set([...candidates.map((c) => c.player.id), ...roster.map((p) => p.id)])].slice(0, 25);
  const projections = optional(
    await ctx.tools.call('get_projections', {
      playerIds: ids,
      season: ctx.league.season,
      week: ctx.league.week
    }),
    ProjectionsSchema
  );
  const points = new Map((projections?.projections ?? []).map((p) => [p.player.id, p.points]));
  const pts = (id: string) => points.get(id) ?? 0;

  const usedDrops = new Set<string>();
  const suggestions: WaiverSuggestion[] = [];
  for (const c of candidates.sort((a, b) => pts(b.player.id) - pts(a.player.id))) {
    let drop: z.infer<typeof PlayerRef> | null = null;
    if (c.needsDrop) {
      const pool = roster.filter((p) => !usedDrops.has(p.id));
      const samePosition = pool.filter((p) => p.position === c.player.position);
      // A full roster always has someone to drop; a drop already promised to a better pickup is skipped.
      drop =
        [...(samePosition.length > 0 ? samePosition : pool)].sort((a, b) => pts(a.id) - pts(b.id))[0] ?? null;
    }
    const gain = pts(c.player.id) - (drop === null ? 0 : pts(drop.id));
    if (gain < MIN_GAIN || (c.needsDrop && drop === null)) continue;
    let kind: 'add_now' | 'claim_pending' = c.kind === 'add_now' ? 'add_now' : 'claim_pending';
    if (drop !== null) {
      // With the drop named, the preview says whether he is a free agent or on waivers. Anything
      // else that would stop the claim surfaces when it is made.
      const withDrop = optional(
        await ctx.tools.call('preview_waiver_claim', {
          playerId: c.player.id,
          dropPlayerId: drop.id,
          bid: minBid
        }),
        PreviewSchema
      );
      kind = withDrop?.outcome === 'add_now' ? 'add_now' : 'claim_pending';
      usedDrops.add(drop.id);
    }
    const bid =
      kind === 'add_now'
        ? 0
        : suggestFaabBid({
            gain,
            faabRemaining,
            aggressiveness: ctx.config.waiverAggressiveness,
            noise: noiseFor(ctx, c.player.id),
            minBid
          });
    suggestions.push({
      player: c.player,
      kind,
      drop,
      points: pts(c.player.id),
      gain: Math.round(gain * 10) / 10,
      bid,
      trendingCount: c.count
    });
  }
  return {
    open: true,
    faabRemaining,
    roster,
    suggestions: suggestions.slice(0, ctx.config.levers.actionsPerTrigger)
  };
}

function describeSuggestion(s: WaiverSuggestion): string {
  const how = s.kind === 'add_now' ? 'free agent, add now' : `on waivers, bid $${s.bid}`;
  const drop = s.drop === null ? '' : `, drop ${s.drop.name} (${s.drop.id})`;
  return `- ${s.player.name} (${s.player.id}, ${s.player.position}): ${s.points} projected pts, +${s.gain} over the drop; ${how}${drop}. Trending adds: ${s.trendingCount}.`;
}

export const waiverTask = defineTaskKind<WaiverPayload, WaiverDecision, WaiverPrep>({
  kind: 'waivers',
  title: 'Work the waiver wire',
  modelRole: 'decision',
  payload: WaiverPayloadSchema,
  decision: WaiverDecisionSchema,
  tools: [
    'get_league_state',
    'get_player',
    'search_players',
    'get_projections',
    'get_news',
    'get_trending_players',
    'preview_waiver_claim',
    'list_waiver_claims',
    'list_transactions'
  ],
  prepare: (ctx) => prepare(ctx),
  instructions(_ctx, payload, prep) {
    if (!prep.open)
      return 'Waivers are closed right now. Make no claims: answer with an empty `claims` list.';
    const closes =
      payload.closesAt === undefined
        ? ''
        : ` Claims on players on waivers are processed at ${payload.closesAt}.`;
    return [
      `A waiver window is open.${closes} You have $${prep.faabRemaining} FAAB left; the highest bid wins a player on waivers and free agents cost nothing.`,
      prep.suggestions.length === 0
        ? 'No trending pickup looks better than your roster right now.'
        : `Your scouting suggests:\n${prep.suggestions.map(describeSuggestion).join('\n')}`,
      `Your roster: ${prep.roster.map((p) => `${p.name} (${p.id}, ${p.position})`).join(', ') || 'unknown'}.`,
      'Check news and projections for anyone you are unsure about, then answer with the `claims` to make (most wanted first), each with a `bid` and a `dropPlayerId` when your roster is full. Keep FAAB for the rest of the season: bid big only on a real starter. An empty list is fine.'
    ].join('\n');
  },
  async apply(ctx, _payload, prep, decision) {
    if (!prep.open || decision.claims.length === 0) {
      return { action: 'none', summary: decision.summary };
    }
    const made: string[] = [];
    const failed: string[] = [];
    for (const claim of decision.claims) {
      const bid = Math.min(Math.max(0, claim.bid), prep.faabRemaining);
      const result = await ctx.tools.call('claim_waiver', {
        playerId: claim.playerId,
        ...(claim.dropPlayerId === undefined ? {} : { dropPlayerId: claim.dropPlayerId }),
        bid
      });
      if ('error' in result) failed.push(`${claim.playerId} (${result.error.code})`);
      else made.push(`${claim.playerId} ($${bid})`);
    }
    const outcome: TaskOutcome = {
      action: made.length > 0 ? 'claim_waiver' : 'claims_failed',
      summary: [
        decision.summary,
        made.length > 0 ? `Claimed: ${made.join(', ')}.` : '',
        failed.length > 0 ? `Refused: ${failed.join(', ')}.` : ''
      ]
        .filter((s) => s.length > 0)
        .join(' ')
    };
    return outcome;
  },
  fallback: async () => ({ action: 'none', summary: 'No waiver claims without a model decision.' }),
  fakeScript: (_ctx, _payload, prep) => ({
    steps: [],
    decision: {
      summary:
        prep.suggestions.length === 0
          ? 'Nothing worth a claim this window.'
          : 'Going after the best trending pickups.',
      claims: prep.suggestions.map((s) => ({
        playerId: s.player.id,
        ...(s.drop === null ? {} : { dropPlayerId: s.drop.id }),
        bid: s.bid
      }))
    }
  })
});
