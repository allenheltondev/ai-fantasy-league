import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireMember } from '../../league/access.js';
import { actorTeam } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import {
  NOTIFICATION_PAGE,
  NOTIFICATION_UNREAD_CAP,
  notificationLocalKeyOf,
  NotificationPreferencesSchema,
  NotificationSchema
} from '../../notifications/model.js';
import { defineOperation } from '../../registry/operation.js';
import { seatTenureStart, type League, type Team } from '../../repos/types.js';

/**
 * The notification inbox (#165): what happened to your team while you were away (trade offers and
 * answers, waiver results, your turn in the draft), newest first, with unread counts. Items are
 * written by the events consumer (`notifications/consumer.ts`) for teams a person holds, so these
 * operations are for people only (`auth: 'user'`); AI managers have no inbox.
 */

const UnreadCountSchema = z
  .number()
  .int()
  .min(0)
  .max(NOTIFICATION_UNREAD_CAP)
  .describe(`Unread notifications, at most ${NOTIFICATION_UNREAD_CAP}.`);

const IdsSchema = z.array(z.string().min(1).max(400)).min(1).max(100);

/** The caller's team in the league, or null for a commissioner without a seat. */
function yourTeam(access: Awaited<ReturnType<typeof requireMember>>): Team | null {
  return actorTeam(access.actor);
}

function checkIds(ids: readonly string[]): void {
  const bad = ids.find((id) => notificationLocalKeyOf(id) === null);
  if (bad !== undefined) {
    throw new ApiError('INVALID_INPUT', `"${bad}" is not a notification id.`, {
      fix: 'Use the `id` of a notification from list_notifications.',
      details: { notificationId: bad }
    });
  }
}

/** Open offers waiting on the team's answer. */
async function offersWaiting(ctx: Ctx, league: League, teamId: string): Promise<number> {
  const now = ctx.clock.now().toISOString();
  const trades = await ctx.repos.trades.list(league.id);
  return trades.filter(
    (r) => r.trade.status === 'proposed' && r.trade.sides[1].teamId === teamId && r.trade.expiresAt > now
  ).length;
}

export const listNotifications = defineOperation({
  name: 'list_notifications',
  method: 'GET',
  path: '/leagues/{leagueId}/notifications',
  summary: 'Read your notification inbox in a league',
  description: [
    "Returns your team's notifications, newest first: trade offers, counters, and answers; accepted, vetoed, processed, and expired trades; your waiver claims won and lost (with why); your turn in the draft; and your players' status changes and news (#200).",
    'Each has a `title`, a `body`, `read`, and a `target` (the section to open: `trades` with the `tradeId`, `roster`, `draft`, or `lineup` with the `playerId`). `urgent: true` marks a starter ruled out before his game: handle it first with set_lineup. `unreadCount` counts every unread item, not just this page.',
    "Mark items read with mark_notifications_read. Read older items by passing the previous response's `nextCursor` as `after`. Items are kept for 30 days, and you see only those from your time on the seat.",
    'A commissioner without a team has no inbox (an empty list). Errors: FORBIDDEN if you are not in the league; INVALID_INPUT for a cursor this operation did not return.'
  ].join(' '),
  tags: ['notifications'],
  mutation: false,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(NOTIFICATION_PAGE.max)
      .default(NOTIFICATION_PAGE.default)
      .describe(`Notifications per page (1-${NOTIFICATION_PAGE.max}, default ${NOTIFICATION_PAGE.default}).`),
    after: z.string().min(1).max(400).optional().describe('`nextCursor` from the previous page.')
  }),
  output: z.object({
    teamId: z.string().nullable().describe('Your team; null when you have none.'),
    unreadCount: UnreadCountSchema,
    notifications: z.array(NotificationSchema),
    nextCursor: z.string().nullable().describe('Pass as `after` for older items; null on the last page.')
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    if (input.after !== undefined && notificationLocalKeyOf(input.after) === null) {
      throw new ApiError('INVALID_INPUT', 'That cursor is not one list_notifications returned.', {
        fix: 'Pass the `nextCursor` of the previous page as `after`, or leave `after` out for the newest items.'
      });
    }
    const team = yourTeam(access);
    if (team === null) return { teamId: null, unreadCount: 0, notifications: [], nextCursor: null };
    const visibleFrom = seatTenureStart(team);
    const [page, unreadCount] = await Promise.all([
      ctx.repos.notifications.list(access.league.id, team.id, {
        limit: input.limit,
        visibleFrom,
        ...(input.after === undefined ? {} : { cursor: input.after })
      }),
      ctx.repos.notifications.unreadCount(access.league.id, team.id, visibleFrom)
    ]);
    return { teamId: team.id, unreadCount, ...page };
  }
});

export const getNotificationSummary = defineOperation({
  name: 'get_notification_summary',
  method: 'GET',
  path: '/notifications',
  summary: 'Unread notifications and waiting trade offers across your leagues',
  description: [
    'A cheap check for "anything waiting for me?": for every league where you hold a seat, the unread notifications (`unreadCount`) and the open trade offers waiting on your answer (`tradeOffersWaiting`), plus the total unread.',
    'Read the items themselves with list_notifications for a league.'
  ].join(' '),
  tags: ['notifications'],
  mutation: false,
  auth: 'user',
  input: z.object({}),
  output: z.object({
    unreadCount: z.number().int().min(0).describe('Unread notifications in every league together.'),
    leagues: z.array(
      z.object({
        leagueId: z.string(),
        name: z.string(),
        teamId: z.string(),
        unreadCount: UnreadCountSchema,
        tradeOffersWaiting: z.number().int().min(0).describe('Open trade offers waiting on your answer.')
      })
    )
  }),
  handler: async (ctx) => {
    const principal = ctx.principal;
    /* v8 ignore next -- auth: 'user' guarantees a user principal */
    if (principal.type !== 'user') throw new Error('get_notification_summary needs a user principal');
    const members = await ctx.repos.members.listByUser(principal.sub);
    const leagues = new Map(
      (await ctx.repos.leagues.getMany(members.map((m) => m.leagueId))).map((l) => [l.id, l])
    );
    const rows = await Promise.all(
      members.map(async (member) => {
        const league = leagues.get(member.leagueId);
        const team = league === undefined ? null : await ctx.repos.teams.get(league.id, member.teamId);
        // A membership whose league is gone, or a seat someone else now holds, has no inbox.
        if (league === undefined || team === null || team.ownerUserId !== principal.sub) return null;
        const [unreadCount, tradeOffersWaiting] = await Promise.all([
          ctx.repos.notifications.unreadCount(league.id, team.id, seatTenureStart(team)),
          offersWaiting(ctx, league, team.id)
        ]);
        return { leagueId: league.id, name: league.name, teamId: team.id, unreadCount, tradeOffersWaiting };
      })
    );
    const listed = rows
      .filter((r) => r !== null)
      .sort((a, b) => a.name.localeCompare(b.name) || a.leagueId.localeCompare(b.leagueId));
    return { unreadCount: listed.reduce((sum, r) => sum + r.unreadCount, 0), leagues: listed };
  }
});

export const markNotificationsRead = defineOperation({
  name: 'mark_notifications_read',
  method: 'POST',
  path: '/notifications/read',
  summary: 'Mark notifications read',
  description: [
    'Marks your notifications in a league as read: the ones in `notificationIds` (ids from list_notifications), or every one up to now with `all: true`. Returns the unread count left.',
    'Unknown ids and items already read are skipped. Errors: INVALID_INPUT without exactly one of `notificationIds` and `all: true`, or for an id that is not a notification id; FORBIDDEN if you are not in the league.'
  ].join(' '),
  tags: ['notifications'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    notificationIds: IdsSchema.optional().describe('Notifications to mark read (at most 100).'),
    all: z.boolean().optional().describe('Mark every notification up to now read.')
  }),
  output: z.object({ leagueId: z.string(), unreadCount: UnreadCountSchema }),
  handler: async (ctx, input) => {
    const all = input.all === true;
    if (all === (input.notificationIds !== undefined)) {
      throw new ApiError('INVALID_INPUT', 'Say which notifications to mark read.', {
        fix: 'Send either `notificationIds` (ids from list_notifications) or `all: true`, not both.'
      });
    }
    if (input.notificationIds !== undefined) checkIds(input.notificationIds);
    const access = await requireMember(ctx, input.leagueId);
    const team = yourTeam(access);
    if (team === null) return { leagueId: access.league.id, unreadCount: 0 };
    const at = ctx.clock.now().toISOString();
    if (all) await ctx.repos.notifications.markAllRead(access.league.id, team.id, at);
    else await ctx.repos.notifications.markRead(access.league.id, team.id, input.notificationIds ?? [], at);
    const unreadCount = await ctx.repos.notifications.unreadCount(
      access.league.id,
      team.id,
      seatTenureStart(team)
    );
    return { leagueId: access.league.id, unreadCount };
  }
});

export const markNotificationsDelivered = defineOperation({
  name: 'mark_notifications_delivered',
  method: 'POST',
  path: '/notifications/delivered',
  summary: 'Record that notifications were shown live',
  description: [
    'Records that the app showed these notifications to you as they happened (a pop-up), so they are not announced again. Delivered is not read: they stay unread until mark_notifications_read.',
    'Unknown ids and items already delivered are skipped. Errors: INVALID_INPUT for an id that is not a notification id; FORBIDDEN if you are not in the league.'
  ].join(' '),
  tags: ['notifications'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    notificationIds: IdsSchema.describe('Notifications shown (at most 100).')
  }),
  output: z.object({ leagueId: z.string() }),
  handler: async (ctx, input) => {
    checkIds(input.notificationIds);
    const access = await requireMember(ctx, input.leagueId);
    const team = yourTeam(access);
    if (team !== null)
      await ctx.repos.notifications.markDelivered(
        access.league.id,
        team.id,
        input.notificationIds,
        ctx.clock.now().toISOString()
      );
    return { leagueId: access.league.id };
  }
});

function userSub(ctx: Ctx, operation: string): string {
  /* v8 ignore next -- auth: 'user' guarantees a user principal */
  if (ctx.principal.type !== 'user') throw new Error(`${operation} needs a user principal`);
  return ctx.principal.sub;
}

export const getNotificationPreferences = defineOperation({
  name: 'get_notification_preferences',
  method: 'GET',
  path: '/notifications/preferences',
  summary: 'Read your notification settings',
  description: [
    'Your notification settings, the same in every league: `playerNews` (inbox items for news stories about your players, on unless you turned it off).',
    'Status alerts about your players (ruled out, doubtful, back on the field) always come. Change settings with update_notification_preferences.'
  ].join(' '),
  tags: ['notifications'],
  mutation: false,
  auth: 'user',
  input: z.object({}),
  output: NotificationPreferencesSchema,
  handler: async (ctx) => ctx.repos.notifications.getPreferences(userSub(ctx, 'get_notification_preferences'))
});

export const updateNotificationPreferences = defineOperation({
  name: 'update_notification_preferences',
  method: 'PUT',
  path: '/notifications/preferences',
  summary: 'Change your notification settings',
  description: [
    'Turns player news in your inbox on or off (`playerNews`), in every league. Returns the settings as saved.',
    'Status alerts about your players cannot be turned off: a starter ruled out before his game always reaches you.'
  ].join(' '),
  tags: ['notifications'],
  mutation: true,
  auth: 'user',
  input: NotificationPreferencesSchema,
  output: NotificationPreferencesSchema,
  handler: async (ctx, input) => {
    const preferences = { playerNews: input.playerNews };
    await ctx.repos.notifications.putPreferences(
      userSub(ctx, 'update_notification_preferences'),
      preferences
    );
    return preferences;
  }
});

/** The notification inbox (#165) and its settings (#200). */
export const notificationOperations = [
  listNotifications,
  getNotificationSummary,
  markNotificationsRead,
  markNotificationsDelivered,
  getNotificationPreferences,
  updateNotificationPreferences
];
