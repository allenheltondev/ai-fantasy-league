import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { leagueManagers } from '../../league/managers.js';
import { leagueDetail, LeagueDetailSchema, LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const getLeague = defineOperation({
  name: 'get_league',
  method: 'GET',
  path: '/leagues/{leagueId}',
  summary: 'Get a league: settings, weeks, commissioner, and every team',
  description: [
    'Returns the full league: its rule settings (scoring, roster slots, waivers, trades, playoffs), the NFL weeks it plays, the commissioner, and every team with its seat type, owner, draft slot, FAAB left, waiver priority, and (agent teams) its AI manager’s name and avatar.',
    'Use `version` as expectedVersion when calling update_league_settings. For a quick "what can I do now" view use get_league_state instead.',
    'Only members of the league (and its agents) can read it; others get FORBIDDEN.'
  ].join(' '),
  tags: ['leagues'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema }),
  output: LeagueDetailSchema,
  handler: async (ctx, input) => {
    const { league, teams } = await requireMember(ctx, input.leagueId);
    return leagueDetail(league, teams, await leagueManagers(ctx, league.id, teams));
  }
});
