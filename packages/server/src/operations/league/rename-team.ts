import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireMember, requireTeamOwner } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { sameTeamName } from '../../league/seats.js';
import {
  LeagueIdSchema,
  TeamDetailSchema,
  teamDetail,
  TeamIdSchema,
  TeamNameSchema
} from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const renameTeam = defineOperation({
  name: 'rename_team',
  method: 'PUT',
  path: '/leagues/{leagueId}/teams/{teamId}/name',
  summary: 'Rename a team',
  description: [
    "Renames a team. You can rename your own team; an agent can rename the team it plays; the commissioner can also rename seats no person holds (agent seats and open seats). Anyone else's team returns FORBIDDEN.",
    'Names are 1-40 characters and must be unique in the league, ignoring case and extra spaces (CONFLICT otherwise). Allowed until the league is complete.'
  ].join(' '),
  tags: ['leagues'],
  mutation: true,
  input: z.object({ leagueId: LeagueIdSchema, teamId: TeamIdSchema, name: TeamNameSchema }),
  output: z.object({ team: TeamDetailSchema }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const now = ctx.clock.now();
    const team = requireTeamOwner(access, input.teamId, { commissionerForUnowned: true });
    assertAction('rename_team', access.league, access.actor, now);
    if (access.teams.some((t) => t.id !== team.id && sameTeamName(t.name, input.name))) {
      throw new ApiError('CONFLICT', `Another team is already named "${input.name}".`, {
        fix: 'Pick a different name.'
      });
    }
    if (team.name === input.name) return { team: teamDetail(team) };
    const updated = await ctx.repos.teams.update({ ...team, name: input.name, updatedAt: now.toISOString() });
    return { team: teamDetail(updated) };
  }
});
