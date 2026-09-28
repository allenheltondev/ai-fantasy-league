import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireMember } from '../league/access.js';
import { leaguePlayers, type PlayerStanding } from '../waivers/rosters.js';
import type { Player } from './model.js';

export const AVAILABILITY = ['free_agent', 'waivers', 'rostered'] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const AvailabilitySchema = z
  .enum(AVAILABILITY)
  .describe(
    'League availability filter (needs `leagueId`): `free_agent` (add now with claim_waiver), `waivers` (recently dropped; claim_waiver queues a claim that is processed when he clears), or `rostered` (on a team; only a trade can get him).'
  );

/** How many players to search before filtering by availability, so filters still fill a page. */
export const AVAILABILITY_SEARCH_POOL = 400;

export const StandingSchema = z
  .object({
    status: z.enum(AVAILABILITY),
    teamId: z.string().optional().describe('The team rostering him (status `rostered`).'),
    clearsAt: z
      .string()
      .optional()
      .describe('When he clears waivers and becomes a free agent (status `waivers`).')
  })
  .describe('Where the player stands in the league. Present when `leagueId` is passed.');

export function standingView(s: PlayerStanding): z.infer<typeof StandingSchema> {
  if (s.status === 'rostered') return { status: 'rostered', teamId: s.teamId };
  if (s.status === 'waivers') return { status: 'waivers', clearsAt: s.clearsAt };
  return { status: 'free_agent' };
}

/**
 * Filters players by where they stand in a league: on a roster, on waivers, or a free agent. League
 * data is members-only, so this checks the caller belongs to the league. `standingOf` is returned
 * too, so callers can show each player's status.
 */
export async function applyAvailability(
  ctx: Ctx,
  players: Player[],
  filter: { leagueId: string; availability?: Availability | undefined }
): Promise<{ players: Player[]; standingOf: (playerId: string) => PlayerStanding }> {
  const { league, teams } = await requireMember(ctx, filter.leagueId);
  const standings = await leaguePlayers(ctx.repos, league.id, teams, ctx.clock.now());
  const wanted = filter.availability;
  return {
    players:
      wanted === undefined ? players : players.filter((p) => standings.standing(p.id).status === wanted),
    standingOf: (playerId) => standings.standing(playerId)
  };
}
