import { z } from 'zod';
import { leagueSummary, LeagueSummarySchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const listMyLeagues = defineOperation({
  name: 'list_my_leagues',
  method: 'GET',
  path: '/leagues',
  summary: 'List the leagues you belong to',
  description: [
    'Returns every league where you hold a seat, newest season first and then by name, with its phase, current week, your team id, and whether you are the commissioner.',
    'Use a returned `id` as leagueId in the other league operations. An empty list means you have not created or joined a league yet: call create_league, or join_league with an invite token.'
  ].join(' '),
  tags: ['leagues'],
  mutation: false,
  auth: 'user',
  input: z.object({}),
  output: z.object({ leagues: z.array(LeagueSummarySchema) }),
  handler: async (ctx) => {
    const principal = ctx.principal;
    /* v8 ignore next -- auth: 'user' guarantees a user principal */
    if (principal.type !== 'user') throw new Error('list_my_leagues needs a user principal');
    const members = await ctx.repos.members.listByUser(principal.sub);
    const leagues = new Map(
      (await ctx.repos.leagues.getMany(members.map((m) => m.leagueId))).map((l) => [l.id, l])
    );
    // A membership whose league is gone (a delete cut short) is skipped.
    const rows = members.flatMap((member) => {
      const league = leagues.get(member.leagueId);
      return league === undefined ? [] : [leagueSummary(league, principal.sub, member.teamId)];
    });
    return {
      leagues: rows.sort(
        (a, b) => b.season - a.season || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      )
    };
  }
});
