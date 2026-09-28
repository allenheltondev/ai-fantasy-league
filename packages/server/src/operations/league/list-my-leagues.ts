import { formatRecord } from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { leagueSummary, LeagueSummarySchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import type { League } from '../../repos/types.js';

const MyLeagueSchema = LeagueSummarySchema.extend({
  record: z
    .string()
    .nullable()
    .describe('Your team\'s regular-season record, e.g. "7-3" or "6-3-1"; null before the season starts.')
});

export const listMyLeagues = defineOperation({
  name: 'list_my_leagues',
  method: 'GET',
  path: '/leagues',
  summary: 'List the leagues you belong to',
  description: [
    'Returns every league where you hold a seat, newest season first and then by name, with its phase, current week, your team id, your record once the season starts, and whether you are the commissioner.',
    'Use a returned `id` as leagueId in the other league operations. An empty list means you have not created or joined a league yet: call create_league, or join_league with an invite token.'
  ].join(' '),
  tags: ['leagues'],
  mutation: false,
  auth: 'user',
  input: z.object({}),
  output: z.object({ leagues: z.array(MyLeagueSchema) }),
  handler: async (ctx) => {
    const principal = ctx.principal;
    /* v8 ignore next -- auth: 'user' guarantees a user principal */
    if (principal.type !== 'user') throw new Error('list_my_leagues needs a user principal');
    const members = await ctx.repos.members.listByUser(principal.sub);
    const leagues = new Map(
      (await ctx.repos.leagues.getMany(members.map((m) => m.leagueId))).map((l) => [l.id, l])
    );
    // A membership whose league is gone (a delete cut short) is skipped.
    const rows = await Promise.all(
      members.flatMap((member) => {
        const league = leagues.get(member.leagueId);
        if (league === undefined) return [];
        return [
          teamRecord(ctx, league, member.teamId).then((record) => ({
            ...leagueSummary(league, principal.sub, member.teamId),
            record
          }))
        ];
      })
    );
    return {
      leagues: rows.sort(
        (a, b) => b.season - a.season || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      )
    };
  }
});

/** The team's record from the latest standings: 0-0 once the season starts, null before it. */
async function teamRecord(ctx: Ctx, league: League, teamId: string): Promise<string | null> {
  if (league.phase === 'setup' || league.phase === 'drafting') return null;
  const snapshot = await ctx.repos.schedule.latestStandings(league.id);
  const row = snapshot?.rows.find((r) => r.teamId === teamId);
  return formatRecord(row ?? { wins: 0, losses: 0, ties: 0 });
}
