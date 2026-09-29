/**
 * Shapes from the notification operations (#165: list_notifications, get_notification_summary,
 * mark_notifications_read, mark_notifications_delivered) in openapi.json.
 */

import { leaguePath } from '../routes/leagueRoutes';

export type NotificationSection = 'trades' | 'roster' | 'draft';

export interface AppNotification {
  id: string;
  leagueId: string;
  teamId: string;
  kind: string;
  title: string;
  body: string;
  target: { section: NotificationSection; tradeId: string | null };
  event: { detailType: string; eventId: string };
  createdAt: string;
  read: boolean;
  readAt: string | null;
  deliveredAt: string | null;
}

export interface NotificationInbox {
  teamId: string | null;
  unreadCount: number;
  notifications: AppNotification[];
  nextCursor: string | null;
}

export interface LeagueNotificationSummary {
  leagueId: string;
  name: string;
  teamId: string;
  unreadCount: number;
  tradeOffersWaiting: number;
}

export interface NotificationSummary {
  unreadCount: number;
  leagues: LeagueNotificationSummary[];
}

/** Where each notification section lives in the league (#178). */
const SECTION_PAGES: Record<NotificationSection, string> = {
  trades: 'team/trades',
  roster: 'team/lineup',
  draft: 'draft'
};

/** Where a notification leads in the app. */
export function notificationHref(n: Pick<AppNotification, 'leagueId' | 'target'>): string {
  const base = leaguePath(n.leagueId, SECTION_PAGES[n.target.section]);
  return n.target.section === 'trades' && n.target.tradeId !== null
    ? `${base}?trade=${encodeURIComponent(n.target.tradeId)}`
    : base;
}

/** "99+" past the cap, like the chat's unread badges. */
export function countLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}
