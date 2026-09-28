import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ChatMessageSchema,
  decodeCursor,
  encodeCursor,
  messageSortKey,
  type ChatMessage,
  type ChatPage,
  type ChatRepository
} from '../../chat/model.js';
import { isConditionalCheckFailure, type TableContext } from './table.js';

/** Chat partition: pk `CHAT#<leagueId>`, sk `MSG#<createdAt>#<messageId>` (docs/adr/001-table-design.md). */
const chatPk = (leagueId: string) => `CHAT#${leagueId}`;

export class DynamoChatRepository implements ChatRepository {
  constructor(private readonly table: TableContext) {}

  async put(message: ChatMessage): Promise<boolean> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: { pk: chatPk(message.leagueId), sk: messageSortKey(message), entity: 'chat', ...message },
          ConditionExpression: 'attribute_not_exists(pk)'
        })
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async list(leagueId: string, query: { limit: number; cursor?: string }): Promise<ChatPage> {
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': chatPk(leagueId), ':prefix': 'MSG#' },
        ScanIndexForward: false,
        // One extra item tells us whether an older page exists.
        Limit: query.limit + 1,
        ...(after === null ? {} : { ExclusiveStartKey: { pk: chatPk(leagueId), sk: after } })
      })
    );
    const items = result.Items ?? [];
    const page = items.slice(0, query.limit);
    const messages = page.map((item) => ChatMessageSchema.parse(item));
    const last = messages.at(-1);
    return {
      messages,
      nextCursor: items.length > query.limit && last !== undefined ? encodeCursor(messageSortKey(last)) : null
    };
  }
}
