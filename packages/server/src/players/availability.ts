import { z } from 'zod';
import type { Ctx } from '../context.js';
import type { Warning } from '../registry/operation.js';
import type { Player } from './model.js';

export const AVAILABILITY = ['free_agent', 'waivers', 'rostered'] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const AvailabilitySchema = z
  .enum(AVAILABILITY)
  .describe(
    'League availability filter (needs `leagueId`): `free_agent` (can be added now), `waivers` (claimable through waivers), or `rostered` (on a team). Not applied until league rosters exist; the response then carries an AVAILABILITY_NOT_APPLIED warning.'
  );

/**
 * The hook that filters players by availability in a league. League rosters and the `OWN#`
 * ownership locks do not exist yet, so for now it returns the players unchanged with an
 * AVAILABILITY_NOT_APPLIED warning. When rosters land, this is the one place to implement it
 * (a GetItem per `OWN#<playerId>` or one query of the league's rosters), and every caller
 * (search_players today, get_projections and get_trending_players later) gets it for free.
 */
export async function applyAvailability(
  _ctx: Ctx,
  players: Player[],
  filter: { leagueId: string; availability: Availability }
): Promise<{ players: Player[]; warnings: Warning[] }> {
  return {
    players,
    warnings: [
      {
        code: 'AVAILABILITY_NOT_APPLIED',
        message: `The "${filter.availability}" filter is not applied yet because league rosters do not exist; results include every matching player. Check each player's status in league ${filter.leagueId} before acting.`
      }
    ]
  };
}
