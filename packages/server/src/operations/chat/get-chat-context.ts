import { z } from 'zod';
import { buildChatContext, ChatContextPackSchema } from '../../chat/context.js';
import { resolveRoom, RoomIdSchema } from '../../chat/rooms.js';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema, TeamIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const getChatContext = defineOperation({
  name: 'get_chat_context',
  method: 'GET',
  path: '/leagues/{leagueId}/chat/rooms/{roomId}/context',
  summary: 'The league facts behind a chat room',
  description: [
    'Returns a small, typed fact pack for one chat room, so you can talk about the league with real numbers. The pack depends on the room (`pack.kind`):',
    '`league` (rooms `league` and `trash-talk`): standings with records, streaks, and points for; last week’s results; the top 3 power rankings; and your head-to-head record against `aboutTeamId` when you pass it.',
    '`matchup` (a matchup room): both teams’ starters with live or final points, projections, injuries, byes, and who is in the red zone; each side’s projected score and win probability; and their season series.',
    '`draft`: the draft status, the latest picks, your picks, and once it is complete the biggest steals and reaches.',
    '`trades`: trades completed or vetoed in the last two weeks, your trades the league can see, how many of your offers are open, and the trade deadline.',
    '`waivers` (room `waivers-news`): the last waiver run’s awards, FAAB left per team, and trending adds.',
    '`dm` (a direct message): the trades and offers between your two teams, the other team’s unfilled starting slots, and your head-to-head record.',
    'Everything in a pack is something you could already read: never waiver bids, never other teams’ pending offers, never other teams’ DMs. Only members can read it.',
    'Errors: FORBIDDEN if you are not in the league or the room is a DM between two other teams; ROOM_NOT_FOUND for a room this league does not have.'
  ].join(' '),
  tags: ['chat'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    roomId: RoomIdSchema,
    aboutTeamId: TeamIdSchema.optional().describe(
      '`league` and `trash-talk` only: the team the conversation is about, for your head-to-head record with it.'
    )
  }),
  output: z.object({
    roomId: z.string(),
    roomKind: z.enum(['fixed', 'matchup', 'dm']),
    pack: ChatContextPackSchema
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const resolved = await resolveRoom(ctx, access, input.roomId);
    const pack = await buildChatContext(ctx, access, resolved, { aboutTeamId: input.aboutTeamId });
    return { roomId: resolved.room.roomId, roomKind: resolved.room.kind, pack };
  }
});
