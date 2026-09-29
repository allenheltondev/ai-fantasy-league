import { NOTIFICATION_KINDS, NOTIFICATION_SECTIONS } from '@fantasy/core';
import { z } from 'zod';

/**
 * The notification inbox (#165): per-team items in the league partition, written by the events
 * consumer (`consumer.ts`) and read by the notification operations. Keys are in
 * docs/adr/001-table-design.md, "League partition":
 * - item: `NOTIF#<teamId>#<createdAt>#<eventId>[-<key>]`, with a 30-day `ttl`
 * - "mark all read" marker: `NOTIFREAD#<teamId>` with `lastReadAt`
 *
 * The item's time is its event's time, so a redelivered event hits the same key and the conditional
 * put stores nothing. An item is read once it has `readAt` (marked one by one) or is no newer than
 * the team's `lastReadAt` (mark all). A team's current occupant sees only items from their own time
 * on the seat (`seatTenureStart`), like direct messages.
 */

/** How long an item stays in the inbox. */
export const NOTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Unread counts stop counting here (the app shows "99+"). */
export const NOTIFICATION_UNREAD_CAP = 100;
/** Page size bounds for `list_notifications`. */
export const NOTIFICATION_PAGE = { default: 20, max: 50 } as const;

export const NotificationTargetSchema = z
  .object({
    section: z
      .enum(NOTIFICATION_SECTIONS)
      .describe('The league section to open: trades, roster, draft, or lineup (player status and news).'),
    tradeId: z.string().nullable().describe('The trade to show, for trade notifications.'),
    playerId: z
      .string()
      .nullable()
      .optional()
      .describe('The player to highlight on the lineup, for player status and news notifications.')
  })
  .describe('Where the notification leads.');

export const NotificationSchema = z.object({
  id: z.string().describe('Pass to mark_notifications_read or mark_notifications_delivered.'),
  leagueId: z.string(),
  teamId: z.string().describe('The team it is addressed to (yours).'),
  kind: z.enum(NOTIFICATION_KINDS),
  title: z.string(),
  body: z.string(),
  target: NotificationTargetSchema,
  urgent: z
    .boolean()
    .optional()
    .describe(
      'True when it needs action now: a starter ruled out (or doubtful) before his game. Show it first; fix it with set_lineup.'
    ),
  event: z.object({ detailType: z.string(), eventId: z.string() }).describe('The league event it came from.'),
  createdAt: z.string(),
  read: z.boolean(),
  readAt: z
    .string()
    .nullable()
    .describe('When it was marked read on its own; null when unread or read by "all".'),
  deliveredAt: z
    .string()
    .nullable()
    .describe('When the app first showed it live (a pop-up); null until then. Delivered is not read.')
});
export type Notification = z.infer<typeof NotificationSchema>;

/** A notification as stored: `read` is derived when it is listed. */
export type StoredNotification = Omit<Notification, 'read'>;

/** A person's notification settings (#200), the same in every league. */
export const NotificationPreferencesSchema = z.object({
  playerNews: z
    .boolean()
    .describe(
      'Inbox items for news stories about your players (at most one per player an hour). Status alerts about your starters always come.'
    )
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = { playerNews: true };

export interface NotificationPage {
  /** Newest first. */
  notifications: Notification[];
  /** Pass as `after` for older items; null when there are none. */
  nextCursor: string | null;
}

export interface NotificationRepository {
  /** Stores an item; false (and nothing changes) when its id already exists for the team. */
  put(notification: StoredNotification): Promise<boolean>;
  /** The team's items created at or after `visibleFrom`, newest first. */
  list(
    leagueId: string,
    teamId: string,
    query: { limit: number; cursor?: string; visibleFrom: string }
  ): Promise<NotificationPage>;
  /** Unread items created at or after `visibleFrom`, at most `NOTIFICATION_UNREAD_CAP`. */
  unreadCount(leagueId: string, teamId: string, visibleFrom: string): Promise<number>;
  /** Sets `readAt` on each of the team's items that has none; unknown ids are ignored. */
  markRead(leagueId: string, teamId: string, ids: readonly string[], at: string): Promise<void>;
  /** Everything up to `at` is read (moves the team's marker forward only). */
  markAllRead(leagueId: string, teamId: string, at: string): Promise<void>;
  /** Sets `deliveredAt` on each of the team's items that has none; unknown ids are ignored. */
  markDelivered(leagueId: string, teamId: string, ids: readonly string[], at: string): Promise<void>;
  /** A person's settings (`USER#<sub>` / `NOTIFPREFS`), or the defaults when none are stored. */
  getPreferences(userId: string): Promise<NotificationPreferences>;
  putPreferences(userId: string, preferences: NotificationPreferences): Promise<void>;
}

/** The part of the sort key after the team: `<createdAt>#<eventId>[-<key>]`. */
export function notificationLocalKey(createdAt: string, eventId: string, key: string): string {
  return `${createdAt}#${eventId}${key === '' ? '' : `-${key}`}`;
}

/** A notification's public id: its local key, base64url-encoded. */
export function notificationId(localKey: string): string {
  return Buffer.from(localKey, 'utf8').toString('base64url');
}

/** The local key in an id, or null when it is not one of ours. */
export function notificationLocalKeyOf(id: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(id)) return null;
  const local = Buffer.from(id, 'base64url').toString('utf8');
  return /^\d{4}-\d{2}-\d{2}T[^#]+#[^#]+$/.test(local) ? local : null;
}

/** Read: marked on its own, or no newer than the team's "mark all" marker. */
export function isRead(notification: StoredNotification, lastReadAt: string | null): boolean {
  return notification.readAt !== null || (lastReadAt !== null && notification.createdAt <= lastReadAt);
}
