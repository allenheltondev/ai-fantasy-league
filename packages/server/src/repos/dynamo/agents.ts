import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AgentLeagueMemorySchema, type AgentLeagueMemory } from '@fantasy/core';
import { z } from 'zod';
import {
  AgentSeatRecordSchema,
  AgentTaskRecordSchema,
  AgentUsageRowSchema,
  LIMIT_CLAIM_ATTEMPTS,
  staleSeat,
  type AgentRepository,
  type AgentSeatRecord,
  type AgentTaskClaim,
  type AgentTaskRecord,
  type AgentTriggerState,
  type AgentUsageRow,
  type LimitClaim,
  type LimitClaimResult
} from '../agents.js';
import { TABLE_KEYS, epochSeconds, isConditionalCheckFailure, type TableContext } from './table.js';

/**
 * Key layout:
 * - Seat (current):   pk LEAGUE#<leagueId>  sk AGENTSEAT#<teamId>
 * - Seat history:     pk LEAGUE#<leagueId>  sk AGENTSEATV#<teamId>#<version, 6 digits>
 * - Agent memory:     pk LEAGUE#<leagueId>  sk AGENTMEM#<agentId>  (notes, rivals, trades, decisions, chat; rev)
 * - Trigger state:    pk LEAGUE#<leagueId>  sk AGENTSTATE#<agentId>
 * - Limit (#196):     pk LEAGUE#<leagueId>  sk AGENTLIMIT#<key>     (rev, uses: epoch ms; TTL)
 * - Task:             pk AGENTTASK#<taskId> sk STATUS
 *                     GSI1 AGENTTASKS#<leagueId> / <startedAt>#<taskId>     (once complete)
 *                     GSI2 AGENTTASKS#<leagueId>#<teamId> / <startedAt>#<taskId>
 * - Weekly usage:     pk AGENTUSAGE#<leagueId>#W<week> sk AGENT#<agentId>#MODEL#<modelKey>
 */
const leaguePk = (leagueId: string) => `LEAGUE#${leagueId}`;
const seatKey = (leagueId: string, teamId: string) => ({ pk: leaguePk(leagueId), sk: `AGENTSEAT#${teamId}` });
const historyKey = (leagueId: string, teamId: string, version: number) => ({
  pk: leaguePk(leagueId),
  sk: `AGENTSEATV#${teamId}#${String(version).padStart(6, '0')}`
});
const memoryKey = (leagueId: string, agentId: string) => ({
  pk: leaguePk(leagueId),
  sk: `AGENTMEM#${agentId}`
});
const stateKey = (leagueId: string, agentId: string) => ({
  pk: leaguePk(leagueId),
  sk: `AGENTSTATE#${agentId}`
});
const limitKey = (leagueId: string, key: string) => ({ pk: leaguePk(leagueId), sk: `AGENTLIMIT#${key}` });
const taskKey = (taskId: string) => ({ pk: `AGENTTASK#${taskId}`, sk: 'STATUS' });
const usagePk = (leagueId: string, week: number) => `AGENTUSAGE#${leagueId}#W${week}`;

const MemorySchema = AgentLeagueMemorySchema.extend({ rev: z.number() });
const TaskSlotSchema = z.object({
  state: z.enum(['running', 'complete']),
  lockUntil: z.number(),
  record: AgentTaskRecordSchema.optional()
});
const StateSchema = z.object({ leagueId: z.string(), agentId: z.string(), lastTriggeredAt: z.string() });
const LimitSchema = z.object({ rev: z.number(), uses: z.array(z.number()) });

export class DynamoAgentRepository implements AgentRepository {
  constructor(private readonly table: TableContext) {}

  async getSeat(leagueId: string, teamId: string): Promise<AgentSeatRecord | null> {
    const item = await this.#get(seatKey(leagueId, teamId));
    return item === undefined ? null : AgentSeatRecordSchema.parse(item);
  }

  async listSeats(leagueId: string): Promise<AgentSeatRecord[]> {
    const items = await this.#queryPrefix(leaguePk(leagueId), 'AGENTSEAT#', true, 100);
    return items.map((item) => AgentSeatRecordSchema.parse(item));
  }

  async putSeat(record: AgentSeatRecord): Promise<void> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: { ...seatKey(record.leagueId, record.teamId), ...record },
          ConditionExpression: record.version === 1 ? 'attribute_not_exists(pk)' : 'version = :expected',
          ExpressionAttributeValues: record.version === 1 ? undefined : { ':expected': record.version - 1 }
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw staleSeat(record.teamId);
      throw error;
    }
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: { ...historyKey(record.leagueId, record.teamId, record.version), ...record }
      })
    );
  }

  async seatHistory(leagueId: string, teamId: string, limit = 20): Promise<AgentSeatRecord[]> {
    const items = await this.#queryPrefix(leaguePk(leagueId), `AGENTSEATV#${teamId}#`, false, limit);
    return items.map((item) => AgentSeatRecordSchema.parse(item));
  }

  async getMemory(leagueId: string, agentId: string): Promise<AgentLeagueMemory> {
    const item = await this.#get(memoryKey(leagueId, agentId));
    const { rev: _rev, ...memory } = MemorySchema.parse(item ?? { rev: 0 });
    return memory;
  }

  async updateMemory(
    leagueId: string,
    agentId: string,
    update: (memory: AgentLeagueMemory) => AgentLeagueMemory
  ): Promise<AgentLeagueMemory> {
    for (let attempt = 0; ; attempt++) {
      const item = await this.#get(memoryKey(leagueId, agentId));
      const { rev, ...current } = MemorySchema.parse(item ?? { rev: 0 });
      const next = AgentLeagueMemorySchema.parse(update(current));
      try {
        await this.table.doc.send(
          new PutCommand({
            TableName: this.table.tableName,
            Item: { ...memoryKey(leagueId, agentId), ...next, rev: rev + 1 },
            ConditionExpression: rev === 0 ? 'attribute_not_exists(pk)' : 'rev = :rev',
            ExpressionAttributeValues: rev === 0 ? undefined : { ':rev': rev }
          })
        );
        return next;
      } catch (error) {
        if (!isConditionalCheckFailure(error) || attempt >= 2) throw error;
      }
    }
  }

  async claimTask(input: { taskId: string; now: Date; lockUntil: Date }): Promise<AgentTaskClaim> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: { ...taskKey(input.taskId), state: 'running', lockUntil: input.lockUntil.getTime() },
          ConditionExpression: 'attribute_not_exists(pk) OR (#state = :running AND lockUntil <= :now)',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':running': 'running', ':now': input.now.getTime() }
        })
      );
      return { status: 'started' };
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
    const item = await this.#get(taskKey(input.taskId));
    const slot = TaskSlotSchema.parse(item);
    if (slot.state === 'complete' && slot.record !== undefined)
      return { status: 'done', record: slot.record };
    return { status: 'in_progress' };
  }

  async completeTask(record: AgentTaskRecord, expiresAt: Date): Promise<void> {
    const sortKey = `${record.startedAt}#${record.taskId}`;
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: {
          ...taskKey(record.taskId),
          state: 'complete',
          lockUntil: 0,
          record,
          [TABLE_KEYS.gsi1.pk]: `AGENTTASKS#${record.leagueId}`,
          [TABLE_KEYS.gsi1.sk]: sortKey,
          [TABLE_KEYS.gsi2.pk]: `AGENTTASKS#${record.leagueId}#${record.teamId}`,
          [TABLE_KEYS.gsi2.sk]: sortKey,
          [TABLE_KEYS.ttl]: epochSeconds(expiresAt)
        }
      })
    );
  }

  async listTasks(
    leagueId: string,
    query: { teamId?: string; limit?: number } = {}
  ): Promise<AgentTaskRecord[]> {
    const index = query.teamId === undefined ? TABLE_KEYS.gsi1 : TABLE_KEYS.gsi2;
    const value =
      query.teamId === undefined ? `AGENTTASKS#${leagueId}` : `AGENTTASKS#${leagueId}#${query.teamId}`;
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        IndexName: index.name,
        KeyConditionExpression: '#k = :v',
        ExpressionAttributeNames: { '#k': index.pk },
        ExpressionAttributeValues: { ':v': value },
        ScanIndexForward: false,
        Limit: query.limit ?? 25
      })
    );
    return (result.Items ?? []).map((item) => TaskSlotSchema.parse(item).record as AgentTaskRecord);
  }

  async addUsage(row: AgentUsageRow): Promise<void> {
    await this.table.doc.send(
      new UpdateCommand({
        TableName: this.table.tableName,
        Key: { pk: usagePk(row.leagueId, row.week), sk: `AGENT#${row.agentId}#MODEL#${row.modelKey}` },
        UpdateExpression:
          'SET #league = :league, #week = :week, #agent = :agent, #model = :model ADD #in :in, #out :out, #cost :cost, #tasks :tasks',
        ExpressionAttributeNames: {
          '#league': 'leagueId',
          '#week': 'week',
          '#agent': 'agentId',
          '#model': 'modelKey',
          '#in': 'inputTokens',
          '#out': 'outputTokens',
          '#cost': 'costUsd',
          '#tasks': 'tasks'
        },
        ExpressionAttributeValues: {
          ':league': row.leagueId,
          ':week': row.week,
          ':agent': row.agentId,
          ':model': row.modelKey,
          ':in': row.inputTokens,
          ':out': row.outputTokens,
          ':cost': row.costUsd,
          ':tasks': row.tasks
        }
      })
    );
  }

  async weekUsage(leagueId: string, week: number): Promise<AgentUsageRow[]> {
    const items = await this.#queryPrefix(usagePk(leagueId, week), 'AGENT#', true, 500);
    return items.map((item) => AgentUsageRowSchema.parse(item));
  }

  async getTriggerState(leagueId: string, agentId: string): Promise<AgentTriggerState | null> {
    const item = await this.#get(stateKey(leagueId, agentId));
    return item === undefined ? null : StateSchema.parse(item);
  }

  async putTriggerState(state: AgentTriggerState): Promise<void> {
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: { ...stateKey(state.leagueId, state.agentId), ...state }
      })
    );
  }

  async claimLimit(input: LimitClaim): Promise<LimitClaimResult> {
    const key = limitKey(input.leagueId, input.key);
    const since = input.now.getTime() - input.windowMs;
    for (let attempt = 0; attempt < LIMIT_CLAIM_ATTEMPTS; attempt++) {
      const { rev, uses } = LimitSchema.parse((await this.#get(key)) ?? { rev: 0, uses: [] });
      const live = uses.filter((at) => at > since);
      if (live.length >= input.cap) return 'full';
      try {
        await this.table.doc.send(
          new PutCommand({
            TableName: this.table.tableName,
            Item: {
              ...key,
              rev: rev + 1,
              uses: [...live, input.now.getTime()],
              [TABLE_KEYS.ttl]: epochSeconds(new Date(input.now.getTime() + input.windowMs))
            },
            ConditionExpression: rev === 0 ? 'attribute_not_exists(pk)' : 'rev = :rev',
            ExpressionAttributeValues: rev === 0 ? undefined : { ':rev': rev }
          })
        );
        return 'claimed';
      } catch (error) {
        if (!isConditionalCheckFailure(error)) throw error;
      }
    }
    return 'contended';
  }

  async #get(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
    const result = await this.table.doc.send(new GetCommand({ TableName: this.table.tableName, Key: key }));
    return result.Item;
  }

  async #queryPrefix(
    pk: string,
    prefix: string,
    forward: boolean,
    limit: number
  ): Promise<Record<string, unknown>[]> {
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
        ScanIndexForward: forward,
        Limit: limit
      })
    );
    return result.Items ?? [];
  }
}
