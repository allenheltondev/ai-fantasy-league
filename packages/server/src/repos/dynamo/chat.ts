import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ACTIVITY_TTL_MS,
  CHAT_MESSAGE_KINDS,
  decodeCursor,
  encodeCursor,
  messageSortKey,
  roomPrefix,
  storedMessage,
  UNREAD_CAP,
  type ChatActivity,
  type ChatMessage,
  type ChatPage,
  type ChatPutOptions,
  type ChatRepository,
  type RoomSummary
} from '../../chat/model.js';
import { batchWrite, queryAll } from './query.js';
import { epochSeconds, isConditionalCheckFailure, TABLE_KEYS, type TableContext } from './table.js';

/**
 * Chat partition `CHAT#<leagueId>` (docs/adr/001-table-design.md):
 * - messages: `MSG#<createdAt>#<id>` (trash talk, and every message from before rooms existed) or
 *   `ROOM#<roomId>#MSG#<createdAt>#<id>` (every other room)
 * - activity index: `ACT#<createdAt>#<id>`, no text, expiring after two days
 * - DM lists: `DM#<teamId>#<roomId>`, one per team in each DM
 * - read markers: `READ#<reader>#<roomId>` with `lastReadAt`
 */
const chatPk = (leagueId: string) => `CHAT#${leagueId}`;
/** Sorts after every character a message id or timestamp uses. */
const HIGH = '~';

export class DynamoChatRepository implements ChatRepository {
  constructor(private readonly table: TableContext) {}

  async put(message: ChatMessage, options: ChatPutOptions = {}): Promise<boolean> {
    const pk = chatPk(message.leagueId);
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: { pk, sk: messageSortKey(message), entity: 'chat', ...message },
          ConditionExpression: 'attribute_not_exists(pk)'
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
    // The index items follow the message; a failure here leaves a message that only rate limits
    // and budgets miss, never a lost message.
    const activity: ChatActivity = {
      messageId: message.id,
      roomId: message.roomId,
      kind: message.kind,
      teamId: message.author.teamId,
      createdAt: message.createdAt
    };
    const items: Record<string, unknown>[] = [
      {
        pk,
        sk: `ACT#${message.createdAt}#${message.id}`,
        entity: 'chatActivity',
        ...activity,
        [TABLE_KEYS.ttl]: epochSeconds(new Date(Date.parse(message.createdAt) + ACTIVITY_TTL_MS))
      }
    ];
    for (const teamId of options.dmTeamIds ?? []) {
      items.push({ pk, sk: `DM#${teamId}#${message.roomId}`, entity: 'chatDm', roomId: message.roomId });
    }
    await batchWrite(
      this.table,
      items.map((Item) => ({ PutRequest: { Item } }))
    );
    return true;
  }

  async list(leagueId: string, roomId: string, query: { limit: number; cursor?: string }): Promise<ChatPage> {
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor, roomId);
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': chatPk(leagueId), ':prefix': roomPrefix(roomId) },
        ScanIndexForward: false,
        // One extra item tells us whether an older page exists.
        Limit: query.limit + 1,
        ...(after === null ? {} : { ExclusiveStartKey: { pk: chatPk(leagueId), sk: after } })
      })
    );
    const items = result.Items ?? [];
    const messages = items.slice(0, query.limit).map(storedMessage);
    const last = messages.at(-1);
    return {
      messages,
      nextCursor: items.length > query.limit && last !== undefined ? encodeCursor(messageSortKey(last)) : null
    };
  }

  async summary(
    leagueId: string,
    roomId: string,
    lastReadAt: string | null,
    visibleFrom: string | null = null
  ): Promise<RoomSummary> {
    const prefix = roomPrefix(roomId);
    // Keys from `floor` on are the messages the reader may see at all (created at or after
    // `visibleFrom`); from `from` on, the ones they have not read.
    const floor = visibleFrom === null ? prefix : `${prefix}${visibleFrom}`;
    const read = lastReadAt === null ? prefix : `${prefix}${lastReadAt}#${HIGH}`;
    const from = read > floor ? read : floor;
    // Newest first, stopping at the reader's marker: every item returned is unread.
    const unread = await this.#newest(leagueId, from, `${prefix}${HIGH}`, UNREAD_CAP);
    if (unread.length > 0) return { lastMessageAt: unread[0] as string, unreadCount: unread.length };
    const newest = from === floor ? [] : await this.#newest(leagueId, floor, `${prefix}${HIGH}`, 1);
    return { lastMessageAt: newest[0] ?? null, unreadCount: 0 };
  }

  /** `createdAt` of the newest items with keys in [from, to], at most `limit`. */
  async #newest(leagueId: string, from: string, to: string, limit: number): Promise<string[]> {
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': chatPk(leagueId), ':from': from, ':to': to },
        ProjectionExpression: 'createdAt',
        ScanIndexForward: false,
        Limit: limit
      })
    );
    return (result.Items ?? []).map((item) => String(item.createdAt));
  }

  async activity(leagueId: string, since: string): Promise<ChatActivity[]> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': chatPk(leagueId),
        ':from': `ACT#${since}#${HIGH}`,
        ':to': `ACT#${HIGH}`
      },
      ScanIndexForward: false
    });
    return items.map((item) => ({
      messageId: String(item.messageId),
      roomId: String(item.roomId),
      kind: CHAT_MESSAGE_KINDS.find((k) => k === item.kind) ?? 'user',
      teamId: typeof item.teamId === 'string' ? item.teamId : null,
      createdAt: String(item.createdAt)
    }));
  }

  async dmRooms(leagueId: string, teamId: string): Promise<string[]> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': chatPk(leagueId), ':prefix': `DM#${teamId}#` }
    });
    return items.map((item) => String(item.roomId));
  }

  async readState(leagueId: string, reader: string): Promise<Record<string, string>> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': chatPk(leagueId), ':prefix': `READ#${reader}#` }
    });
    return Object.fromEntries(items.map((item) => [String(item.roomId), String(item.lastReadAt)]));
  }

  async markRead(leagueId: string, reader: string, roomId: string, at: string): Promise<void> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: {
            pk: chatPk(leagueId),
            sk: `READ#${reader}#${roomId}`,
            entity: 'chatRead',
            roomId,
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

  async deleteLeague(leagueId: string): Promise<void> {
    const keys = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': chatPk(leagueId) },
      ProjectionExpression: 'pk, sk'
    });
    await batchWrite(
      this.table,
      keys.map((key) => ({ DeleteRequest: { Key: { pk: key.pk, sk: key.sk } } }))
    );
  }
}
