import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isRead,
  notificationLocalKeyOf,
  NOTIFICATION_TTL_MS,
  NOTIFICATION_UNREAD_CAP,
  NotificationSchema,
  type NotificationPage,
  type NotificationPreferences,
  NotificationPreferencesSchema,
  type NotificationRepository,
  type StoredNotification
} from '../../notifications/model.js';
import { epochSeconds, isConditionalCheckFailure, TABLE_KEYS, type TableContext } from './table.js';

/**
 * Notification inboxes in the league partition `LEAGUE#<leagueId>` (#165,
 * docs/adr/001-table-design.md): items `NOTIF#<teamId>#<createdAt>#<eventId>[-<key>]` with a
 * 30-day `ttl`, and one "mark all read" marker per team, `NOTIFREAD#<teamId>`. A person's
 * notification settings (#200) are one item in their user partition: `USER#<sub>` / `NOTIFPREFS`.
 */
const pk = (leagueId: string) => `LEAGUE#${leagueId}`;
const prefix = (teamId: string) => `NOTIF#${teamId}#`;
const markerSk = (teamId: string) => `NOTIFREAD#${teamId}`;
const preferencesKey = (userId: string) => ({ pk: `USER#${userId}`, sk: 'NOTIFPREFS' });
/** Sorts after every character a local key uses. */
const HIGH = '~';

type Item = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const StoredSchema = NotificationSchema.omit({ read: true });

/** An item as stored: `readAt` and `deliveredAt` are absent until set. */
function stored(item: Item): StoredNotification {
  return StoredSchema.parse({ ...item, readAt: str(item.readAt), deliveredAt: str(item.deliveredAt) });
}

export class DynamoNotificationRepository implements NotificationRepository {
  constructor(private readonly table: TableContext) {}

  async put(notification: StoredNotification): Promise<boolean> {
    const local = notificationLocalKeyOf(notification.id);
    if (local === null) throw new Error(`not a notification id: ${notification.id}`);
    const { readAt, deliveredAt, ...fields } = notification;
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: {
            pk: pk(notification.leagueId),
            sk: `${prefix(notification.teamId)}${local}`,
            entity: 'notification',
            ...fields,
            // Absent until set, so the unread filter and the conditional updates can test for it.
            ...(readAt === null ? {} : { readAt }),
            ...(deliveredAt === null ? {} : { deliveredAt }),
            [TABLE_KEYS.ttl]: epochSeconds(new Date(Date.parse(notification.createdAt) + NOTIFICATION_TTL_MS))
          },
          ConditionExpression: 'attribute_not_exists(pk)'
        })
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async #lastReadAt(leagueId: string, teamId: string): Promise<string | null> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: { pk: pk(leagueId), sk: markerSk(teamId) } })
    );
    return str(result.Item?.lastReadAt);
  }

  async list(
    leagueId: string,
    teamId: string,
    query: { limit: number; cursor?: string; visibleFrom: string }
  ): Promise<NotificationPage> {
    const after = query.cursor === undefined ? null : notificationLocalKeyOf(query.cursor);
    const lastReadAt = await this.#lastReadAt(leagueId, teamId);
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': pk(leagueId),
          ':from': `${prefix(teamId)}${query.visibleFrom}`,
          ':to': `${prefix(teamId)}${HIGH}`
        },
        ScanIndexForward: false,
        // One extra item says whether an older page exists.
        Limit: query.limit + 1,
        ...(after === null
          ? {}
          : { ExclusiveStartKey: { pk: pk(leagueId), sk: `${prefix(teamId)}${after}` } })
      })
    );
    const items = (result.Items ?? []).map(stored);
    const page = items.slice(0, query.limit);
    return {
      notifications: page.map((n) => ({ ...n, read: isRead(n, lastReadAt) })),
      nextCursor: items.length > query.limit ? (page[page.length - 1] as StoredNotification).id : null
    };
  }

  async unreadCount(leagueId: string, teamId: string, visibleFrom: string): Promise<number> {
    const lastReadAt = await this.#lastReadAt(leagueId, teamId);
    const floor = `${prefix(teamId)}${visibleFrom}`;
    const read = lastReadAt === null ? floor : `${prefix(teamId)}${lastReadAt}#${HIGH}`;
    // Only items after both the marker and the seat's start can be unread; of those, the ones
    // without `readAt`. The filter applies after each page's limit, so page until the cap.
    let count = 0;
    let cursor: Item | undefined;
    do {
      const result = await this.table.doc.send(
        new QueryCommand({
          TableName: this.table.tableName,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          FilterExpression: 'attribute_not_exists(readAt)',
          ExpressionAttributeValues: {
            ':pk': pk(leagueId),
            ':from': read > floor ? read : floor,
            ':to': `${prefix(teamId)}${HIGH}`
          },
          Select: 'COUNT',
          ExclusiveStartKey: cursor
        })
      );
      count += Number(result.Count);
      cursor = result.LastEvaluatedKey;
    } while (cursor !== undefined && count < NOTIFICATION_UNREAD_CAP);
    return Math.min(count, NOTIFICATION_UNREAD_CAP);
  }

  async markRead(leagueId: string, teamId: string, ids: readonly string[], at: string): Promise<void> {
    await this.#stamp(leagueId, teamId, ids, 'readAt', at);
  }

  async markDelivered(leagueId: string, teamId: string, ids: readonly string[], at: string): Promise<void> {
    await this.#stamp(leagueId, teamId, ids, 'deliveredAt', at);
  }

  async #stamp(
    leagueId: string,
    teamId: string,
    ids: readonly string[],
    field: 'readAt' | 'deliveredAt',
    at: string
  ): Promise<void> {
    for (const id of new Set(ids)) {
      const local = notificationLocalKeyOf(id);
      if (local === null) continue;
      try {
        await this.table.doc.send(
          new UpdateCommand({
            TableName: this.table.tableName,
            Key: { pk: pk(leagueId), sk: `${prefix(teamId)}${local}` },
            UpdateExpression: 'SET #field = :at',
            // Only an item that exists (never create one) and has not been stamped yet.
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#field)',
            ExpressionAttributeNames: { '#field': field },
            ExpressionAttributeValues: { ':at': at }
          })
        );
      } catch (error) {
        if (!isConditionalCheckFailure(error)) throw error;
      }
    }
  }

  async markAllRead(leagueId: string, teamId: string, at: string): Promise<void> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: {
            pk: pk(leagueId),
            sk: markerSk(teamId),
            entity: 'notificationRead',
            teamId,
            lastReadAt: at
          },
          ConditionExpression: 'attribute_not_exists(pk) OR lastReadAt < :at',
          ExpressionAttributeValues: { ':at': at }
        })
      );
    } catch (error) {
      // Already read up to `at` or later.
      if (!isConditionalCheckFailure(error)) throw error;
    }
  }

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: preferencesKey(userId) })
    );
    const parsed = NotificationPreferencesSchema.partial().safeParse(result.Item ?? {});
    return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(parsed.success ? parsed.data : {}) };
  }

  async putPreferences(userId: string, preferences: NotificationPreferences): Promise<void> {
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: { ...preferencesKey(userId), entity: 'notificationPreferences', ...preferences }
      })
    );
  }
}
