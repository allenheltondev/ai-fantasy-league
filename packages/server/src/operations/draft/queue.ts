import { MAX_DRAFT_QUEUE } from '@fantasy/core';
import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireMember } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { PlayerRefSchema, toPlayerRef } from '../../players/model.js';
import { defineOperation, withWarnings, type Warning } from '../../registry/operation.js';
import type { Team } from '../../repos/types.js';
import { actingTeam } from '../waivers/shared.js';

/**
 * Your draft queue (#134): the players you want next, most wanted first. It lives on the server so
 * the pick clock can use it: when your time runs out, autopick takes the first queued player who is
 * still available and keeps your roster valid, before falling back to its own choice.
 */

const QueueTeamIdField = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('Your team id. Defaults to the team you manage; a queue is private to its team.');

export const DraftQueueSchema = z.object({
  teamId: z.string(),
  maxSize: z.number().int().describe('The most players a queue holds.'),
  updatedAt: z.string().nullable().describe('When the queue last changed; null if it was never set.'),
  players: z
    .array(
      z.object({
        player: PlayerRefSchema,
        rank: z.number().int().nullable().describe('Consensus overall rank (ADP stand-in); lower is better.'),
        available: z.boolean().describe('False once the player has been drafted.')
      })
    )
    .describe('Queued players, most wanted first.')
});
export type DraftQueueView = z.infer<typeof DraftQueueSchema>;

async function queueView(
  ctx: Ctx,
  leagueId: string,
  team: Team,
  playerIds: readonly string[],
  updatedAt: string | null
): Promise<DraftQueueView> {
  const [record, all] = await Promise.all([ctx.repos.drafts.get(leagueId), ctx.data.players.all()]);
  const byId = new Map(all.map((p) => [p.id, p]));
  const drafted = new Set(record?.state.picks.map((p) => p.playerId) ?? []);
  return {
    teamId: team.id,
    maxSize: MAX_DRAFT_QUEUE,
    updatedAt,
    players: playerIds.flatMap((id) => {
      const player = byId.get(id);
      if (player === undefined) return [];
      return [{ player: toPlayerRef(player), rank: player.rank, available: !drafted.has(id) }];
    })
  };
}

export const getDraftQueue = defineOperation({
  name: 'get_draft_queue',
  method: 'GET',
  path: '/leagues/{leagueId}/draft/queue',
  summary: 'See your draft queue: the players you want next, in order',
  description: [
    'Returns your team’s draft queue, most wanted first, with each player’s rank and whether he is still `available`.',
    'When your pick clock runs out, autopick takes the first queued player who is still available and keeps your roster valid; only if none fits does it choose for you. Change the queue with set_draft_queue.',
    'Works before and during the draft. Only the team’s owner (or the agent that plays it) can read its queue.'
  ].join(' '),
  tags: ['draft'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema, teamId: QueueTeamIdField }),
  output: DraftQueueSchema,
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const team = actingTeam(access, input.teamId);
    const stored = await ctx.repos.drafts.getQueue(input.leagueId, team.id);
    return queueView(ctx, input.leagueId, team, stored?.playerIds ?? [], stored?.updatedAt ?? null);
  }
});

export const setDraftQueue = defineOperation({
  name: 'set_draft_queue',
  method: 'PUT',
  path: '/leagues/{leagueId}/draft/queue',
  summary: 'Replace your draft queue with a new ordered list of players',
  description: [
    `Replaces your team’s whole draft queue with \`playerIds\`, most wanted first (at most ${MAX_DRAFT_QUEUE}; an empty list clears it). Sending the same list again changes nothing.`,
    'When your pick clock runs out, autopick takes the first queued player who is still available and keeps your roster valid. Queueing does not draft anyone: on the clock, pick with make_draft_pick.',
    'Get ids from get_draft_board (`bestAvailable`) or search_players. An unknown id returns PLAYER_NOT_FOUND; a repeated id is kept once. Allowed before and during the draft, for your own team only.'
  ].join(' '),
  tags: ['draft'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: QueueTeamIdField,
    playerIds: z
      .array(z.string().min(1).max(64))
      .max(MAX_DRAFT_QUEUE)
      .describe('Player ids, most wanted first. Replaces the whole queue.')
  }),
  output: DraftQueueSchema,
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const access = await requireMember(ctx, input.leagueId);
    const team = actingTeam(access, input.teamId);
    assertAction('set_draft_queue', access.league, access.actor, now);
    const playerIds = [...new Set(input.playerIds)];
    const known = new Set((await ctx.data.players.all()).map((p) => p.id));
    const unknown = playerIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ApiError(
        'PLAYER_NOT_FOUND',
        `No player has id ${unknown.map((id) => `"${id}"`).join(', ')}.`,
        {
          fix: 'Use ids from get_draft_board (`bestAvailable`) or search_players, then send the whole list again.',
          details: { unknownPlayerIds: unknown }
        }
      );
    }
    const warnings: Warning[] = [];
    if (playerIds.length < input.playerIds.length) {
      warnings.push({
        code: 'DUPLICATES_REMOVED',
        message: `${input.playerIds.length - playerIds.length} repeated player id(s) were kept once, at their first place.`
      });
    }
    const stored = await ctx.repos.drafts.getQueue(input.leagueId, team.id);
    const same =
      stored !== null &&
      stored.playerIds.length === playerIds.length &&
      stored.playerIds.every((id, i) => id === playerIds[i]);
    const updatedAt = same ? stored.updatedAt : now.toISOString();
    if (!same) {
      await ctx.repos.drafts.putQueue({
        leagueId: input.leagueId,
        teamId: team.id,
        playerIds,
        updatedAt,
        updatedBy: principalKey(ctx.principal)
      });
    }
    return withWarnings(await queueView(ctx, input.leagueId, team, playerIds, updatedAt), warnings);
  }
});
