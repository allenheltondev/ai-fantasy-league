import {
  PlayerStatusSchema,
  PositionSchema,
  SLOT_ELIGIBILITY,
  rosterHoles,
  suggestFaabBid,
  waiverMinGain,
  type ResearchAccess,
  type RosterSlot
} from '@fantasy/core';
import type { Envelope } from '@fantasy/server';
import { z } from 'zod';
import { BaseDecisionSchema, defineTaskKind, type TaskContext, type TaskOutcome } from './kinds.js';
import { judgmentNoise } from './noise.js';

/**
 * Waiver task (#57): when a waiver window opens, the agent looks at trending pickups, checks each
 * one with preview_waiver_claim (is he available, does the roster need a drop), projects him against
 * the weakest player on the roster, and proposes FAAB bids with `suggestFaabBid`. The bid grows
 * with the archetype's `waiverAggressiveness` (a waiver hawk bids big and claims smaller upgrades,
 * `waiverMinGain`) and is blurred by the
 * difficulty's `valuationNoise`; the number of claims is capped by the difficulty's action budget.
 * The persona shapes the model's judgment and summary through the system prompt.
 *
 * The model reviews the suggestions (and can dig into news, projections, and trending itself) and
 * answers with the claims to make. Only then are they submitted through claim_waiver, the same
 * tool a person's UI uses, and never more than the difficulty's `actionsPerTrigger` of them. With
 * no model decision the fallback makes no claims (docs/ARCHITECTURE.md). The bids are sealed in the
 * activity log until the claims are processed (issue #122).
 */

/** Trending pickups to look at, and how many of them to preview. */
export const TRENDING_LOOKBACK_HOURS = 72;
export const MAX_CANDIDATES = 8;

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
const ClaimResultSchema = z.object({ claim: z.object({ id: z.string() }).nullable() });
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

export interface WaiverPrep {
  open: boolean;
  faabRemaining: number;
  roster: z.infer<typeof PlayerRef>[];
  suggestions: WaiverSuggestion[];
}

/** The data of a successful call, else null (research the agent can live without). */
function optional<T>(envelope: Envelope, schema: z.ZodType<T>): T | null {
  return 'error' in envelope ? null : schema.parse(envelope.data);
}

/** A deterministic multiplier in [1 - noise, 1 + noise] for this agent, week, and player (noise.ts). */
function noiseFor(ctx: TaskContext, playerId: string): number {
  return judgmentNoise(ctx, 'waiver', playerId);
}

/** A player worth a closer look, from trending adds or a roster hole. */
export interface Lead {
  player: z.infer<typeof PlayerRef>;
  /** Trending adds (0 for a hole's lead). */
  count: number;
}

const CLOSED: WaiverPrep = { open: false, faabRemaining: 0, roster: [], suggestions: [] };

/** Your team's FAAB when waivers are open; null when they are closed. */
export async function openTeam(ctx: TaskContext): Promise<{ faabRemaining: number } | null> {
  const state = optional(await ctx.tools.call('get_league_state', {}), StateSchema);
  return state === null || !state.flags.waiversOpen ? null : state.yourTeam;
}

async function prepare(ctx: TaskContext): Promise<WaiverPrep> {
  const team = await openTeam(ctx);
  if (team === null) return CLOSED;
  const trending =
    optional(
      await ctx.tools.call('get_trending_players', {
        type: 'add',
        lookbackHours: TRENDING_LOOKBACK_HOURS,
        limit: 20
      }),
      TrendingSchema
    )?.players ?? [];
  // Projected weekly points a pickup must add to be worth suggesting, by the archetype.
  return scout(
    ctx,
    team.faabRemaining,
    trending.slice(0, MAX_CANDIDATES),
    waiverMinGain(ctx.config.waiverAggressiveness)
  );
}

/**
 * Checks each lead with preview_waiver_claim (is he available, does the roster need a drop),
 * projects him against the weakest player on the roster, and suggests a FAAB bid. A pickup must add
 * `minGain` projected weekly points over his drop. Players in `keep` are never dropped (the
 * check-in keeps players on bye, whose zero projection says nothing about them).
 */
export async function scout(
  ctx: TaskContext,
  faabRemaining: number,
  leads: readonly Lead[],
  minGain: number,
  keep: ReadonlySet<string> = new Set()
): Promise<WaiverPrep> {
  // Previews bid the minimum, so a league without $0 bids does not block every waiver claim.
  const minBid = ctx.league.settings.waivers.allowZeroBids ? 0 : 1;
  const candidates: {
    player: z.infer<typeof PlayerRef>;
    /** `blocked` only by a full roster: known once a drop is picked. */
    kind: 'add_now' | 'claim_pending' | 'blocked';
    needsDrop: boolean;
    count: number;
  }[] = [];
  let roster: z.infer<typeof PlayerRef>[] = [];
  for (const entry of leads) {
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
      const pool = roster.filter((p) => !usedDrops.has(p.id) && !keep.has(p.id));
      const samePosition = pool.filter((p) => p.position === c.player.position);
      // A full roster always has someone to drop; a drop already promised to a better pickup is skipped.
      drop =
        [...(samePosition.length > 0 ? samePosition : pool)].sort((a, b) => pts(a.id) - pts(b.id))[0] ?? null;
    }
    const gain = pts(c.player.id) - (drop === null ? 0 : pts(drop.id));
    if (gain < minGain || (c.needsDrop && drop === null)) continue;
    let kind: 'add_now' | 'claim_pending' = c.kind === 'add_now' ? 'add_now' : 'claim_pending';
    if (drop !== null) {
      // With the drop named, the preview says whether he is a free agent or on waivers, and whether
      // the drop is allowed (a drop locked by the time the claim runs is not). Anything else that
      // would stop the claim surfaces when it is made.
      const withDrop = optional(
        await ctx.tools.call('preview_waiver_claim', {
          playerId: c.player.id,
          dropPlayerId: drop.id,
          bid: minBid
        }),
        PreviewSchema
      );
      if (withDrop?.issues.some((i) => i.code === 'PLAYER_LOCKED') === true) continue;
      kind = withDrop?.outcome === 'add_now' ? 'add_now' : 'claim_pending';
      usedDrops.add(drop.id);
    }
    const bid =
      kind === 'add_now'
        ? 0
        : suggestFaabBid({
            gain: Math.max(0, gain),
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

const HoleRosterSchema = z.object({
  players: z.array(
    z.object({ player: z.object({ id: z.string(), position: PositionSchema }), status: PlayerStatusSchema })
  )
});
const FoundSchema = z.object({ players: z.array(PlayerRef) });

/** Leads searched per position and availability (free agents, then players on waivers). */
export const HOLE_LEADS = 2;

export interface HoleScan extends WaiverPrep {
  /** The starting slots the roster cannot fill with players who will play. */
  holes: RosterSlot[];
}

/**
 * The post-draft waiver scan (#175): the starting slots the roster cannot fill with players who
 * will play (core `rosterHoles`: an empty kicker or defense slot, a starter out or on IR with no
 * healthy backup), each with the best-ranked healthy players still available at an eligible
 * position, scouted like any pickup but with no gain bar (a hole takes the best healthy body). At
 * most one suggestion per hole. Waivers closed or no holes: no suggestions.
 *
 * The check-in (#195) also counts players in `unavailable` as not playing (those on bye), and
 * never drops a player in `keep`.
 */
export async function scanRosterHoles(
  ctx: TaskContext,
  options: { unavailable?: ReadonlySet<string>; keep?: ReadonlySet<string> } = {}
): Promise<HoleScan> {
  const team = await openTeam(ctx);
  const roster =
    team === null
      ? null
      : optional(await ctx.tools.call('get_roster', { teamId: ctx.principal.teamId }), HoleRosterSchema);
  if (team === null || roster === null) return { ...CLOSED, holes: [] };
  const holes = rosterHoles(
    ctx.league.settings,
    roster.players.map((p) => ({
      positions: [p.player.position],
      status: options.unavailable?.has(p.player.id) === true ? 'out' : p.status
    }))
  );
  const leads: Lead[] = [];
  for (const position of new Set(holes.flatMap((slot) => SLOT_ELIGIBILITY[slot]))) {
    for (const availability of ['free_agent', 'waivers'] as const) {
      const found = optional(
        await ctx.tools.call('search_players', {
          position,
          leagueId: ctx.league.id,
          availability,
          injury: 'healthy',
          limit: HOLE_LEADS
        }),
        FoundSchema
      );
      // Positions and availabilities do not overlap, so neither do the leads.
      leads.push(...(found?.players ?? []).map((player) => ({ player, count: 0 })));
    }
  }
  if (leads.length === 0)
    return { open: true, faabRemaining: team.faabRemaining, roster: [], suggestions: [], holes };
  const scouted = await scout(
    ctx,
    team.faabRemaining,
    leads.slice(0, MAX_CANDIDATES),
    Number.NEGATIVE_INFINITY,
    options.keep
  );
  const unfilled = [...holes];
  const suggestions = scouted.suggestions.filter((s) => {
    const at = unfilled.findIndex((slot) =>
      (SLOT_ELIGIBILITY[slot] as readonly string[]).includes(s.player.position)
    );
    if (at < 0) return false;
    unfilled.splice(at, 1);
    return true;
  });
  return { ...scouted, suggestions, holes };
}

/** The scouting's suggestions as claims, most wanted first. */
export function suggestedClaims(prep: Pick<WaiverPrep, 'suggestions'>): WaiverDecision['claims'] {
  return prep.suggestions.map((s) => ({
    playerId: s.player.id,
    ...(s.drop === null ? {} : { dropPlayerId: s.drop.id }),
    bid: s.bid
  }));
}

/**
 * One suggestion as the model sees it. The scouting behind it used full research (deterministic
 * code), but the prompt only repeats what the agent's own research access could have found:
 * projected points need `projections`, trending counts need `trending` (issue #122).
 */
function describeSuggestion(s: WaiverSuggestion, research: ResearchAccess): string {
  const how = s.kind === 'add_now' ? 'free agent, add now' : `on waivers, bid $${s.bid}`;
  const drop = s.drop === null ? '' : `, drop ${s.drop.name} (${s.drop.id})`;
  const points = research.projections ? `: ${s.points} projected pts, +${s.gain} over the drop;` : ':';
  const trend = research.trending ? ` Trending adds: ${s.trendingCount}.` : '';
  return `- ${s.player.name} (${s.player.id}, ${s.player.position})${points} ${how}${drop}.${trend}`;
}

/** Claims actually submitted: at most the difficulty's actions per trigger, whatever the model returns. */
export function claimsToApply<T>(claims: readonly T[], actionsPerTrigger: number): T[] {
  return claims.slice(0, Math.max(0, actionsPerTrigger));
}

/**
 * Submits claims through claim_waiver, the same tool a person's UI uses: never more than the
 * difficulty's `actionsPerTrigger`, each bid within the FAAB left. Bids on players still on waivers
 * are sealed in the activity log until the claims are processed.
 */
export async function submitClaims(
  ctx: TaskContext,
  prep: Pick<WaiverPrep, 'open' | 'faabRemaining'>,
  wanted: WaiverDecision['claims'],
  summary: string,
  /** How to name a player in the summary (the check-in names them; the waiver task keeps ids). */
  label: (playerId: string) => string = (id) => id
): Promise<TaskOutcome> {
  const claims = claimsToApply(wanted, ctx.config.levers.actionsPerTrigger);
  if (!prep.open || claims.length === 0) {
    return { action: 'none', summary };
  }
  const made: string[] = [];
  const failed: string[] = [];
  const pending: string[] = [];
  for (const claim of claims) {
    const bid = Math.min(Math.max(0, claim.bid), prep.faabRemaining);
    const result = await ctx.tools.call('claim_waiver', {
      playerId: claim.playerId,
      ...(claim.dropPlayerId === undefined ? {} : { dropPlayerId: claim.dropPlayerId }),
      bid
    });
    if ('error' in result) failed.push(`${label(claim.playerId)} (${result.error.code})`);
    else {
      made.push(`${label(claim.playerId)} ($${bid})`);
      const id = ClaimResultSchema.safeParse(result.data).data?.claim?.id;
      if (id !== undefined) pending.push(id);
    }
  }
  const skipped = wanted.length - claims.length;
  const outcome: TaskOutcome = {
    action: made.length > 0 ? 'claim_waiver' : 'claims_failed',
    summary: [
      summary,
      made.length > 0 ? `Claimed: ${made.join(', ')}.` : '',
      failed.length > 0 ? `Refused: ${failed.join(', ')}.` : '',
      skipped > 0 ? `Ignored ${skipped} more claim(s) over the action limit.` : ''
    ]
      .filter((s) => s.length > 0)
      .join(' '),
    // Bids on players still on waivers are secret until the claims are processed.
    ...(pending.length === 0
      ? {}
      : {
          sealed: {
            summary: `Made ${made.length} waiver claim(s); players and bids are hidden until waivers are processed.`,
            trades: [],
            waiverClaims: pending
          }
        })
  };
  return outcome;
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
  instructions(ctx, payload, prep) {
    if (!prep.open)
      return 'Waivers are closed right now. Make no claims: answer with an empty `claims` list.';
    const research = ctx.config.levers.research;
    const most = ctx.config.levers.actionsPerTrigger;
    const closes =
      payload.closesAt === undefined
        ? ''
        : ` Claims on players on waivers are processed at ${payload.closesAt}.`;
    return [
      `A waiver window is open.${closes} You have $${prep.faabRemaining} FAAB left; the highest bid wins a player on waivers and free agents cost nothing.`,
      prep.suggestions.length === 0
        ? 'No trending pickup looks better than your roster right now.'
        : `Your scouting suggests:\n${prep.suggestions.map((s) => describeSuggestion(s, research)).join('\n')}`,
      `Your roster: ${prep.roster.map((p) => `${p.name} (${p.id}, ${p.position})`).join(', ') || 'unknown'}.`,
      `Check anyone you are unsure about with your research tools, then answer with the \`claims\` to make (most wanted first, at most ${most}; any more are ignored), each with a \`bid\` and a \`dropPlayerId\` when your roster is full. Keep FAAB for the rest of the season: bid big only on a real starter. An empty list is fine.`
    ].join('\n');
  },
  apply: (ctx, _payload, prep, decision) => submitClaims(ctx, prep, decision.claims, decision.summary),
  fallback: async () => ({ action: 'none', summary: 'No waiver claims without a model decision.' }),
  fakeScript: (_ctx, _payload, prep) => ({
    steps: [],
    decision: {
      summary:
        prep.suggestions.length === 0
          ? 'Nothing worth a claim this window.'
          : 'Going after the best trending pickups.',
      claims: suggestedClaims(prep)
    }
  })
});
