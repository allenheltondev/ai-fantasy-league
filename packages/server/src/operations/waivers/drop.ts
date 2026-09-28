import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireMember } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { PlayerRefSchema, playerSelectorShape, toPlayerRef } from '../../players/model.js';
import { defineOperation } from '../../registry/operation.js';
import { assertNotLocked, weekLocks } from '../../season/lineups.js';
import { assertNotInProcessingTrade, voidStaleOffers } from '../../trades/lifecycle.js';
import { changeRoster, putOnWaivers } from '../../waivers/rosters.js';
import { actingTeam, TeamIdField } from './shared.js';

export const dropPlayer = defineOperation({
  name: 'drop_player',
  method: 'POST',
  path: '/leagues/{leagueId}/drops',
  summary: 'Release a player from your roster',
  description: [
    'Releases a player from your roster. He goes on waivers for the league waiver period (`waivers.waiverPeriodDays`, 2 days by default, rounded up to the next daily waiver run) and becomes a free agent at `clearsAt`; until then other teams can only claim him with a FAAB bid.',
    'A player whose game this week has kicked off is locked and cannot be dropped until the week rolls over (PLAYER_LOCKED; get_roster shows `locked`).',
    'To swap a player for a pickup in one move, use claim_waiver with `dropPlayerId` instead. PLAYER_NOT_ON_ROSTER means he is not on your team; PLAYER_IN_TRADE means he is leaving in a trade that is being processed right now.',
    'Open trade offers that include him are cancelled (they no longer work).'
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
    assertNotLocked(await weekLocks(ctx.data.reference, access.league, now), player);
    await assertNotInProcessingTrade(ctx.repos, access.league.id, [player.id]);
    const updated = await changeRoster(ctx.repos, team, { drop: player.id }, now);
    const clearsAt = await putOnWaivers(ctx.repos, access.league.settings, {
      leagueId: team.leagueId,
      playerId: player.id,
      teamId: team.id,
      droppedAt: now
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
    await voidStaleOffers(ctx, access.league, [player.id], now);
    return { dropped: toPlayerRef(player), clearsAt, rosterSize: updated.roster.length };
  }
});
