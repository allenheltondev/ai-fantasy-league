import { z } from 'zod';
import { requireCommissioner } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const deleteLeague = defineOperation({
  name: 'delete_league',
  method: 'DELETE',
  path: '/leagues/{leagueId}',
  summary: 'Delete a league that has not drafted yet (commissioner only)',
  description: [
    'Permanently deletes the league with its teams, memberships, invites, and group chat. Every member loses access, and invite links stop working. It frees a slot in your league quota.',
    'Only the commissioner can delete, and only while the league is in setup; once the draft starts the league plays out its season. This cannot be undone.'
  ].join(' '),
  tags: ['leagues'],
  mutation: true,
  auth: 'user',
  input: z.object({ leagueId: LeagueIdSchema }),
  output: z.object({ leagueId: z.string(), deleted: z.literal(true) }),
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    assertAction('delete_league', access.league, access.actor, ctx.clock.now());
    // Chat has its own partition; the league partition (teams, members, invites, lineups, the
    // draft, waivers, transactions) goes last, so an interrupted delete can be retried.
    await ctx.repos.chat.deleteLeague(access.league.id);
    await ctx.repos.leagues.delete(access.league.id);
    return { leagueId: access.league.id, deleted: true as const };
  }
});
