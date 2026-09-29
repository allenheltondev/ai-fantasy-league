import { waiverRunAtOrAfter } from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireTeamOwner, type LeagueAccess } from '../../league/access.js';
import { actorTeam } from '../../league/phase.js';
import { PlayerRefSchema, toPlayerRef, type Player, type PlayerRef } from '../../players/model.js';
import type { Team } from '../../repos/types.js';
import { WAIVER_CLAIM_STATUSES, type WaiverClaimRecord } from '../../repos/waivers.js';
import { assertNotLocked, resolveLineup, weekLocks, type WeekLocks } from '../../season/lineups.js';
import { assertNotInProcessingTrade } from '../../trades/lifecycle.js';
import { acquisitionsThisWeek, leaguePlayers, openSpots } from '../../waivers/rosters.js';

export const TeamIdField = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('Your team id. Defaults to the team you manage; you can only act for your own team.');

export const dropSelectorShape = {
  dropPlayerId: z
    .string()
    .min(1)
    .optional()
    .describe('The player to release if the add goes through. Required when your roster is full.'),
  dropPlayer: z.string().min(1).optional().describe('The drop player by name, when you do not have the id.')
};

export const BidField = z
  .number()
  .int()
  .min(0)
  .max(1000)
  .default(0)
  .describe(
    'Whole-dollar FAAB bid for a player on waivers (default 0). The highest bid wins; ties go to waiver priority. Ignored for free agents (they cost nothing) and under rolling waivers.'
  );

export const ClaimViewSchema = z.object({
  id: z.string().describe('Claim id; pass it to cancel_waiver_claim or reorder_waiver_claims.'),
  teamId: z.string(),
  teamName: z.string(),
  player: PlayerRefSchema,
  drop: PlayerRefSchema.nullable(),
  bid: z.number().int(),
  priority: z.number().int().describe("The team's own order for its claims: 1 is processed first."),
  status: z.enum(WAIVER_CLAIM_STATUSES),
  processesAt: z.string().describe('The waiver run that will process the claim (ISO 8601).'),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  cost: z.number().int().nullable().describe('FAAB paid, when awarded.'),
  failure: z
    .object({ code: z.string(), message: z.string(), fix: z.string() })
    .nullable()
    .describe('Why a failed claim lost, e.g. PLAYER_CLAIMED (outbid) or ROSTER_FULL.')
});
export type ClaimView = z.infer<typeof ClaimViewSchema>;

/** Player refs by id, for response views. */
export async function playerRefs(ctx: Ctx, ids: readonly (string | null)[]): Promise<Map<string, PlayerRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const players = await ctx.repos.players.getMany(wanted);
  return new Map(players.map((p) => [p.id, toPlayerRef(p)]));
}

/** A player's ref, or a bare one for an id missing from the player universe. */
export function refOf(refs: ReadonlyMap<string, PlayerRef>, id: string): PlayerRef {
  return refs.get(id) ?? { id, name: id, team: null, position: 'WR' };
}

export function claimView(
  claim: WaiverClaimRecord,
  teams: readonly Team[],
  refs: ReadonlyMap<string, PlayerRef>
): ClaimView {
  return {
    id: claim.id,
    teamId: claim.teamId,
    teamName: teams.find((t) => t.id === claim.teamId)?.name ?? claim.teamId,
    player: refOf(refs, claim.addPlayerId),
    drop: claim.dropPlayerId === null ? null : refOf(refs, claim.dropPlayerId),
    bid: claim.bid,
    priority: claim.priority,
    status: claim.status,
    processesAt: claim.processesAt,
    createdAt: claim.createdAt,
    resolvedAt: claim.resolvedAt,
    cost: claim.cost,
    failure: claim.failure
  };
}

/** The team the caller acts for: `teamId` if they own it, else the team they manage. */
export function actingTeam(access: LeagueAccess, teamId: string | undefined): Team {
  if (teamId !== undefined) return requireTeamOwner(access, teamId);
  const team = actorTeam(access.actor);
  if (team === null) {
    throw new ApiError('FORBIDDEN', 'You do not manage a team in this league.', {
      fix: 'Only a team in this league can do this. Join with an invite link first (join_league).'
    });
  }
  return team;
}

/** Resolves the optional drop player. */
export async function resolveDrop(
  ctx: Ctx,
  input: { dropPlayerId?: string | undefined; dropPlayer?: string | undefined }
): Promise<Player | null> {
  if (input.dropPlayerId === undefined && input.dropPlayer === undefined) return null;
  return ctx.data.players.resolve({ playerId: input.dropPlayerId, player: input.dropPlayer });
}

export interface ClaimPlan {
  /** `add_now`: a free agent joins the roster immediately. `claim_pending`: he is on waivers. */
  kind: 'add_now' | 'claim_pending';
  /** When the player clears waivers (claims only). */
  clearsAt: string | null;
  /** The waiver run that will process the claim (claims only). */
  processesAt: string | null;
  /** The bid that will be recorded (0 for free agents and rolling waivers). */
  bid: number;
}

/**
 * Checks whether `team` can add `player` (dropping `drop`) right now, and how: at once (a free
 * agent) or as a pending claim (on waivers). Throws the first problem as an ApiError with a fix.
 * claim_waiver and preview_waiver_claim both use it, so a preview says exactly what a claim will do.
 */
export async function planClaim(
  ctx: Ctx,
  access: LeagueAccess,
  team: Team,
  input: { player: Player; drop: Player | null; bid: number },
  now: Date,
  /** The pending claim being edited (update_waiver_claim): it is not a duplicate of itself. */
  editing: string | null = null
): Promise<ClaimPlan> {
  const { league, teams } = access;
  const { player, drop } = input;
  const settings = league.settings;
  const locks = await weekLocks(ctx.data.reference, league, now);
  const standings = await leaguePlayers(ctx.repos, league, teams, now, locks);
  const standing = standings.standing(player.id, player.team);
  if (standing.status === 'rostered') {
    const owner = teams.find((t) => t.id === standing.teamId);
    throw new ApiError(
      'PLAYER_NOT_AVAILABLE',
      standing.teamId === team.id
        ? `${player.name} is already on your roster.`
        : `${player.name} is on ${owner?.name ?? standing.teamId}'s roster.`,
      {
        fix:
          standing.teamId === team.id
            ? 'Pick a player who is not on your roster.'
            : 'Only free agents and players on waivers can be claimed. Find one with search_players (availability "free_agent" or "waivers"), or trade for this player.',
        details: { playerId: player.id, teamId: standing.teamId }
      }
    );
  }
  if (drop !== null && !team.roster.includes(drop.id)) {
    throw new ApiError('DROP_PLAYER_NOT_ON_ROSTER', `${drop.name} is not on your roster.`, {
      fix: `Set dropPlayerId to a player on your roster: ${team.roster.join(', ') || '(your roster is empty)'}.`,
      details: { dropPlayerId: drop.id }
    });
  }
  await assertNotInProcessingTrade(ctx.repos, league.id, [drop?.id ?? null]);
  const lineup = await resolveLineup(ctx.repos, team, league.week ?? settings.schedule.startWeek);
  if (openSpots(settings, lineup.entries, drop?.id ?? null) < 1) {
    const refs = await playerRefs(ctx, team.roster);
    const droppable = lineup.entries
      .filter((e) => e.slot !== 'IR')
      .map((e) => refOf(refs, e.playerId))
      .filter((p) => !locks.isLocked(p));
    throw new ApiError('ROSTER_FULL', `Your roster is full (${team.roster.length} players).`, {
      fix: `Include dropPlayerId with one of: ${droppable.map((p) => `${p.id} (${p.name}, ${p.position})`).join(', ')}.`,
      details: { droppable }
    });
  }
  if (standing.status === 'waivers') {
    const faab = settings.waivers.type === 'faab';
    const bid = faab ? input.bid : 0;
    if (faab && bid === 0 && !settings.waivers.allowZeroBids) {
      throw new ApiError('ZERO_BID_NOT_ALLOWED', 'This league does not allow $0 bids.', {
        fix: 'Bid at least $1.'
      });
    }
    if (bid > team.faabRemaining) {
      throw new ApiError(
        'INSUFFICIENT_FAAB',
        `Bid $${bid} is more than your $${team.faabRemaining} FAAB left.`,
        {
          fix: `Bid $${team.faabRemaining} or less.`,
          details: { bid, faabRemaining: team.faabRemaining }
        }
      );
    }
    const duplicate = (await ctx.repos.waivers.listClaims(league.id, 'pending')).find(
      (c) => c.teamId === team.id && c.addPlayerId === player.id && c.id !== editing
    );
    if (duplicate !== undefined) {
      throw new ApiError('DUPLICATE_WAIVER_CLAIM', `You already have a pending claim for ${player.name}.`, {
        fix: `Cancel claim ${duplicate.id} with cancel_waiver_claim first if you want to change the bid or drop.`,
        details: { claimId: duplicate.id }
      });
    }
    const processesAt = waiverRunAtOrAfter(standing.clearsAt);
    if (drop !== null && lockedAt(locks, drop, processesAt)) {
      throw new ApiError(
        'PLAYER_LOCKED',
        `${drop.name} will be locked when this claim runs at ${processesAt}: his game kicks off first.`,
        {
          fix: `Pick a drop player whose game this week starts after ${processesAt}, or claim again after the week rolls over.`,
          details: { playerId: drop.id, processesAt }
        }
      );
    }
    return { kind: 'claim_pending', clearsAt: standing.clearsAt, processesAt, bid };
  }
  if (drop !== null) assertNotLocked(locks, drop);
  const max = settings.waivers.maxAcquisitionsPerWeek;
  if (max !== null && ((await acquisitionsThisWeek(ctx.repos, league, now)).get(team.id) ?? 0) >= max) {
    throw new ApiError('ACQUISITION_LIMIT_REACHED', `You have used all ${max} adds for this week.`, {
      fix: 'Wait for next week, when the limit resets.',
      details: { limit: max }
    });
  }
  return { kind: 'add_now', clearsAt: null, processesAt: null, bid: 0 };
}

/**
 * Whether a claim's drop player will still be locked when the claim runs at `processesAt`: his game
 * has kicked off by then and the week is not over yet (locks lift at the rollover).
 */
function lockedAt(locks: WeekLocks, player: Player, processesAt: string): boolean {
  const kickoff = locks.kickoff(player);
  const at = Date.parse(processesAt);
  return (
    locks.isLocked(player) ||
    (kickoff !== null && kickoff.getTime() <= at && locks.endsAt !== null && at < Date.parse(locks.endsAt))
  );
}
