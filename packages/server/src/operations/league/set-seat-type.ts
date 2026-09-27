import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireCommissioner, requireTeam } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema, TeamDetailSchema, teamDetail, TeamIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { SEAT_TYPES } from '../../repos/types.js';

export const setSeatType = defineOperation({
  name: 'set_seat_type',
  method: 'PUT',
  path: '/leagues/{leagueId}/teams/{teamId}/seat-type',
  summary: 'Make an open seat a human seat or an agent seat (commissioner only)',
  description: [
    'Decides who will play an open seat. `human` keeps the seat open for a person you invite (create_invite); people joining take open human seats before agent seats. `agent` gives it to an AI agent, which a person joining can still take if no human seat is open.',
    'Only seats nobody holds can change: remove_member first to free a taken seat. Only the commissioner can do this, while the league is in setup. Setting the type a seat already has succeeds and changes nothing.'
  ].join(' '),
  tags: ['leagues'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdSchema,
    seatType: z.enum(SEAT_TYPES).describe('`human` (kept open for an invitee) or `agent`.')
  }),
  output: z.object({ team: TeamDetailSchema }),
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    const now = ctx.clock.now();
    assertAction('set_seat_type', access.league, access.actor, now);
    const team = requireTeam(access, input.teamId);
    if (team.ownerUserId !== null) {
      throw new ApiError('CONFLICT', `"${team.name}" is held by a member.`, {
        fix: 'Only open seats can change type. Use remove_member to free the seat first.'
      });
    }
    if (team.seatType === input.seatType) return { team: teamDetail(team) };
    const updated = await ctx.repos.teams.update({
      ...team,
      seatType: input.seatType,
      updatedAt: now.toISOString()
    });
    return { team: teamDetail(updated) };
  }
});
