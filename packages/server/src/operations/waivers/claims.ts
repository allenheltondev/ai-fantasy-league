import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireMember, requireTeam } from '../../league/access.js';
import { actorTeam, assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { WAIVER_CLAIM_STATUSES, type WaiverClaimRecord } from '../../repos/waivers.js';
import {
  actingTeam,
  claimView,
  ClaimViewSchema,
  planClaim,
  playerRefs,
  resolveDrop,
  TeamIdField
} from './shared.js';

/** Claim statuses every member may see for any team: resolved claims, whose bids are no longer secret. */
const PUBLIC_STATUSES: ReadonlySet<string> = new Set(['awarded', 'failed']);

const ClaimIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe('Waiver claim id, from claim_waiver or list_waiver_claims.');

export const listWaiverClaims = defineOperation({
  name: 'list_waiver_claims',
  method: 'GET',
  path: '/leagues/{leagueId}/waivers/claims',
  summary: 'Your waiver claims: pending, awarded, failed, or cancelled',
  description: [
    "Lists waiver claims, pending ones by default, in each team's processing order (priority, then age). Bids are sealed: you see every claim of your own team, but another team's claims (and bids) only once they are resolved (`awarded` or `failed`); nobody, not even the commissioner, sees another team's pending or cancelled claims. Filter by team with `teamId`. Failed claims carry `failure` with the reason (for example PLAYER_CLAIMED when someone outbid you) and a fix."
  ].join(' '),
  tags: ['waivers'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Only this team's claims (another team's only once resolved)."),
    status: z
      .enum([...WAIVER_CLAIM_STATUSES, 'all'])
      .default('pending')
      .describe('Which claims: pending (default), awarded, failed, cancelled, or all.')
  }),
  output: z.object({ claims: z.array(ClaimViewSchema) }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    if (input.teamId !== undefined) requireTeam(access, input.teamId);
    const own = actorTeam(access.actor)?.id ?? null;
    // Sealed bids: another team's claims are visible only once resolved, even to the commissioner.
    const visible = (c: WaiverClaimRecord) => c.teamId === own || PUBLIC_STATUSES.has(c.status);
    const claims = (
      await ctx.repos.waivers.listClaims(access.league.id, input.status === 'all' ? undefined : input.status)
    )
      .filter((c) => (input.teamId === undefined || c.teamId === input.teamId) && visible(c))
      .sort(
        (a, b) =>
          a.teamId.localeCompare(b.teamId) ||
          a.priority - b.priority ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id)
      );
    const refs = await playerRefs(
      ctx,
      claims.flatMap((c) => [c.addPlayerId, c.dropPlayerId])
    );
    return { claims: claims.map((c) => claimView(c, access.teams, refs)) };
  }
});

async function ownPendingClaim(
  ctx: Ctx,
  leagueId: string,
  teamId: string,
  claimId: string
): Promise<WaiverClaimRecord> {
  const claim = await ctx.repos.waivers.getClaim(leagueId, claimId);
  if (claim === null || claim.teamId !== teamId) {
    throw new ApiError('WAIVER_CLAIM_NOT_FOUND', `You have no waiver claim "${claimId}".`, {
      fix: 'Call list_waiver_claims to see your claims and their ids.'
    });
  }
  if (claim.status !== 'pending') {
    throw new ApiError('WAIVER_CLAIM_NOT_PENDING', `Claim ${claimId} is already ${claim.status}.`, {
      fix: 'Only pending claims can be changed. list_waiver_claims shows the pending ones.',
      details: { status: claim.status }
    });
  }
  return claim;
}

export const cancelWaiverClaim = defineOperation({
  name: 'cancel_waiver_claim',
  method: 'DELETE',
  path: '/leagues/{leagueId}/waivers/claims/{claimId}',
  summary: 'Cancel one of your pending waiver claims',
  description:
    "Cancels a pending claim before the waiver run processes it. Only your own team's pending claims can be cancelled; WAIVER_CLAIM_NOT_PENDING means it was already processed or cancelled. To change a bid or drop, use update_waiver_claim instead.",
  tags: ['waivers'],
  mutation: true,
  input: z.object({ leagueId: LeagueIdSchema, claimId: ClaimIdSchema, teamId: TeamIdField }),
  output: z.object({ claim: ClaimViewSchema }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const team = actingTeam(access, input.teamId);
    assertAction('cancel_waiver_claim', access.league, access.actor, now);
    const claim = await ownPendingClaim(ctx, access.league.id, team.id, input.claimId);
    const updated = await ctx.repos.waivers.updateClaim({
      ...claim,
      status: 'cancelled',
      resolvedAt: now.toISOString()
    });
    const refs = await playerRefs(ctx, [updated.addPlayerId, updated.dropPlayerId]);
    return { claim: claimView(updated, access.teams, refs) };
  }
});

export const reorderWaiverClaims = defineOperation({
  name: 'reorder_waiver_claims',
  method: 'PUT',
  path: '/leagues/{leagueId}/waivers/claims/order',
  summary: 'Set the order your pending waiver claims are processed in',
  description:
    'Pass every pending claim id of your team in the order you want them tried (most wanted first). When one claim wins, a later claim that needs the same drop player fails, so put the player you want most first. Missing or extra ids return INVALID_INPUT listing your pending claims.',
  tags: ['waivers'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdField,
    claimIds: z
      .array(ClaimIdSchema)
      .min(1)
      .max(50)
      .describe('All of your pending claim ids, most wanted first.')
  }),
  output: z.object({ claims: z.array(ClaimViewSchema) }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const team = actingTeam(access, input.teamId);
    assertAction('reorder_waiver_claims', access.league, access.actor, now);
    const pending = (await ctx.repos.waivers.listClaims(access.league.id, 'pending')).filter(
      (c) => c.teamId === team.id
    );
    const ids = new Set(input.claimIds);
    if (
      ids.size !== input.claimIds.length ||
      ids.size !== pending.length ||
      pending.some((c) => !ids.has(c.id))
    ) {
      throw new ApiError('INVALID_INPUT', 'claimIds must list each of your pending claims exactly once.', {
        fix: `Pass these ids in your preferred order: ${pending.map((c) => c.id).join(', ') || '(none pending)'}.`
      });
    }
    const updated: WaiverClaimRecord[] = [];
    for (const [index, id] of input.claimIds.entries()) {
      const claim = pending.find((c) => c.id === id) as WaiverClaimRecord;
      updated.push(
        claim.priority === index + 1
          ? claim
          : await ctx.repos.waivers.updateClaim({ ...claim, priority: index + 1 })
      );
    }
    const refs = await playerRefs(
      ctx,
      updated.flatMap((c) => [c.addPlayerId, c.dropPlayerId])
    );
    return { claims: updated.map((c) => claimView(c, access.teams, refs)) };
  }
});

export const updateWaiverClaim = defineOperation({
  name: 'update_waiver_claim',
  method: 'PATCH',
  path: '/leagues/{leagueId}/waivers/claims/{claimId}',
  summary: 'Change the bid or the drop player of one of your pending waiver claims',
  description: [
    'Edits a pending claim before the waiver run: a new FAAB `bid`, a new drop player (`dropPlayerId` or `dropPlayer`), or no drop (`clearDrop: true`). Fields you leave out keep their value; the claim keeps its place in your order (reorder_waiver_claims changes that).',
    'The edit is checked like a new claim: INSUFFICIENT_FAAB, ZERO_BID_NOT_ALLOWED, ROSTER_FULL (a full roster needs a drop), DROP_PLAYER_NOT_ON_ROSTER, and PLAYER_LOCKED (the drop player will be locked when the claim runs). WAIVER_CLAIM_NOT_PENDING means it was already processed or cancelled.'
  ].join(' '),
  tags: ['waivers'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    claimId: ClaimIdSchema,
    teamId: TeamIdField,
    bid: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe('The new whole-dollar FAAB bid. Leave out to keep the current bid.'),
    dropPlayerId: z
      .string()
      .min(1)
      .optional()
      .describe('The new drop player. Leave out to keep the current one.'),
    dropPlayer: z
      .string()
      .min(1)
      .optional()
      .describe('The new drop player by name, when you do not have the id.'),
    clearDrop: z
      .boolean()
      .default(false)
      .describe('Set true to drop nobody when the claim wins (only while your roster has room).')
  }),
  output: z.object({ claim: ClaimViewSchema }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const team = actingTeam(access, input.teamId);
    assertAction('update_waiver_claim', access.league, access.actor, now);
    const claim = await ownPendingClaim(ctx, access.league.id, team.id, input.claimId);
    const player = await ctx.data.players.resolve({ playerId: claim.addPlayerId });
    const named = await resolveDrop(ctx, input);
    const drop =
      input.clearDrop || named !== null
        ? named
        : claim.dropPlayerId === null
          ? null
          : await ctx.data.players.resolve({ playerId: claim.dropPlayerId });
    const plan = await planClaim(
      ctx,
      access,
      team,
      { player, drop, bid: input.bid ?? claim.bid },
      now,
      claim.id
    );
    if (plan.kind !== 'claim_pending') {
      throw new ApiError(
        'WAIVER_CLAIM_NOT_PENDING',
        `${player.name} is a free agent now, so there is no claim to edit.`,
        {
          fix: `Cancel claim ${claim.id} with cancel_waiver_claim and add him with claim_waiver.`,
          details: { claimId: claim.id }
        }
      );
    }
    const updated = await ctx.repos.waivers.updateClaim({
      ...claim,
      bid: plan.bid,
      dropPlayerId: drop?.id ?? null,
      processesAt: plan.processesAt ?? claim.processesAt
    });
    const refs = await playerRefs(ctx, [updated.addPlayerId, updated.dropPlayerId]);
    return { claim: claimView(updated, access.teams, refs) };
  }
});
