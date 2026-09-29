import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireMember, type LeagueAccess } from '../league/access.js';
import { weekLocks } from '../season/lineups.js';
import { leaguePlayers, type PlayerStanding } from '../waivers/rosters.js';
import type { Player } from './model.js';

export const AVAILABILITY = ['free_agent', 'waivers', 'rostered'] as const;
export type Availability = (typeof AVAILABILITY)[number];

/** The filter values: each standing, plus `available` (free agent or on waivers: not rostered). */
export const AVAILABILITY_FILTERS = [...AVAILABILITY, 'available'] as const;
export type AvailabilityFilter = (typeof AVAILABILITY_FILTERS)[number];

export const AvailabilitySchema = z
  .enum(AVAILABILITY_FILTERS)
  .describe(
    'League availability filter (needs `leagueId`): `free_agent` (add now with claim_waiver), `waivers` (recently dropped, undrafted right after the draft, or his game this week has kicked off; claim_waiver queues a claim that is processed when he clears), `available` (either of those: anyone not on a team), or `rostered` (on a team; only a trade can get him).'
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
  filter: { leagueId: string; availability?: AvailabilityFilter | undefined }
): Promise<{ players: Player[]; standingOf: StandingOf }> {
  const standingOf = await leagueStandings(ctx, await requireMember(ctx, filter.leagueId));
  const wanted = filter.availability;
  return {
    players:
      wanted === undefined ? players : players.filter((p) => matchesAvailability(standingOf(p), wanted)),
    standingOf
  };
}

export type StandingOf = (player: Pick<Player, 'id' | 'team'>) => PlayerStanding;

/** Where each player stands in the league right now (the caller has checked membership). */
export async function leagueStandings(
  ctx: Ctx,
  access: Pick<LeagueAccess, 'league' | 'teams'>
): Promise<StandingOf> {
  const now = ctx.clock.now();
  const locks = await weekLocks(ctx.data.reference, access.league, now);
  const standings = await leaguePlayers(ctx.repos, access.league, access.teams, now, locks);
  return (p) => standings.standing(p.id, p.team);
}

/** Whether a standing passes an availability filter (`available`: anyone not on a team). */
export function matchesAvailability(standing: PlayerStanding, wanted: AvailabilityFilter): boolean {
  return wanted === 'available' ? standing.status !== 'rostered' : standing.status === wanted;
}
