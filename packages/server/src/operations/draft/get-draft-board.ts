import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { requireDraft } from '../../league/draft.js';
import { actorTeam } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { BoardQueryShape, buildBoard, DraftBoardSchema } from './board.js';

export const getDraftBoard = defineOperation({
  name: 'get_draft_board',
  method: 'GET',
  path: '/leagues/{leagueId}/draft',
  summary: 'See the draft: order, picks, who is on the clock, rosters, and the best available players',
  description: [
    'Read this before every pick. `onTheClock` is the team picking now and its deadline (autopick picks when it passes); `yourNextPick.picksAway` is 0 when it is your turn.',
    '`yourNeeds` lists your empty starting slots: your remaining picks must fill them, so a pick that makes that impossible is refused. `bestAvailable` lists undrafted players by consensus rank (lower is better), with each player’s `bye` week and `injuryStatus`; filter it with `position` or a name in `q`, and pass `detail: true` or `limit` for more.',
    'Before the draft starts this returns DRAFT_NOT_STARTED. Any member of the league can read it.'
  ].join(' '),
  tags: ['draft'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema, ...BoardQueryShape }),
  output: DraftBoardSchema,
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const record = requireDraft(await ctx.repos.drafts.get(input.leagueId));
    return buildBoard(ctx, {
      record,
      teams: access.teams,
      settings: access.league.settings,
      season: access.league.season,
      yourTeamId: actorTeam(access.actor)?.id ?? null,
      query: input
    });
  }
});
