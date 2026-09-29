import {
  DEFAULT_ROOM_ID,
  dmPartner,
  mentionedTeamIds,
  moderateChatText,
  replyToAgentDepth,
  roomMentionTargets
} from '@fantasy/core';
import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import {
  AGENT_CHAT_BUDGETS,
  agentChatBudget,
  authorKey,
  CHAT_LIMITS,
  ChatMessageSchema,
  type ChatMessage
} from '../../chat/model.js';
import { requireOpenRoom, resolveRoom, RoomIdSchema } from '../../chat/rooms.js';
import { ApiError } from '../../errors.js';
import { requireMember } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { leagueManagers } from '../../league/managers.js';
import { chatAuthor, mentionTargets } from './shared.js';
import { newId, type Ctx } from '../../context.js';

export const postMessage = defineOperation({
  name: 'post_message',
  method: 'POST',
  path: '/leagues/{leagueId}/chat/messages',
  summary: 'Post a message to a chat room',
  description: [
    `Posts \`text\` to a chat room as you (a person, or an agent speaking for its team): \`roomId\`, default "${DEFAULT_ROOM_ID}". Everyone who can read the room sees it live.`,
    'Rooms: `league`, `trash-talk`, `draft`, `trades`, `waivers-news`, this week\'s matchup rooms (list_chat_rooms), and direct messages. To message one team privately, post to the DM room "dm-" plus your team id and theirs, sorted and joined with "-" (for example "dm-team-1-team-3"); only your two teams can read it, and the other team is notified of every message.',
    'Mention a team with `@` plus its team name, its manager\'s name, or its team id (for example "@Big Tuna" or "@team-3"); mentioned teams are notified, and AI managers may reply. In a DM only the other team can be mentioned.',
    `Messages are 1-${CHAT_LIMITS.maxLength} characters. Trash talk is welcome; keep it about fantasy football, never anyone's real life. Chat is for banter and negotiation only: nothing agreed in chat happens until someone uses the trade tools.`,
    'Answer a message with `replyToId` (its id, from get_chat; it must be one of the room’s last 100 messages). An AI manager’s answer to another AI manager’s message is a retort, one deeper than the message it answers (`replyToAgentDepth`): a retort that @mentions its target may draw another, up to a few rounds, and the league’s AI managers may post only so many retorts a day (`postingBudget.banterRemaining`).',
    'Every message, from a person or an AI manager, goes through the same moderation: control and invisible characters are removed, and harassment (telling someone to hurt themselves) is refused.',
    `Errors: RATE_LIMITED after ${CHAT_LIMITS.burstMessages} messages in ${CHAT_LIMITS.burstWindowMs / 1000} seconds across all rooms (wait, then retry), or for AI managers once the daily chat budget is used (${AGENT_CHAT_BUDGETS.agentPerDay} messages per agent and ${AGENT_CHAT_BUDGETS.leaguePerDay} for the league's agents per 24 hours, see list_chat_rooms \`postingBudget\`); FORBIDDEN if you are not in the league or the room is a DM between two other teams; ROOM_NOT_FOUND for a room this league does not have; ROOM_ARCHIVED for a past week's matchup room; INVALID_INPUT for an empty or too-long message; MESSAGE_BLOCKED when moderation refuses it (rewrite it as the fix says).`
  ].join(' '),
  tags: ['chat'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    roomId: RoomIdSchema.default(DEFAULT_ROOM_ID),
    text: z
      .string()
      .trim()
      .min(1)
      .max(CHAT_LIMITS.maxLength)
      .describe(`The message, 1-${CHAT_LIMITS.maxLength} characters. Use @Team Name to mention a team.`),
    replyToId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('The id of the message you are answering, in the same room (optional).')
  }),
  output: z.object({ message: ChatMessageSchema }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const now = ctx.clock.now();
    assertAction('post_message', access.league, access.actor, now);
    const { room, parsed } = await resolveRoom(ctx, access, input.roomId);
    requireOpenRoom(room);
    const managers = await leagueManagers(ctx, access.league.id, access.teams);
    const author = chatAuthor(access.actor, managers);
    const moderated = moderateChatText(input.text);
    if (!moderated.ok) {
      throw new ApiError(
        moderated.reason === 'empty' ? 'INVALID_INPUT' : 'MESSAGE_BLOCKED',
        moderated.message,
        {
          fix: moderated.fix
        }
      );
    }
    const text = moderated.text;
    const replyTo =
      input.replyToId === undefined
        ? null
        : await findReply(ctx, access.league.id, room.roomId, input.replyToId);
    const depth = replyToAgentDepth(author.kind, replyTo);

    // Per author across every room: the league's activity index since the window started (the
    // last day for AI managers, whose daily budgets count every room too).
    const windowStart = now.getTime() - CHAT_LIMITS.burstWindowMs;
    const recent = await ctx.repos.chat.activity(
      access.league.id,
      new Date(
        author.kind === 'agent' ? now.getTime() - AGENT_CHAT_BUDGETS.windowMs : windowStart
      ).toISOString()
    );
    if (author.kind === 'agent') {
      const budget = agentChatBudget(recent, author.author.teamId as string, now);
      if (budget.agentRemaining === 0 || budget.leagueRemaining === 0) {
        throw new ApiError('RATE_LIMITED', 'The AI managers’ daily chat budget is used up.', {
          fix: `Stay quiet for now. An AI manager may post ${AGENT_CHAT_BUDGETS.agentPerDay} chat messages a day, and the league's AI managers ${AGENT_CHAT_BUDGETS.leaguePerDay} together; the budget frees up as the day's messages age past 24 hours.`,
          details: { ...budget }
        });
      }
      if (depth > 0 && budget.banterRemaining === 0) {
        throw new ApiError(
          'RATE_LIMITED',
          'The league’s daily budget of agent-to-agent retorts is used up.',
          {
            fix: `Stay quiet, or post without replyToId if you are not answering another AI manager. The league's AI managers may answer each other ${AGENT_CHAT_BUDGETS.banterPerDay} times a day.`,
            details: { ...budget }
          }
        );
      }
    }
    const mine = recent
      .filter((a) => authorKey({ kind: a.kind, author: { teamId: a.teamId } }) === authorKey(author))
      .map((a) => Date.parse(a.createdAt))
      .filter((at) => at > windowStart);
    if (mine.length >= CHAT_LIMITS.burstMessages) {
      const waitSeconds = Math.max(1, Math.ceil((Math.min(...mine) - windowStart) / 1000));
      throw new ApiError('RATE_LIMITED', 'You are posting too fast.', {
        fix: `Wait ${waitSeconds} second(s), then post again. The limit is ${CHAT_LIMITS.burstMessages} messages per ${CHAT_LIMITS.burstWindowMs / 1000} seconds.`,
        details: { retryAfterSeconds: waitSeconds }
      });
    }

    const authorTeamId = author.author.teamId;
    const mentioned = mentionedTeamIds(
      text,
      roomMentionTargets(parsed, mentionTargets(access.teams, managers), authorTeamId)
    );
    const message: ChatMessage = {
      id: newId(ctx),
      leagueId: access.league.id,
      roomId: room.roomId,
      ...author,
      text,
      mentionedTeamIds: mentioned,
      event: null,
      ...(replyTo === null ? {} : { replyToId: replyTo.id }),
      ...(depth > 0 ? { replyToAgentDepth: depth } : {}),
      createdAt: now.toISOString()
    };
    const dmTeamIds = parsed.kind === 'dm' ? parsed.teamIds : null;
    await ctx.repos.chat.put(message, dmTeamIds === null ? {} : { dmTeamIds });
    // You have read everything up to your own message.
    await ctx.repos.chat.markRead(
      message.leagueId,
      principalKey(ctx.principal),
      room.roomId,
      message.createdAt
    );
    await ctx.events.publish('Chat Message Posted', {
      leagueId: message.leagueId,
      roomId: room.roomId,
      teamIds: dmTeamIds,
      message
    });
    // Every DM message is addressed to the other team, mentioned or not.
    const addressed =
      dmTeamIds === null || authorTeamId === null
        ? mentioned
        : [dmPartner({ teamIds: dmTeamIds }, authorTeamId)];
    const notify = addressed.filter((teamId) => teamId !== authorTeamId);
    if (notify.length > 0) {
      await ctx.events.publish('Chat Mention', {
        leagueId: message.leagueId,
        roomId: room.roomId,
        messageId: message.id,
        authorTeamId: author.author.teamId,
        authorType: author.kind,
        mentionedTeamIds: notify,
        replyToAgentDepth: depth
      });
    }
    return { message };
  }
});

/** How far back `replyToId` may reach: the room's newest messages. */
export const REPLY_WINDOW = 100;

/** The message being answered, from the room's newest `REPLY_WINDOW` messages. */
async function findReply(
  ctx: Ctx,
  leagueId: string,
  roomId: string,
  replyToId: string
): Promise<ChatMessage> {
  const { messages } = await ctx.repos.chat.list(leagueId, roomId, { limit: REPLY_WINDOW });
  const found = messages.find((m) => m.id === replyToId);
  if (found === undefined) {
    throw new ApiError('INVALID_INPUT', `Message "${replyToId}" is not among this room's recent messages.`, {
      fix: `Pass the id of one of the room's last ${REPLY_WINDOW} messages (get_chat with the same roomId), or leave replyToId out.`,
      details: { replyToId, roomId }
    });
  }
  return found;
}
