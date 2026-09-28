import {
  isRead,
  notificationLocalKeyOf,
  NOTIFICATION_UNREAD_CAP,
  type NotificationPage,
  type NotificationRepository,
  type StoredNotification
} from '../notifications/model.js';

function localKey(n: StoredNotification): string {
  const key = notificationLocalKeyOf(n.id);
  if (key === null) throw new Error(`not a notification id: ${n.id}`);
  return key;
}

/** In-memory notification inboxes, with the same order, cursors, and read rules as DynamoDB. */
export class InMemoryNotificationRepository implements NotificationRepository {
  /** By `<leagueId>#<teamId>`, then by local key. */
  readonly #items = new Map<string, Map<string, StoredNotification>>();
  /** `lastReadAt` by `<leagueId>#<teamId>`. */
  readonly #marks = new Map<string, string>();

  #inbox(leagueId: string, teamId: string): Map<string, StoredNotification> {
    const key = `${leagueId}#${teamId}`;
    let inbox = this.#items.get(key);
    if (inbox === undefined) {
      inbox = new Map();
      this.#items.set(key, inbox);
    }
    return inbox;
  }

  /** The team's items at or after `visibleFrom`, newest first, as [local key, item]. */
  #visible(leagueId: string, teamId: string, visibleFrom: string): [string, StoredNotification][] {
    return [...this.#inbox(leagueId, teamId)]
      .filter(([key]) => key >= visibleFrom)
      .sort(([a], [b]) => b.localeCompare(a));
  }

  async put(notification: StoredNotification): Promise<boolean> {
    const inbox = this.#inbox(notification.leagueId, notification.teamId);
    const key = localKey(notification);
    if (inbox.has(key)) return false;
    inbox.set(key, structuredClone(notification));
    return true;
  }

  async list(
    leagueId: string,
    teamId: string,
    query: { limit: number; cursor?: string; visibleFrom: string }
  ): Promise<NotificationPage> {
    const after = query.cursor === undefined ? null : notificationLocalKeyOf(query.cursor);
    const items = this.#visible(leagueId, teamId, query.visibleFrom).filter(
      ([key]) => after === null || key < after
    );
    const page = items.slice(0, query.limit);
    const lastReadAt = this.#marks.get(`${leagueId}#${teamId}`) ?? null;
    return {
      notifications: page.map(([, n]) => ({ ...structuredClone(n), read: isRead(n, lastReadAt) })),
      nextCursor:
        items.length > query.limit ? (page[page.length - 1] as [string, StoredNotification])[1].id : null
    };
  }

  async unreadCount(leagueId: string, teamId: string, visibleFrom: string): Promise<number> {
    const lastReadAt = this.#marks.get(`${leagueId}#${teamId}`) ?? null;
    const unread = this.#visible(leagueId, teamId, visibleFrom).filter(([, n]) => !isRead(n, lastReadAt));
    return Math.min(unread.length, NOTIFICATION_UNREAD_CAP);
  }

  async markRead(leagueId: string, teamId: string, ids: readonly string[], at: string): Promise<void> {
    this.#stamp(leagueId, teamId, ids, (n) => n.readAt === null && (n.readAt = at));
  }

  async markAllRead(leagueId: string, teamId: string, at: string): Promise<void> {
    const key = `${leagueId}#${teamId}`;
    const current = this.#marks.get(key);
    if (current === undefined || current < at) this.#marks.set(key, at);
  }

  async markDelivered(leagueId: string, teamId: string, ids: readonly string[], at: string): Promise<void> {
    this.#stamp(leagueId, teamId, ids, (n) => n.deliveredAt === null && (n.deliveredAt = at));
  }

  #stamp(
    leagueId: string,
    teamId: string,
    ids: readonly string[],
    apply: (n: StoredNotification) => unknown
  ): void {
    const inbox = this.#inbox(leagueId, teamId);
    for (const id of ids) {
      const key = notificationLocalKeyOf(id);
      const item = key === null ? undefined : inbox.get(key);
      if (item !== undefined) apply(item);
    }
  }

  dropLeague(leagueId: string): void {
    for (const key of [...this.#items.keys()]) if (key.startsWith(`${leagueId}#`)) this.#items.delete(key);
    for (const key of [...this.#marks.keys()]) if (key.startsWith(`${leagueId}#`)) this.#marks.delete(key);
  }
}
