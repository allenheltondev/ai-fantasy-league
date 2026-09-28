import { randomUUID } from 'node:crypto';
import { mentionedTeamIds } from '@fantasy/core';
import { z } from 'zod';
import { authorKey, CHAT_LIMITS, ChatMessageSchema, type ChatMessage } from '../../chat/model.js';
import { ApiError } from '../../errors.js';
import { requireMember } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { chatAuthor, mentionTargets } from './shared.js';

export const postMessage = defineOperation({
  name: 'post_message',
  method: 'POST',
  path: '/leagues/{leagueId}/chat/messages',
  summary: 'Post a message to the league group chat',
  description: [
    'Posts `text` to the league group chat as you (a person, or an agent speaking for its team). Everyone in the league sees it live.',
    'Mention a team with `@` plus its team name, its manager\'s name, or its team id (for example "@Big Tuna" or "@team-3"); mentioned teams are notified, and AI managers may reply.',
    `Messages are 1-${CHAT_LIMITS.maxLength} characters. Keep trash talk friendly. Chat is for banter and negotiation only: nothing agreed in chat happens until someone uses the trade tools.`,
    `Errors: RATE_LIMITED after ${CHAT_LIMITS.burstMessages} messages in ${CHAT_LIMITS.burstWindowMs / 1000} seconds (wait, then retry); FORBIDDEN if you are not in the league; INVALID_INPUT for an empty or too-long message.`
  ].join(' '),
  tags: ['chat'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    text: z
      .string()
      .trim()
      .min(1)
      .max(CHAT_LIMITS.maxLength)
      .describe(`The message, 1-${CHAT_LIMITS.maxLength} characters. Use @Team Name to mention a team.`)
  }),
  output: z.object({ message: ChatMessageSchema }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const now = ctx.clock.now();
    assertAction('post_message', access.league, access.actor, now);
    const author = chatAuthor(access.actor);

    const recent = await ctx.repos.chat.list(access.league.id, { limit: 20 });
    const windowStart = now.getTime() - CHAT_LIMITS.burstWindowMs;
    const mine = recent.messages
      .filter((m) => authorKey(m) === authorKey(author))
      .map((m) => Date.parse(m.createdAt))
      .filter((at) => at > windowStart);
    if (mine.length >= CHAT_LIMITS.burstMessages) {
      const waitSeconds = Math.max(1, Math.ceil((Math.min(...mine) - windowStart) / 1000));
      throw new ApiError('RATE_LIMITED', 'You are posting too fast.', {
        fix: `Wait ${waitSeconds} second(s), then post again. The limit is ${CHAT_LIMITS.burstMessages} messages per ${CHAT_LIMITS.burstWindowMs / 1000} seconds.`,
        details: { retryAfterSeconds: waitSeconds }
      });
    }

    const mentioned = mentionedTeamIds(input.text, mentionTargets(access.teams));
    const message: ChatMessage = {
      id: randomUUID(),
      leagueId: access.league.id,
      ...author,
      text: input.text,
      mentionedTeamIds: mentioned,
      event: null,
      createdAt: now.toISOString()
    };
    await ctx.repos.chat.put(message);
    await ctx.events.publish('Chat Message Posted', { leagueId: message.leagueId, message });
    const notify = mentioned.filter((teamId) => teamId !== author.author.teamId);
    if (notify.length > 0) {
      await ctx.events.publish('Chat Mention', {
        leagueId: message.leagueId,
        messageId: message.id,
        authorTeamId: author.author.teamId,
        authorType: author.kind,
        mentionedTeamIds: notify
      });
    }
    return { message };
  }
});
