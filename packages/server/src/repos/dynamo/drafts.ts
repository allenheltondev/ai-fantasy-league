import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { draftExists, staleDraft } from '../errors.js';
import type { DraftQueueRecord, DraftRecord, DraftRepository } from '../types.js';
import {
  draftLobbyKey,
  DraftQueueRecordSchema,
  draftQueueKey,
  DraftRecordSchema,
  draftKey,
  ENTITY,
  leaguePk
} from './league-records.js';
import { queryAll } from './query.js';
import { isConditionalCheckFailure, TABLE_KEYS, type TableContext } from './table.js';

/** A lobby check-in expires from the table a day later; the lobby only counts recent ones anyway. */
const LOBBY_TTL_SECONDS = 24 * 60 * 60;

const draftItem = (draft: DraftRecord) => ({ ...draftKey(draft.leagueId), entity: ENTITY.draft, ...draft });

/**
 * The draft is one item (`DRAFT`) holding the order and every pick, so each pick is a single
 * version-checked put: of two racing picks for the same slot, exactly one lands.
 */
export class DynamoDraftRepository implements DraftRepository {
  constructor(private readonly table: TableContext) {}

  async get(leagueId: string): Promise<DraftRecord | null> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: draftKey(leagueId), ConsistentRead: true })
    );
    return result.Item === undefined ? null : DraftRecordSchema.parse(result.Item);
  }

  async create(draft: DraftRecord): Promise<void> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: draftItem(draft),
          ConditionExpression: 'attribute_not_exists(pk)'
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw draftExists(draft.leagueId);
      throw error;
    }
  }

  async update(draft: DraftRecord): Promise<DraftRecord> {
    const next: DraftRecord = { ...draft, version: draft.version + 1 };
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: draftItem(next),
          ConditionExpression: 'version = :expected',
          ExpressionAttributeValues: { ':expected': draft.version }
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw staleDraft(draft.leagueId);
      throw error;
    }
    return next;
  }

  async getQueue(leagueId: string, teamId: string): Promise<DraftQueueRecord | null> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: draftQueueKey(leagueId, teamId),
        ConsistentRead: true
      })
    );
    return result.Item === undefined ? null : DraftQueueRecordSchema.parse(result.Item);
  }

  /** One item per team, replaced whole: the last write wins, and a repeat is a no-op. */
  async putQueue(queue: DraftQueueRecord): Promise<void> {
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: { ...draftQueueKey(queue.leagueId, queue.teamId), entity: ENTITY.draftQueue, ...queue }
      })
    );
  }

  async checkIn(leagueId: string, memberKey: string, at: string): Promise<void> {
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: {
          ...draftLobbyKey(leagueId, memberKey),
          entity: ENTITY.draftLobby,
          memberKey,
          at,
          [TABLE_KEYS.ttl]: Math.floor(Date.parse(at) / 1000) + LOBBY_TTL_SECONDS
        }
      })
    );
  }

  async lobby(leagueId: string): Promise<Record<string, string>> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':prefix': 'DRAFTLOBBY#' }
    });
    return Object.fromEntries(items.map((item) => [String(item.memberKey), String(item.at)]));
  }
}
