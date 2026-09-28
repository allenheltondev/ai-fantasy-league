import { randomUUID } from 'node:crypto';
import { waiverClearsAt } from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireMember } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { PlayerRefSchema, playerSelectorShape, toPlayerRef } from '../../players/model.js';
import { defineOperation } from '../../registry/operation.js';
import { changeRoster, putOnWaivers } from '../../waivers/rosters.js';
import { actingTeam, TeamIdField } from './shared.js';

export const dropPlayer = defineOperation({
  name: 'drop_player',
  method: 'POST',
  path: '/leagues/{leagueId}/drops',
  summary: 'Release a player from your roster',
  description: [
    'Releases a player from your roster. He goes on waivers for the league waiver period (`waivers.waiverPeriodDays`, 2 days by default) and becomes a free agent at `clearsAt`; until then other teams can only claim him with a FAAB bid.',
    'To swap a player for a pickup in one move, use claim_waiver with `dropPlayerId` instead. PLAYER_NOT_ON_ROSTER means he is not on your team.'
  ].join(' '),
  tags: ['waivers'],
  mutation: true,
  input: z.object({ leagueId: LeagueIdSchema, teamId: TeamIdField, ...playerSelectorShape }),
  output: z.object({
    dropped: PlayerRefSchema,
    clearsAt: z.string().describe('When he clears waivers and becomes a free agent (ISO 8601).'),
    rosterSize: z.number().int()
  }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const team = actingTeam(access, input.teamId);
    assertAction('drop_player', access.league, access.actor, now);
    const player = await ctx.data.players.resolve(input);
    if (!team.roster.includes(player.id)) {
      throw new ApiError('PLAYER_NOT_ON_ROSTER', `${player.name} is not on your roster.`, {
        fix: `Pick one of your players: ${team.roster.join(', ') || '(your roster is empty)'}.`,
        details: { playerId: player.id }
      });
    }
    const updated = await changeRoster(ctx.repos, team, { drop: player.id }, now);
    const clearsAt = waiverClearsAt(access.league.settings, { droppedAt: now });
    await putOnWaivers(ctx.repos, {
      leagueId: team.leagueId,
      playerId: player.id,
      teamId: team.id,
      droppedAt: now,
      clearsAt
    });
    await ctx.repos.waivers.addTransactions([
      {
        id: randomUUID(),
        leagueId: team.leagueId,
        at: now.toISOString(),
        week: access.league.week ?? access.league.settings.schedule.startWeek,
        type: 'drop',
        teamId: team.id,
        addPlayerId: null,
        dropPlayerId: player.id,
        cost: null,
        claimId: null
      }
    ]);
    return { dropped: toPlayerRef(player), clearsAt, rosterSize: updated.roster.length };
  }
});
