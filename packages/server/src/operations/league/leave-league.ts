import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { requireMember } from '../../league/access.js';
import { actorTeam, assertAction } from '../../league/phase.js';
import { vacateSeat } from '../../league/seats.js';
import { LeagueIdSchema, TeamDetailSchema, teamDetail } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import type { League, Team } from '../../repos/types.js';

export const leaveLeague = defineOperation({
  name: 'leave_league',
  method: 'POST',
  path: '/leagues/{leagueId}/leave',
  summary: 'Give up your seat in a league (before the draft)',
  description: [
    'Leaves the league: your seat goes back to an agent (named "Team <slot>") and you lose access to the league. Only possible while the league is in setup; after the draft starts you keep your team for the season.',
    'The commissioner cannot leave: hand the league to another member with transfer_commissioner first, or delete it with delete_league.'
  ].join(' '),
  tags: ['leagues'],
  mutation: true,
  auth: 'user',
  input: z.object({ leagueId: LeagueIdSchema }),
  output: z.object({
    leagueId: z.string(),
    seat: TeamDetailSchema.describe('The seat you left, now an agent seat.')
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    assertAction('leave_league', access.league, access.actor, ctx.clock.now());
    // assertAction only lets a person who holds a seat through.
    const team = actorTeam(access.actor) as Team;
    const seat = await releaseSeat(ctx, access.league, team, team.ownerUserId as string, 'left');
    return { leagueId: access.league.id, seat: teamDetail(seat) };
  }
});

/** Turns a person's seat back into an agent seat, drops the membership, and announces it. */
export async function releaseSeat(
  ctx: Ctx,
  league: League,
  team: Team,
  userId: string,
  reason: 'left' | 'removed'
): Promise<Team> {
  const seat = await ctx.repos.teams.update(vacateSeat(team, ctx.clock.now()));
  await ctx.repos.members.remove(league.id, userId);
  await ctx.events.publish('Member Left', { leagueId: league.id, userId, teamId: team.id, reason });
  return seat;
}
