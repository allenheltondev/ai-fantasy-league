import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireCommissioner } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema, TeamDetailSchema, teamDetail } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { releaseSeat } from './leave-league.js';

export const removeMember = defineOperation({
  name: 'remove_member',
  method: 'DELETE',
  path: '/leagues/{leagueId}/members/{userId}',
  summary: 'Remove a person from the league (commissioner only, before the draft)',
  description: [
    "Removes a person from the league: their seat goes back to an agent and they lose access. Get the `userId` from a team's `ownerUserId` in get_league.",
    'Only the commissioner can remove members, only while the league is in setup, and not themselves (use transfer_commissioner, or delete_league). Revoke the invite they used (revoke_invite) if they should not rejoin.'
  ].join(' '),
  tags: ['leagues'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    userId: z.string().min(1).max(128).describe("The member's user id (a team's ownerUserId).")
  }),
  output: z.object({
    leagueId: z.string(),
    seat: TeamDetailSchema.describe('The freed seat, now an agent seat.')
  }),
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    assertAction('remove_member', access.league, access.actor, ctx.clock.now());
    if (input.userId === access.league.commissionerId) {
      throw new ApiError('FORBIDDEN', 'The commissioner cannot remove themselves.', {
        fix: 'Hand the league to another member with transfer_commissioner first, or delete it with delete_league.'
      });
    }
    const team = access.teams.find((t) => t.ownerUserId === input.userId);
    if (team === undefined) {
      throw new ApiError('NOT_FOUND', `User "${input.userId}" does not hold a seat in this league.`, {
        fix: "Use a team's ownerUserId from get_league."
      });
    }
    const seat = await releaseSeat(ctx, access.league, team, input.userId, 'removed');
    return { leagueId: access.league.id, seat: teamDetail(seat) };
  }
});
