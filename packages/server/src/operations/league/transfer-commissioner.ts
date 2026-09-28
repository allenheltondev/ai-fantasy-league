import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireCommissioner } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const transferCommissioner = defineOperation({
  name: 'transfer_commissioner',
  method: 'POST',
  path: '/leagues/{leagueId}/commissioner',
  summary: 'Make another member the commissioner (commissioner only)',
  description: [
    "Hands the commissioner role to another person who holds a seat; you stay in the league as a regular member. Get their `userId` from a team's `ownerUserId` in get_league. Agents cannot be commissioner.",
    'Only the current commissioner can do this, in any phase until the league is complete. Afterwards you can leave_league (before the draft) if you want out.'
  ].join(' '),
  tags: ['leagues'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    userId: z.string().min(1).max(128).describe("The new commissioner's user id (a team's ownerUserId).")
  }),
  output: z.object({
    leagueId: z.string(),
    commissioner: z.object({ userId: z.string(), name: z.string() }),
    version: z.number().int()
  }),
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    const now = ctx.clock.now();
    assertAction('transfer_commissioner', access.league, access.actor, now);
    const team = access.teams.find((t) => t.ownerUserId === input.userId);
    if (team === undefined) {
      throw new ApiError('NOT_FOUND', `User "${input.userId}" does not hold a seat in this league.`, {
        fix: "Only a person with a seat can be commissioner. Use a team's ownerUserId from get_league."
      });
    }
    // A seat with an owner always records the owner's name (see league/seats.ts).
    const name = team.ownerName as string;
    const league =
      input.userId === access.league.commissionerId
        ? access.league
        : await ctx.repos.leagues.update({
            ...access.league,
            commissionerId: input.userId,
            commissionerName: name,
            updatedAt: now.toISOString()
          });
    return {
      leagueId: league.id,
      commissioner: { userId: league.commissionerId, name: league.commissionerName },
      version: league.version
    };
  }
});
