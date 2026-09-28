import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { TRADE_STATUSES, type Trade } from '@fantasy/core';
import { z } from 'zod';
import { byProposedAt, staleTrade, tradeExists, type TradeRecord, type TradeRepository } from '../trades.js';
import { leaguePk } from './league-records.js';
import { queryAll } from './query.js';
import { isConditionalCheckFailure, type TableContext } from './table.js';

/** Key layout: `pk = LEAGUE#<leagueId>`, `sk = TRADE#<tradeId>` (docs/adr/001-table-design.md). */
const tradeKey = (leagueId: string, tradeId: string) => ({ pk: leaguePk(leagueId), sk: `TRADE#${tradeId}` });

const SideSchema = z.object({ teamId: z.string(), sends: z.array(z.string()), drops: z.array(z.string()) });
const IssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  path: z.string(),
  message: z.string(),
  fix: z.string(),
  details: z.record(z.string(), z.unknown()).optional()
});
const TradeSchema = z.object({
  tradeId: z.string(),
  sides: z.tuple([SideSchema, SideSchema]),
  status: z.enum(TRADE_STATUSES),
  proposedAt: z.string(),
  expiresAt: z.string(),
  counterOf: z.string().nullable(),
  counterChain: z.array(z.string()),
  vetoVotes: z.array(z.string()),
  reviewEndsAt: z.string().nullable(),
  commissionerApproved: z.boolean(),
  voidReason: IssueSchema.nullable(),
  history: z.array(
    z.object({ status: z.enum(TRADE_STATUSES), at: z.string(), byTeamId: z.string().nullable() })
  )
});
const RecordSchema = z.object({
  leagueId: z.string(),
  trade: TradeSchema,
  message: z.string().nullable(),
  reply: z.string().nullable().default(null),
  createdBy: z.string(),
  processingAt: z.string().nullable(),
  updatedAt: z.string(),
  version: z.number()
});

function parse(item: Record<string, unknown>): TradeRecord {
  const record = RecordSchema.parse(item);
  return { ...record, trade: record.trade as Trade };
}

export class DynamoTradeRepository implements TradeRepository {
  constructor(private readonly table: TableContext) {}

  async create(record: TradeRecord): Promise<void> {
    try {
      await this.#put(record, { ConditionExpression: 'attribute_not_exists(pk)' });
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw tradeExists(record.trade.tradeId);
      throw error;
    }
  }

  async get(leagueId: string, tradeId: string): Promise<TradeRecord | null> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: tradeKey(leagueId, tradeId),
        ConsistentRead: true
      })
    );
    return result.Item === undefined ? null : parse(result.Item);
  }

  async list(leagueId: string): Promise<TradeRecord[]> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':prefix': 'TRADE#' },
      ConsistentRead: true
    });
    return items.map(parse).sort(byProposedAt);
  }

  async update(record: TradeRecord): Promise<TradeRecord> {
    const next = { ...record, version: record.version + 1 };
    try {
      await this.#put(next, {
        ConditionExpression: 'version = :expected',
        ExpressionAttributeValues: { ':expected': record.version }
      });
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw staleTrade(record.trade.tradeId);
      throw error;
    }
    return next;
  }

  async #put(
    record: TradeRecord,
    condition: { ConditionExpression: string; ExpressionAttributeValues?: Record<string, unknown> }
  ): Promise<void> {
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: { ...tradeKey(record.leagueId, record.trade.tradeId), entity: 'trade', ...record },
        ...condition
      })
    );
  }
}
