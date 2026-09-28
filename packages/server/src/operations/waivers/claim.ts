import { randomUUID } from 'node:crypto';
import { waiverClearsAt } from '@fantasy/core';
import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import { ApiError } from '../../errors.js';
import { requireMember } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { PlayerRefSchema, playerSelectorShape, toPlayerRef } from '../../players/model.js';
import { defineOperation, withWarnings, type Warning } from '../../registry/operation.js';
import type { WaiverClaimRecord } from '../../repos/waivers.js';
import { changeRoster, putOnWaivers } from '../../waivers/rosters.js';
import {
  actingTeam,
  BidField,
  claimView,
  ClaimViewSchema,
  dropSelectorShape,
  planClaim,
  playerRefs,
  refOf,
  resolveDrop,
  TeamIdField
} from './shared.js';

const ClaimInput = z.object({
  leagueId: LeagueIdSchema,
  teamId: TeamIdField,
  ...playerSelectorShape,
  ...dropSelectorShape,
  bid: BidField,
  priority: z
    .number()
    .int()
    .min(1)
    .max(99)
    .optional()
    .describe(
      'Where this claim goes in your own claim order (1 is processed first). Defaults to after your other pending claims. Use it to say which of several targets you want most.'
    )
});

export const claimWaiver = defineOperation({
  name: 'claim_waiver',
  method: 'POST',
  path: '/leagues/{leagueId}/waivers/claims',
  summary: 'Add a free agent now, or claim a player on waivers with a FAAB bid',
  description: [
    'Adds a player to your roster. A free agent (not on a roster and not on waivers) joins immediately at no cost (`outcome: "added"`). A player on waivers (recently dropped) gets a pending claim instead (`outcome: "claim_pending"`), resolved at the waiver run in `claim.processesAt`: the highest FAAB bid wins, ties go to waiver priority, and your own claims run in their `priority` order.',
    'Pass `dropPlayerId` to release someone in the same move; it is required when your roster is full (ROSTER_FULL lists the players you can drop). The dropped player goes on waivers for the league waiver period.',
    'Call preview_waiver_claim first to check the outcome and the resulting roster. Errors: PLAYER_NOT_AVAILABLE (on a roster), INSUFFICIENT_FAAB (bid over your budget), ZERO_BID_NOT_ALLOWED, DUPLICATE_WAIVER_CLAIM (cancel the old one first), ACQUISITION_LIMIT_REACHED, and PHASE_NOT_ALLOWED outside the season.'
  ].join(' '),
  tags: ['waivers'],
  mutation: true,
  input: ClaimInput,
  output: z.object({
    outcome: z.enum(['added', 'claim_pending']),
    player: PlayerRefSchema,
    dropped: PlayerRefSchema.nullable().describe(
      'Released now (`added`) or when the claim wins (`claim_pending`).'
    ),
    claim: ClaimViewSchema.nullable().describe('The pending claim, for `claim_pending`.'),
    faabRemaining: z.number().int()
  }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const team = actingTeam(access, input.teamId);
    assertAction('claim_waiver', access.league, access.actor, now);
    const player = await ctx.data.players.resolve(input);
    const drop = await resolveDrop(ctx, input);
    const plan = await planClaim(ctx, access, team, { player, drop, bid: input.bid }, now);
    const warnings: Warning[] = [];

    if (plan.kind === 'add_now') {
      const updated = await changeRoster(ctx.repos, team, { add: player.id, drop: drop?.id ?? null }, now);
      if (drop !== null) {
        await putOnWaivers(ctx.repos, {
          leagueId: team.leagueId,
          playerId: drop.id,
          teamId: team.id,
          droppedAt: now,
          clearsAt: waiverClearsAt(access.league.settings, { droppedAt: now })
        });
      }
      await ctx.repos.waivers.addTransactions([
        {
          id: randomUUID(),
          leagueId: team.leagueId,
          at: now.toISOString(),
          week: access.league.week ?? access.league.settings.schedule.startWeek,
          type: 'add',
          teamId: team.id,
          addPlayerId: player.id,
          dropPlayerId: drop?.id ?? null,
          cost: null,
          claimId: null
        }
      ]);
      if (input.bid > 0) {
        warnings.push({
          code: 'FAAB_NOT_CHARGED',
          message: `${player.name} was a free agent, so the $${input.bid} bid was not needed and nothing was charged.`
        });
      }
      return withWarnings(
        {
          outcome: 'added' as const,
          player: toPlayerRef(player),
          dropped: drop === null ? null : toPlayerRef(drop),
          claim: null,
          faabRemaining: updated.faabRemaining
        },
        warnings
      );
    }

    const pending = (await ctx.repos.waivers.listClaims(team.leagueId, 'pending')).filter(
      (c) => c.teamId === team.id
    );
    const claim: WaiverClaimRecord = {
      id: randomUUID(),
      leagueId: team.leagueId,
      teamId: team.id,
      addPlayerId: player.id,
      dropPlayerId: drop?.id ?? null,
      bid: plan.bid,
      priority: input.priority ?? Math.max(0, ...pending.map((c) => c.priority)) + 1,
      status: 'pending',
      week: access.league.week ?? access.league.settings.schedule.startWeek,
      processesAt: plan.processesAt ?? now.toISOString(),
      createdAt: now.toISOString(),
      createdBy: principalKey(ctx.principal),
      resolvedAt: null,
      failure: null,
      cost: null,
      awardingRunId: null,
      version: 1
    };
    await ctx.repos.waivers.createClaim(claim);
    warnings.push({
      code: 'WAIVER_CLAIM_QUEUED',
      message: `${player.name} is on waivers until ${plan.clearsAt ?? ''}. Claim queued with a $${plan.bid} bid; it is processed at ${claim.processesAt}.`
    });
    const refs = await playerRefs(ctx, [claim.addPlayerId, claim.dropPlayerId]);
    return withWarnings(
      {
        outcome: 'claim_pending' as const,
        player: toPlayerRef(player),
        dropped: claim.dropPlayerId === null ? null : refOf(refs, claim.dropPlayerId),
        claim: claimView(claim, access.teams, refs),
        faabRemaining: team.faabRemaining
      },
      warnings
    );
  }
});

const IssueSchema = z.object({ code: z.string(), message: z.string(), fix: z.string() });

export const previewWaiverClaim = defineOperation({
  name: 'preview_waiver_claim',
  method: 'GET',
  path: '/leagues/{leagueId}/waivers/preview',
  summary: 'Check a pickup before making it: would it succeed, and what does the roster become?',
  description: [
    'A dry run of claim_waiver with the same inputs. Returns whether the claim would be accepted right now (`wouldSucceed`), whether it would add the player immediately (`add_now`, a free agent) or queue a claim (`claim_pending`, on waivers) and when that runs, the problems that would stop it (`issues`, each with a fix), your current roster, the roster after the move, and your FAAB before and after a winning bid.',
    'Use it to pick a drop player: `currentRoster` lists everyone you could release. Nothing changes.'
  ].join(' '),
  tags: ['waivers'],
  mutation: false,
  input: ClaimInput.omit({ priority: true }),
  output: z.object({
    wouldSucceed: z.boolean(),
    outcome: z.enum(['add_now', 'claim_pending', 'blocked']),
    player: PlayerRefSchema,
    drop: PlayerRefSchema.nullable(),
    issues: z
      .array(IssueSchema)
      .describe('Why the claim would be refused, with fixes. Empty when it would succeed.'),
    processesAt: z.string().nullable().describe('When a pending claim would be processed.'),
    currentRoster: z.array(PlayerRefSchema),
    resultingRoster: z.array(PlayerRefSchema).describe('Your roster if the move goes through.'),
    faabRemaining: z.number().int(),
    faabAfter: z.number().int().describe('FAAB left if the claim wins at this bid.')
  }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const team = actingTeam(access, input.teamId);
    const player = await ctx.data.players.resolve(input);
    const drop = await resolveDrop(ctx, input);
    const issues: z.infer<typeof IssueSchema>[] = [];
    let outcome: 'add_now' | 'claim_pending' | 'blocked' = 'blocked';
    let processesAt: string | null = null;
    let cost = 0;
    try {
      assertAction('claim_waiver', access.league, access.actor, now);
      const plan = await planClaim(ctx, access, team, { player, drop, bid: input.bid }, now);
      outcome = plan.kind;
      processesAt = plan.processesAt;
      cost = plan.bid;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      issues.push({ code: error.code, message: error.message, fix: error.fix });
    }
    const refs = await playerRefs(ctx, [...team.roster, player.id]);
    const after = team.roster.filter((id) => id !== drop?.id);
    if (!after.includes(player.id)) after.push(player.id);
    return {
      wouldSucceed: issues.length === 0,
      outcome,
      player: toPlayerRef(player),
      drop: drop === null ? null : toPlayerRef(drop),
      issues,
      processesAt,
      currentRoster: team.roster.map((id) => refOf(refs, id)),
      resultingRoster: after.map((id) => refOf(refs, id)),
      faabRemaining: team.faabRemaining,
      faabAfter: team.faabRemaining - cost
    };
  }
});
