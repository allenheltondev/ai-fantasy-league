import {
  AGENT_TEAM_NAME,
  AvatarSeedSchema,
  agentMayRename,
  teamNameIssue,
  type NameSetBy
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireMember, requireTeamOwner, type LeagueAccess } from '../../league/access.js';
import { isAgentPlayed, leagueManagers } from '../../league/managers.js';
import { assertAction } from '../../league/phase.js';
import { renamedTeam, sameTeamName, teamNameSetBy } from '../../league/seats.js';
import type { Team, TeamRename } from '../../repos/types.js';
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
    `An AI manager naming its own team picks a real name of ${AGENT_TEAM_NAME.min}-${AGENT_TEAM_NAME.max} characters: not a placeholder like "Team 3", no slurs or strong profanity, and no other manager's name in it (INVALID_INPUT, with a fix, otherwise). It cannot change a name the commissioner locked, or rename at all when its seat does not let it name its team (FORBIDDEN).`,
    "The commissioner's rename of an AI manager's seat is locked unless that seat lets its manager name its team (configure_agent_seat `namesTeam`). Every rename is kept in the team's history (`renamedFrom`) and shows on the league's move board.",
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
    const by: TeamRename['by'] =
      access.actor.kind === 'agent' ? 'agent' : team.ownerUserId !== null ? 'owner' : 'commissioner';
    const nameSetBy =
      name === undefined || name === team.name
        ? teamNameSetBy(team)
        : await checkName(ctx, access, team, name, by);
    const next = {
      ...(name === undefined
        ? team
        : renamedTeam(team, { to: name, by, at: now.toISOString(), week: leagueWeek(access) }, nameSetBy)),
      ...(avatarSeed === undefined ? {} : { avatarSeed })
    };
    if (next.name === team.name && next.avatarSeed === team.avatarSeed) return { team: teamDetail(team) };
    const updated = await ctx.repos.teams.update({ ...next, updatedAt: now.toISOString() });
    if (updated.name !== team.name) {
      await ctx.events.publish('Team Renamed', {
        leagueId: access.league.id,
        teamId: team.id,
        from: team.name,
        to: updated.name,
        by
      });
    }
    return { team: teamDetail(updated) };
  }
});

/** The week a rename is filed under: the league's week, or its first week before the season. */
function leagueWeek(access: LeagueAccess): number {
  return access.league.week ?? access.league.settings.schedule.startWeek;
}

/**
 * Checks a new name against who is renaming, and says who the name now belongs to (#194). An AI
 * manager must be allowed to name its team and must pick a real name (core `teamNameIssue`). The
 * commissioner's name for an AI manager's seat is locked, unless the seat lets its manager name its
 * team: then it goes back to `default`, the manager's to keep or change.
 */
async function checkName(
  ctx: Ctx,
  access: LeagueAccess,
  team: Team,
  name: string,
  by: TeamRename['by']
): Promise<NameSetBy> {
  if (by === 'owner') return 'owner';
  const seat = isAgentPlayed(team) ? await ctx.repos.agents.getSeat(access.league.id, team.id) : null;
  if (by === 'commissioner')
    return seat !== null && seat.config.namesTeam !== false ? 'default' : 'commissioner';
  if (!agentMayRename(seat?.config, teamNameSetBy(team))) {
    throw new ApiError('FORBIDDEN', `You cannot rename "${team.name}".`, {
      fix:
        seat?.config.namesTeam === false
          ? 'Your seat does not let you name your team. Keep the name you have.'
          : 'The commissioner picked this name and it stays. Keep it, and make it famous.'
    });
  }
  const managers = await leagueManagers(ctx, access.league.id, access.teams);
  const issue = teamNameIssue(name, {
    self: { managerName: managers.get(team.id)?.name ?? null },
    others: access.teams
      .filter((t) => t.id !== team.id)
      .map((t) => ({ name: t.name, managerName: managers.get(t.id)?.name ?? t.ownerName }))
  });
  if (issue !== null) {
    throw new ApiError(issue.code === 'taken' ? 'CONFLICT' : 'INVALID_INPUT', issue.message, {
      fix: issue.fix,
      details: { reason: issue.code }
    });
  }
  return 'agent';
}
