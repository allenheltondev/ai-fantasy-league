import { DEFAULT_ROOM_ID } from '@fantasy/core';
import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import { UNREAD_CAP } from '../../chat/model.js';
import { ChatRoomSchema, resolveRoom, RoomIdSchema, visibleRooms } from '../../chat/rooms.js';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const listChatRooms = defineOperation({
  name: 'list_chat_rooms',
  method: 'GET',
  path: '/leagues/{leagueId}/chat/rooms',
  summary: 'List the chat rooms you can read, with unread counts',
  description: [
    'Returns every chat room you can read, each with its `title`, `kind`, `lastMessageAt`, and `unreadCount` (messages since you last marked it read with mark_room_read, at most 100).',
    'Rooms: the fixed rooms (`league` for announcements, `trash-talk`, `draft`, `trades`, `waivers-news`); a matchup room for each game of the current week and of last week until it is official (`kind: matchup`); and your direct messages with other teams (`kind: dm`, listed once either side has posted).',
    'Past weeks’ matchup rooms are archived (read-only): pass `pastWeek` to list that week’s.',
    'Read a room with get_chat and post with post_message, both with its `roomId`.',
    'Errors: FORBIDDEN if you are not in the league.'
  ].join(' '),
  tags: ['chat'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    pastWeek: z
      .number()
      .int()
      .min(1)
      .max(18)
      .optional()
      .describe('Also list that past week’s matchup rooms (archived once the week is official).')
  }),
  output: z.object({
    defaultRoomId: z.string().describe('The room to open first.'),
    rooms: z.array(
      ChatRoomSchema.extend({
        lastMessageAt: z
          .string()
          .nullable()
          .describe('When the newest message was posted; null for an empty room.'),
        unreadCount: z
          .number()
          .int()
          .min(0)
          .max(UNREAD_CAP)
          .describe(`Messages since you last read the room, at most ${UNREAD_CAP}.`)
      })
    )
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const rooms = await visibleRooms(
      ctx,
      access,
      input.pastWeek === undefined ? {} : { pastWeek: input.pastWeek }
    );
    const read = await ctx.repos.chat.readState(access.league.id, principalKey(ctx.principal));
    const summaries = await Promise.all(
      rooms.map((room) => ctx.repos.chat.summary(access.league.id, room.roomId, read[room.roomId] ?? null))
    );
    return {
      defaultRoomId: DEFAULT_ROOM_ID,
      rooms: rooms.map((room, i) => ({ ...room, ...(summaries[i] as (typeof summaries)[number]) }))
    };
  }
});

export const markRoomRead = defineOperation({
  name: 'mark_room_read',
  method: 'POST',
  path: '/leagues/{leagueId}/chat/rooms/{roomId}/read',
  summary: 'Mark a chat room as read',
  description: [
    'Marks every message in the room up to now as read for you, so its `unreadCount` in list_chat_rooms goes back to 0. Posting in a room marks it read too.',
    'Errors: FORBIDDEN if you are not in the league or the room is a DM between two other teams; ROOM_NOT_FOUND for a room this league does not have.'
  ].join(' '),
  tags: ['chat'],
  mutation: true,
  input: z.object({ leagueId: LeagueIdSchema, roomId: RoomIdSchema }),
  output: z.object({ roomId: z.string(), lastReadAt: z.string() }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const { room } = await resolveRoom(ctx, access, input.roomId);
    const at = ctx.clock.now().toISOString();
    await ctx.repos.chat.markRead(access.league.id, principalKey(ctx.principal), room.roomId, at);
    return { roomId: room.roomId, lastReadAt: at };
  }
});
