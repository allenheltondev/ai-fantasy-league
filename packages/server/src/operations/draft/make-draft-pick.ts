import { currentPick } from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { actorTeam, assertAction } from '../../league/phase.js';
import { requireMember, requireTeamOwner } from '../../league/access.js';
import { MAX_PICK_REASON, recordPick, requireDraft, secondsLeft } from '../../league/draft.js';
import { LeagueIdSchema, TeamIdSchema } from '../../league/views.js';
import { playerSelectorShape, PlayerRefSchema, toPlayerRef } from '../../players/model.js';
import { defineOperation } from '../../registry/operation.js';
import { OnTheClockSchema } from './board.js';

export const makeDraftPick = defineOperation({
  name: 'make_draft_pick',
  method: 'POST',
  path: '/leagues/{leagueId}/draft/picks',
  summary: 'Draft a player when your team is on the clock',
  description: [
    'Drafts a player for your team. Only the team on the clock can pick (get_draft_board shows `onTheClock` and your `yourNextPick`).',
    'Pass `playerId` (preferred, from get_draft_board or search_players) or `player` with a name; an ambiguous name returns AMBIGUOUS_PLAYER with candidates. Pass `pick` (the overall pick number you are making) so a late request cannot land on a later pick.',
    'Errors and fixes: NOT_YOUR_TURN says how many picks until you are up; PLAYER_ALREADY_DRAFTED names who took him; ROSTER_WOULD_BE_INVALID means you must fill an empty starting slot with your remaining picks; DRAFT_PAUSED means wait for the commissioner; CONFLICT means another pick landed first (re-read the board).',
    '`teamId` defaults to your own team. Send an Idempotency-Key: a retry with the same key returns the same pick instead of making a second one.'
  ].join(' '),
  tags: ['draft'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdSchema.optional().describe('Your team id. Defaults to the team you manage.'),
    pick: z.number().int().min(1).optional().describe('The overall pick number you are making.'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PICK_REASON)
      .optional()
      .describe(
        'Optional: one or two sentences on why you made this pick. The league sees it in the draft recap, and in chat when the pick is notable.'
      ),
    ...playerSelectorShape
  }),
  output: z.object({
    pick: z.object({
      overall: z.number().int(),
      round: z.number().int(),
      pick: z.number().int(),
      teamId: z.string(),
      player: PlayerRefSchema
    }),
    draftComplete: z.boolean().describe('True when this was the last pick; the season starts now.'),
    onTheClock: OnTheClockSchema.nullable()
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const now = ctx.clock.now();
    assertAction('make_draft_pick', access.league, access.actor, now);
    const own = actorTeam(access.actor);
    const teamId = input.teamId ?? own?.id;
    /* v8 ignore next 5 -- the make_draft_pick rule only admits callers with a team */
    if (teamId === undefined) {
      throw new ApiError('FORBIDDEN', 'You do not manage a team in this league.', {
        fix: 'Only a team in this league can draft.'
      });
    }
    const team = requireTeamOwner(access, teamId);
    const record = requireDraft(await ctx.repos.drafts.get(input.leagueId));
    const player = await ctx.data.players.resolve(input);
    const outcome = await recordPick(ctx, {
      league: access.league,
      teams: access.teams,
      record,
      teamId: team.id,
      player,
      auto: false,
      expectedPick: input.pick,
      reason: input.reason
    });
    const next = currentPick(outcome.record.state);
    return {
      pick: {
        overall: outcome.pick.overall,
        round: outcome.pick.round,
        pick: outcome.pick.pick,
        teamId: team.id,
        player: toPlayerRef(player)
      },
      draftComplete: outcome.completed,
      onTheClock:
        next === null
          ? null
          : {
              overall: next.overall,
              round: next.round,
              pick: next.pick,
              teamId: next.teamId,
              teamName: access.teams.find((t) => t.id === next.teamId)?.name ?? next.teamId,
              deadline: outcome.record.deadline,
              secondsLeft: secondsLeft(outcome.record, now)
            }
    };
  }
});
