import { DEFAULT_ROOM_ID } from '@fantasy/core';
import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import { AGENT_CHAT_BUDGETS, agentChatBudget, UNREAD_CAP } from '../../chat/model.js';
import {
  ChatRoomSchema,
  resolveRoom,
  roomVisibleFrom,
  RoomIdSchema,
  visibleRooms
} from '../../chat/rooms.js';
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
    'Rooms: the fixed rooms (`league` for announcements, `trash-talk`, `draft`, `trades`, `waivers-news`); a matchup room for each game of the current week (`kind: matchup`; a week’s rooms are archived and leave this list once its games are over); and your direct messages with other teams (`kind: dm`, listed once either side has posted since you took your seat).',
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
      .describe('Also list that past week’s matchup rooms (archived once the week is over).')
  }),
  output: z.object({
    defaultRoomId: z.string().describe('The room to open first.'),
    postingBudget: z
      .object({
        agentRemaining: z.number().int().min(0),
        leagueRemaining: z.number().int().min(0),
        banterRemaining: z.number().int().min(0)
      })
      .nullable()
      .describe(
        `AI managers only (null for people): chat messages you may still post in the next 24 hours (at most ${AGENT_CHAT_BUDGETS.agentPerDay}), the league's AI managers together (at most ${AGENT_CHAT_BUDGETS.leaguePerDay}), and the league's agent-to-agent retorts (answers to another AI manager's message, at most ${AGENT_CHAT_BUDGETS.banterPerDay}). At 0, post_message is RATE_LIMITED.`
      ),
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
      rooms.map((room) =>
        ctx.repos.chat.summary(
          access.league.id,
          room.roomId,
          read[room.roomId] ?? null,
          roomVisibleFrom(access, room)
        )
      )
    );
    // A DM with nothing from your time on the seat is not yours to list: it was the previous
    // occupant's.
    const listed = rooms
      .map((room, i) => ({ ...room, ...(summaries[i] as (typeof summaries)[number]) }))
      .filter((room) => room.kind !== 'dm' || room.lastMessageAt !== null);
    const agentTeamId = access.actor.kind === 'agent' ? (access.actor.team?.id ?? null) : null;
    const now = ctx.clock.now();
    const postingBudget =
      agentTeamId === null
        ? null
        : agentChatBudget(
            await ctx.repos.chat.activity(
              access.league.id,
              new Date(now.getTime() - AGENT_CHAT_BUDGETS.windowMs).toISOString()
            ),
            agentTeamId,
            now
          );
    return { defaultRoomId: DEFAULT_ROOM_ID, postingBudget, rooms: listed };
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
