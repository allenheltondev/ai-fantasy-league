/**
 * Shapes from the notification operations (#165: list_notifications, get_notification_summary,
 * mark_notifications_read, mark_notifications_delivered; #200: the preferences) in openapi.json.
 */

import { leaguePath } from '../routes/leagueRoutes';

export type NotificationSection = 'trades' | 'roster' | 'draft' | 'lineup';

export interface AppNotification {
  id: string;
  leagueId: string;
  teamId: string;
  kind: string;
  title: string;
  body: string;
  target: { section: NotificationSection; tradeId: string | null; playerId?: string | null };
  /** A starter ruled out before his game (#200): shown first, in red, one tap from the lineup. */
  urgent?: boolean;
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

export interface NotificationPreferences {
  /** News stories about your players in the inbox (status alerts always come). */
  playerNews: boolean;
}

export interface NotificationSummary {
  unreadCount: number;
  leagues: LeagueNotificationSummary[];
}

/** Where each notification section lives in the league (#178). */
const SECTION_PAGES: Record<NotificationSection, string> = {
  trades: 'team/trades',
  roster: 'team/lineup',
  draft: 'draft',
  lineup: 'team/lineup'
};

/** Where a notification leads in the app: the trade, or the lineup with the player highlighted (#200). */
export function notificationHref(n: Pick<AppNotification, 'leagueId' | 'target'>): string {
  const base = leaguePath(n.leagueId, SECTION_PAGES[n.target.section]);
  if (n.target.section === 'trades' && n.target.tradeId !== null) {
    return `${base}?trade=${encodeURIComponent(n.target.tradeId)}`;
  }
  const playerId = n.target.playerId ?? null;
  return n.target.section === 'lineup' && playerId !== null
    ? `${base}?player=${encodeURIComponent(playerId)}`
    : base;
}

/** Unread urgent items first (a starter ruled out), then newest first. */
export function inboxOrder(a: AppNotification, b: AppNotification): number {
  const rank = (n: AppNotification) => (n.urgent === true && !n.read ? 0 : 1);
  return rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** "99+" past the cap, like the chat's unread badges. */
export function countLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}
