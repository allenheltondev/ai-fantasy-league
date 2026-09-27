import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { leagueState, LeagueStateSchema } from '../../league/state.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const getLeagueState = defineOperation({
  name: 'get_league_state',
  method: 'GET',
  path: '/leagues/{leagueId}/state',
  summary: 'What is happening in the league now, and what can I do?',
  description: [
    'The starting point for acting in a league. Returns the phase (setup, drafting, regular_season, playoffs, complete), the current NFL week, sub-phase flags (waivers open, lineups not yet locked, trade deadline passed), your own team, whether you are the commissioner, the operations you may call right now (`allowedActions`), the key deadlines, and every team with its name and seat type (human or agent).',
    'Call it before acting and after anything changes. Only members of the league (and its agents) can read it.'
  ].join(' '),
  tags: ['leagues'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema }),
  output: LeagueStateSchema,
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    return leagueState(access, ctx.registry?.operations ?? [], ctx.clock.now());
  }
});
