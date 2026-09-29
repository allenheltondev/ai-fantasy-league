import { AvatarSeedSchema } from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireMember, requireTeamOwner } from '../../league/access.js';
import { isAgentPlayed } from '../../league/managers.js';
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
  summary: 'Rename a team or change its avatar',
  description: [
    "Sets a team's profile: its name, its avatar, or both. You can change your own team; an agent can rename the team it plays; the commissioner can also rename seats no person holds (agent seats and open seats). Anyone else's team returns FORBIDDEN.",
    'Names are 1-40 characters and must be unique in the league, ignoring case and extra spaces (CONFLICT otherwise).',
    "`avatarSeed` picks the avatar picture of a team a person holds; an AI manager's avatar belongs to its seat (configure_agent_seat). Send at least one of `name` and `avatarSeed`. Allowed until the league is complete."
  ].join(' '),
  tags: ['leagues'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdSchema,
    name: TeamNameSchema.optional(),
    avatarSeed: AvatarSeedSchema.optional().describe(
      'New seed for the team\'s avatar picture (1-40 letters, digits, "-" or "_"); any new seed draws a new picture. Only for a team a person holds.'
    )
  }),
  output: z.object({ team: TeamDetailSchema }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const now = ctx.clock.now();
    const team = requireTeamOwner(access, input.teamId, { commissionerForUnowned: true });
    assertAction('rename_team', access.league, access.actor, now);
    const { name, avatarSeed } = input;
    if (name === undefined && avatarSeed === undefined) {
      throw new ApiError(
        'INVALID_INPUT',
        'Nothing to change: the request has neither a name nor an avatarSeed.',
        {
          fix: 'Send `name` to rename the team, `avatarSeed` to change its avatar, or both.'
        }
      );
    }
    if (avatarSeed !== undefined && (team.ownerUserId === null || isAgentPlayed(team))) {
      throw new ApiError('INVALID_INPUT', 'Only a team a person holds has an avatar of its own.', {
        fix: "Leave out avatarSeed. An AI manager's avatar belongs to its seat: change it with configure_agent_seat."
      });
    }
    if (name !== undefined && access.teams.some((t) => t.id !== team.id && sameTeamName(t.name, name))) {
      throw new ApiError('CONFLICT', `Another team is already named "${name}".`, {
        fix: 'Pick a different name.'
      });
    }
    const next = { ...team, name: name ?? team.name, ...(avatarSeed === undefined ? {} : { avatarSeed }) };
    if (next.name === team.name && next.avatarSeed === team.avatarSeed) return { team: teamDetail(team) };
    const updated = await ctx.repos.teams.update({ ...next, updatedAt: now.toISOString() });
    return { team: teamDetail(updated) };
  }
});
