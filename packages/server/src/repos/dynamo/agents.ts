import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type UpdateCommandInput
} from '@aws-sdk/lib-dynamodb';
import {
  AgentAgendaSchema,
  emptyAgenda,
  AgentLeagueMemorySchema,
  PlayerAttachmentsSchema,
  emptyAttachments,
  type AgentAgenda,
  type AgentLeagueMemory,
  type PlayerAttachments
} from '@fantasy/core';
import { z } from 'zod';
import {
  AGENT_DISPATCH_STATES,
  AgentSeatRecordSchema,
  AgentTaskPendingSchema,
  AgentTaskRecordSchema,
  AgentUsageRowSchema,
  LIMIT_CLAIM_ATTEMPTS,
  gateCutoff,
  roundUsd,
  staleSeat,
  type AgentDispatch,
  type AgentDispatchReservation,
  type AgentRepository,
  type AgentSeatRecord,
  type AgentTaskClaim,
  type AgentTaskClaimInput,
  type AgentTaskFence,
  type AgentTaskLease,
  type AgentTaskPending,
  type AgentTaskRecord,
  type AgentTriggerState,
  type AgentUsageEntry,
  type AgentUsageRow,
  type BudgetAdmission,
  type BudgetHold,
  type BudgetHoldRef,
  type LimitClaim,
  type LimitClaimResult,
  type TriggerGate
} from '../agents.js';
import { TABLE_KEYS, epochSeconds, isConditionalCheckFailure, type TableContext } from './table.js';

/**
 * Key layout:
 * - Seat (current):   pk LEAGUE#<leagueId>  sk AGENTSEAT#<teamId>
 * - Seat history:     pk LEAGUE#<leagueId>  sk AGENTSEATV#<teamId>#<version, 6 digits>
 * - Agent memory:     pk LEAGUE#<leagueId>  sk AGENTMEM#<agentId>  (notes, rivals, trades, decisions, chat; rev)
 * - Attachments:      pk LEAGUE#<leagueId>  sk AGENTATTACH#<agentId>#<tenure>  (#216; rev)
 * - Trigger state:    pk LEAGUE#<leagueId>  sk AGENTSTATE#<agentId>
 * - Limit (#196):     pk LEAGUE#<leagueId>  sk AGENTLIMIT#<key>     (rev, uses: epoch ms; TTL)
 * - Task:             pk AGENTTASK#<taskId> sk STATUS
 *                     (state running|retry|complete, lockUntil, attempt, effects, pending, request)
 *                     GSI1 AGENTLEASE / <lockUntil, 15 digits>#<taskId>          (while running or retry)
 *                     GSI1 AGENTTASKS#<leagueId> / <startedAt>#<taskId>     (once complete)
 *                     GSI2 AGENTTASKS#<leagueId>#<teamId> / <startedAt>#<taskId>
 * - Dispatch (#207):  pk AGENTTASK#<taskId> sk DISPATCH  (the outbox row; TTL)
 *                     GSI1 AGENTOUTBOX / <retryAt, 15 digits>#<taskId>          (while reserved)
 * - Weekly usage:     pk AGENTUSAGE#<leagueId>#W<week> sk AGENT#<agentId>#MODEL#<modelKey>
 * - Week budget:      pk AGENTUSAGE#<leagueId>#W<week> sk BUDGET  (rev, reservedUsd: what holds keep)
 * - Budget hold:      pk AGENTTASK#<taskId> sk HOLD#<key>   (#209: a model call's estimate, while it runs)
 *                     GSI1 AGENTHOLD / <expiresAt, 15 digits>#<taskId>#<key>
 * - Usage ledger:     pk AGENTTASK#<taskId> sk USAGE#<key>  (#209: what was charged, once per key; TTL)
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
/** Player attachments (#216): a new occupant's tenure is a new row, so it starts empty. */
const attachmentsKey = (leagueId: string, agentId: string, tenure: string) => ({
  pk: leaguePk(leagueId),
  sk: `AGENTATTACH#${agentId}#${tenure}`
});
const stateKey = (leagueId: string, agentId: string) => ({
  pk: leaguePk(leagueId),
  sk: `AGENTSTATE#${agentId}`
});
const limitKey = (leagueId: string, key: string) => ({ pk: leaguePk(leagueId), sk: `AGENTLIMIT#${key}` });
const taskKey = (taskId: string) => ({ pk: `AGENTTASK#${taskId}`, sk: 'STATUS' });
const dispatchKey = (taskId: string) => ({ pk: `AGENTTASK#${taskId}`, sk: 'DISPATCH' });
/** Epoch ms as a sort key that orders as time. */
const timeKey = (ms: number, taskId: string) => `${String(Math.max(0, ms)).padStart(15, '0')}#${taskId}`;
const LEASES = 'AGENTLEASE';
const OUTBOX = 'AGENTOUTBOX';
/** How long a dispatch row is kept. */
const DISPATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const usagePk = (leagueId: string, week: number) => `AGENTUSAGE#${leagueId}#W${week}`;
const budgetKey = (leagueId: string, week: number) => ({ pk: usagePk(leagueId, week), sk: 'BUDGET' });
const holdKey = (taskId: string, key: string) => ({ pk: `AGENTTASK#${taskId}`, sk: `HOLD#${key}` });
const ledgerKey = (taskId: string, key: string) => ({ pk: `AGENTTASK#${taskId}`, sk: `USAGE#${key}` });
const HOLDS = 'AGENTHOLD';
/** How long ledger lines are kept (as long as task records). */
const LEDGER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const MemorySchema = AgentLeagueMemorySchema.extend({ rev: z.number() });
const TaskSlotSchema = z.object({
  state: z.enum(['running', 'retry', 'complete']),
  lockUntil: z.number(),
  attempt: z.number().int().default(1),
  effects: z.number().int().default(0),
  pending: AgentTaskPendingSchema.optional(),
  request: z.record(z.string(), z.unknown()).optional(),
  record: AgentTaskRecordSchema.optional()
});
const DispatchSchema = z.object({
  taskId: z.string(),
  leagueId: z.string(),
  request: z.record(z.string(), z.unknown()),
  at: z.string().nullable(),
  delayMs: z.number(),
  state: z.enum(AGENT_DISPATCH_STATES),
  attempts: z.number().int(),
  reservedAt: z.string(),
  retryAt: z.string()
});
const StateSchema = z.object({ leagueId: z.string(), agentId: z.string(), lastTriggeredAt: z.string() });
const LimitSchema = z.object({ rev: z.number(), uses: z.array(z.number()) });
const BudgetSchema = z.object({ rev: z.number().default(0), reservedUsd: z.number().default(0) });
const HoldSchema = z.object({
  leagueId: z.string(),
  week: z.number().int(),
  agentId: z.string(),
  taskId: z.string(),
  key: z.string(),
  modelKey: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  expiresAt: z.string()
});

/** Why each item of a canceled transaction was refused (`ConditionalCheckFailed`, `None`, ...). */
function cancellationCodes(error: unknown): (string | undefined)[] | null {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return null;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return (reasons ?? []).map((r) => r.Code);
}

export class DynamoAgentRepository implements AgentRepository {
  constructor(private readonly table: TableContext) {}

  async getAgenda(leagueId: string, agentId: string, tenure: string): Promise<AgentAgenda> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: { pk: leaguePk(leagueId), sk: `AGENTAGENDA#${agentId}#${tenure}` },
        ConsistentRead: true
      })
    );
    return AgentAgendaSchema.parse(result.Item ?? emptyAgenda());
  }

  async updateAgenda(
    leagueId: string,
    agentId: string,
    tenure: string,
    update: (agenda: AgentAgenda) => AgentAgenda
  ): Promise<AgentAgenda> {
    const key = { pk: leaguePk(leagueId), sk: `AGENTAGENDA#${agentId}#${tenure}` };
    for (let attempt = 0; ; attempt++) {
      const result = await this.table.doc.send(
        new GetCommand({
          TableName: this.table.tableName,
          Key: key,
          ConsistentRead: true
        })
      );
      const current = AgentAgendaSchema.parse(result.Item ?? emptyAgenda());
      const rev = result.Item === undefined ? 0 : z.number().int().positive().parse(result.Item.rev);
      const next = AgentAgendaSchema.parse(update(current));
      try {
        await this.table.doc.send(
          new PutCommand({
            TableName: this.table.tableName,
            Item: { ...key, ...next, rev: rev + 1 },
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

  async getAttachments(leagueId: string, agentId: string, tenure: string): Promise<PlayerAttachments> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: attachmentsKey(leagueId, agentId, tenure),
        ConsistentRead: true
      })
    );
    return PlayerAttachmentsSchema.parse(result.Item ?? emptyAttachments());
  }

  /** One schema-versioned row per league, agent, and tenure; compare-and-swap on `rev`. */
  async updateAttachments(
    leagueId: string,
    agentId: string,
    tenure: string,
    update: (attachments: PlayerAttachments) => PlayerAttachments
  ): Promise<PlayerAttachments> {
    const key = attachmentsKey(leagueId, agentId, tenure);
    for (let attempt = 0; ; attempt++) {
      const result = await this.table.doc.send(
        new GetCommand({ TableName: this.table.tableName, Key: key, ConsistentRead: true })
      );
      const current = PlayerAttachmentsSchema.parse(result.Item ?? emptyAttachments());
      const rev = result.Item === undefined ? 0 : z.number().int().positive().parse(result.Item.rev);
      const next = PlayerAttachmentsSchema.parse(update(current));
      try {
        await this.table.doc.send(
          new PutCommand({
            TableName: this.table.tableName,
            Item: { ...key, ...next, rev: rev + 1 },
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

  async claimTask(input: AgentTaskClaimInput): Promise<AgentTaskClaim> {
    const lockUntil = input.lockUntil.getTime();
    try {
      const result = await this.table.doc.send(
        new UpdateCommand({
          TableName: this.table.tableName,
          Key: taskKey(input.taskId),
          UpdateExpression: `SET #state = :running, lockUntil = :lock, effects = if_not_exists(effects, :zero), #g1pk = :lease, #g1sk = :leaseSk${
            input.request === undefined ? '' : ', #request = :request'
          } ADD attempt :one`,
          ConditionExpression:
            'attribute_not_exists(pk) OR #state = :retry OR (#state = :running AND lockUntil <= :now)',
          ExpressionAttributeNames: {
            '#state': 'state',
            '#g1pk': TABLE_KEYS.gsi1.pk,
            '#g1sk': TABLE_KEYS.gsi1.sk,
            ...(input.request === undefined ? {} : { '#request': 'request' })
          },
          ExpressionAttributeValues: {
            ':running': 'running',
            ':retry': 'retry',
            ':lock': lockUntil,
            ':now': input.now.getTime(),
            ':zero': 0,
            ':one': 1,
            ':lease': LEASES,
            ':leaseSk': timeKey(lockUntil, input.taskId),
            ...(input.request === undefined ? {} : { ':request': input.request })
          },
          ReturnValues: 'ALL_NEW'
        })
      );
      const slot = TaskSlotSchema.parse(result.Attributes);
      return {
        status: 'started',
        attempt: slot.attempt,
        effects: slot.effects,
        pending: slot.pending ?? null
      };
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
    const item = await this.#get(taskKey(input.taskId));
    const slot = TaskSlotSchema.parse(item);
    if (slot.state === 'complete' && slot.record !== undefined)
      return { status: 'done', record: slot.record };
    return { status: 'in_progress' };
  }

  async completeTask(record: AgentTaskRecord, expiresAt: Date, fence?: AgentTaskFence): Promise<boolean> {
    const sortKey = `${record.startedAt}#${record.taskId}`;
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: {
            ...taskKey(record.taskId),
            state: 'complete',
            lockUntil: 0,
            ...(fence === undefined ? {} : { attempt: fence.attempt }),
            record,
            [TABLE_KEYS.gsi1.pk]: `AGENTTASKS#${record.leagueId}`,
            [TABLE_KEYS.gsi1.sk]: sortKey,
            [TABLE_KEYS.gsi2.pk]: `AGENTTASKS#${record.leagueId}#${record.teamId}`,
            [TABLE_KEYS.gsi2.sk]: sortKey,
            [TABLE_KEYS.ttl]: epochSeconds(expiresAt)
          },
          ...(fence === undefined ? {} : this.#fenced(fence))
        })
      );
      return true;
    } catch (error) {
      if (fence !== undefined && isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  recordTaskEffect(fence: AgentTaskFence): Promise<boolean> {
    return this.#updateFenced(fence, 'ADD effects :one', { ':one': 1 });
  }

  saveTaskPending(fence: AgentTaskFence, pending: AgentTaskPending): Promise<boolean> {
    return this.#updateFenced(fence, 'SET pending = :pending', { ':pending': pending });
  }

  releaseTask(fence: AgentTaskFence, retryAt: Date, reason: string): Promise<boolean> {
    return this.#updateFenced(
      fence,
      'SET #state = :retry, lockUntil = :lock, lastError = :reason, #g1sk = :leaseSk',
      {
        ':retry': 'retry',
        ':lock': retryAt.getTime(),
        ':reason': reason,
        ':leaseSk': timeKey(retryAt.getTime(), fence.taskId)
      },
      { '#g1sk': TABLE_KEYS.gsi1.sk }
    );
  }

  async listExpiredTaskLeases(now: Date, limit: number): Promise<AgentTaskLease[]> {
    const items = await this.#queryDue(LEASES, now, limit);
    return items.map((item) => {
      const slot = TaskSlotSchema.parse(item);
      return {
        taskId: String(item.pk).slice('AGENTTASK#'.length),
        attempt: slot.attempt,
        lockUntil: slot.lockUntil,
        request: slot.request ?? null
      };
    });
  }

  async requeueTaskLease(lease: Pick<AgentTaskLease, 'taskId' | 'lockUntil'>, until: Date): Promise<boolean> {
    try {
      await this.table.doc.send(
        new UpdateCommand({
          TableName: this.table.tableName,
          Key: taskKey(lease.taskId),
          UpdateExpression: 'SET #state = :retry, lockUntil = :until, #g1sk = :leaseSk',
          ConditionExpression: 'lockUntil = :seen AND #state <> :complete',
          ExpressionAttributeNames: { '#state': 'state', '#g1sk': TABLE_KEYS.gsi1.sk },
          ExpressionAttributeValues: {
            ':retry': 'retry',
            ':complete': 'complete',
            ':until': until.getTime(),
            ':seen': lease.lockUntil,
            ':leaseSk': timeKey(until.getTime(), lease.taskId)
          }
        })
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  /** The condition that a write is for the attempt holding the task. */
  #fenced(fence: AgentTaskFence) {
    return {
      ConditionExpression: 'attempt = :attempt AND #state <> :complete',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':attempt': fence.attempt, ':complete': 'complete' }
    };
  }

  async #updateFenced(
    fence: AgentTaskFence,
    expression: string,
    values: Record<string, unknown>,
    names: Record<string, string> = {}
  ): Promise<boolean> {
    const condition = this.#fenced(fence);
    const command: UpdateCommandInput = {
      TableName: this.table.tableName,
      Key: taskKey(fence.taskId),
      UpdateExpression: expression,
      ConditionExpression: condition.ConditionExpression,
      ExpressionAttributeNames: { ...condition.ExpressionAttributeNames, ...names },
      ExpressionAttributeValues: { ...condition.ExpressionAttributeValues, ...values }
    };
    try {
      await this.table.doc.send(new UpdateCommand(command));
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
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
    await this.table.doc.send(new UpdateCommand(this.#rollupUpdate(row)));
  }

  /** The rollup row's update: adds tokens, cost, and tasks for (league, week, agent, model). */
  #rollupUpdate(row: AgentUsageRow) {
    return {
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
    };
  }

  async weekUsage(leagueId: string, week: number): Promise<AgentUsageRow[]> {
    const items = await this.#queryPrefix(usagePk(leagueId, week), 'AGENT#', true, 500);
    return items.map((item) => AgentUsageRowSchema.parse(item));
  }

  async reserveBudget(hold: BudgetHold, ceilingUsd: number): Promise<BudgetAdmission> {
    const budget = budgetKey(hold.leagueId, hold.week);
    for (let attempt = 0; attempt < LIMIT_CLAIM_ATTEMPTS; attempt++) {
      if ((await this.#get(holdKey(hold.taskId, hold.key), true)) !== undefined)
        return { status: 'reserved' };
      // The revision first: a settlement after this read moves it, so the write below is refused and
      // retried rather than admitting against spend read before the settlement.
      const { rev, reservedUsd } = BudgetSchema.parse((await this.#get(budget, true)) ?? {});
      const rows = await this.#queryPrefix(usagePk(hold.leagueId, hold.week), 'AGENT#', true, 500, true);
      const spentUsd = roundUsd(rows.reduce((sum, r) => sum + AgentUsageRowSchema.parse(r).costUsd, 0));
      const held = roundUsd(Math.max(0, reservedUsd));
      if (roundUsd(spentUsd + held + hold.costUsd) > ceilingUsd) {
        return { status: 'refused', spentUsd, reservedUsd: held };
      }
      try {
        await this.table.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.table.tableName,
                  Key: budget,
                  UpdateExpression: 'SET rev = :next, reservedUsd = :reserved',
                  ConditionExpression: rev === 0 ? 'attribute_not_exists(pk)' : 'rev = :rev',
                  ExpressionAttributeValues: {
                    ':next': rev + 1,
                    ':reserved': roundUsd(held + hold.costUsd),
                    ...(rev === 0 ? {} : { ':rev': rev })
                  }
                }
              },
              {
                Put: {
                  TableName: this.table.tableName,
                  Item: {
                    ...holdKey(hold.taskId, hold.key),
                    ...hold,
                    [TABLE_KEYS.gsi1.pk]: HOLDS,
                    [TABLE_KEYS.gsi1.sk]: timeKey(Date.parse(hold.expiresAt), `${hold.taskId}#${hold.key}`)
                  },
                  ConditionExpression: 'attribute_not_exists(pk)'
                }
              }
            ]
          })
        );
        return { status: 'reserved' };
      } catch (error) {
        if (cancellationCodes(error) === null) throw error;
      }
    }
    return { status: 'contended' };
  }

  async recordUsage(entry: AgentUsageEntry, hold?: BudgetHoldRef): Promise<boolean> {
    const charge = {
      Put: {
        TableName: this.table.tableName,
        Item: {
          ...ledgerKey(entry.taskId, entry.key),
          ...entry,
          [TABLE_KEYS.ttl]: epochSeconds(new Date(Date.parse(entry.at) + LEDGER_TTL_MS))
        },
        ConditionExpression: 'attribute_not_exists(pk)'
      }
    };
    try {
      await this.table.doc.send(
        new TransactWriteCommand({
          // Every charge moves the week's budget revision, so an admission racing it reads again.
          TransactItems: [
            charge,
            { Update: this.#rollupUpdate(entry) },
            ...this.#release(hold ?? null, entry)
          ]
        })
      );
      return true;
    } catch (error) {
      const codes = cancellationCodes(error);
      const charged = codes?.[0] === 'ConditionalCheckFailed';
      const released = hold !== undefined && codes?.[2] === 'ConditionalCheckFailed';
      if (!charged && !released) throw error;
      if (!charged) return this.recordUsage(entry);
      if (hold !== undefined && !released) await this.#releaseHold(hold);
      return false;
    }
  }

  releaseBudget(hold: BudgetHoldRef): Promise<boolean> {
    return this.#releaseHold(hold);
  }

  async #releaseHold(hold: BudgetHoldRef): Promise<boolean> {
    try {
      await this.table.doc.send(new TransactWriteCommand({ TransactItems: this.#release(hold, hold) }));
      return true;
    } catch (error) {
      if (cancellationCodes(error)?.[0] === 'ConditionalCheckFailed') return false;
      throw error;
    }
  }

  async listStaleHolds(now: Date, limit: number): Promise<BudgetHold[]> {
    const items = await this.#queryDue(HOLDS, now, limit);
    return items.map((item) => HoldSchema.parse(item));
  }

  /**
   * Deletes a hold (only while it is held) and takes its cost off what the week keeps reserved; with
   * no hold, only moves the week's revision.
   */
  #release(hold: BudgetHoldRef | null, week: { leagueId: string; week: number }) {
    const budget = {
      Update: {
        TableName: this.table.tableName,
        Key: budgetKey(week.leagueId, week.week),
        UpdateExpression: hold === null ? 'ADD rev :one' : 'ADD rev :one, reservedUsd :minus',
        ExpressionAttributeValues: { ':one': 1, ...(hold === null ? {} : { ':minus': -hold.costUsd }) }
      }
    };
    if (hold === null) return [budget];
    return [
      {
        Delete: {
          TableName: this.table.tableName,
          Key: holdKey(hold.taskId, hold.key),
          ConditionExpression: 'attribute_exists(pk)'
        }
      },
      budget
    ];
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

  async admitTrigger(leagueId: string, gate: TriggerGate): Promise<boolean> {
    try {
      await this.table.doc.send(new UpdateCommand(this.#gateUpdate(leagueId, gate)));
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async reserveDispatch(dispatch: AgentDispatch, gate?: TriggerGate): Promise<AgentDispatchReservation> {
    const put = {
      TableName: this.table.tableName,
      Item: {
        ...dispatchKey(dispatch.taskId),
        ...dispatch,
        [TABLE_KEYS.gsi1.pk]: OUTBOX,
        [TABLE_KEYS.gsi1.sk]: timeKey(Date.parse(dispatch.retryAt), dispatch.taskId),
        [TABLE_KEYS.ttl]: epochSeconds(new Date(Date.parse(dispatch.reservedAt) + DISPATCH_TTL_MS))
      },
      ConditionExpression: 'attribute_not_exists(pk)'
    };
    try {
      if (gate === undefined) await this.table.doc.send(new PutCommand(put));
      else
        await this.table.doc.send(
          new TransactWriteCommand({
            TransactItems: [{ Update: this.#gateUpdate(dispatch.leagueId, gate) }, { Put: put }]
          })
        );
      return { status: 'reserved' };
    } catch (error) {
      const refused =
        isConditionalCheckFailure(error) ||
        (error instanceof Error && error.name === 'TransactionCanceledException');
      if (!refused) throw error;
    }
    // Refused: either the task already has a dispatch, or the gate is closed.
    const existing = await this.getDispatch(dispatch.taskId);
    return existing === null ? { status: 'gated' } : { status: 'exists', dispatch: existing };
  }

  async getDispatch(taskId: string): Promise<AgentDispatch | null> {
    const item = await this.#get(dispatchKey(taskId));
    return item === undefined ? null : DispatchSchema.parse(item);
  }

  async settleDispatch(taskId: string, state: 'dispatched' | 'abandoned'): Promise<void> {
    await this.table.doc.send(
      new UpdateCommand({
        TableName: this.table.tableName,
        Key: dispatchKey(taskId),
        UpdateExpression: 'SET #state = :state REMOVE #g1pk, #g1sk',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: {
          '#state': 'state',
          '#g1pk': TABLE_KEYS.gsi1.pk,
          '#g1sk': TABLE_KEYS.gsi1.sk
        },
        ExpressionAttributeValues: { ':state': state }
      })
    );
  }

  async failDispatch(taskId: string, retryAt: Date): Promise<number> {
    const result = await this.table.doc.send(
      new UpdateCommand({
        TableName: this.table.tableName,
        Key: dispatchKey(taskId),
        UpdateExpression: 'SET retryAt = :retryAt, #g1sk = :sk ADD attempts :one',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#g1sk': TABLE_KEYS.gsi1.sk },
        ExpressionAttributeValues: {
          ':retryAt': retryAt.toISOString(),
          ':sk': timeKey(retryAt.getTime(), taskId),
          ':one': 1
        },
        ReturnValues: 'ALL_NEW'
      })
    );
    return DispatchSchema.parse(result.Attributes).attempts;
  }

  async listDueDispatches(now: Date, limit: number): Promise<AgentDispatch[]> {
    const items = await this.#queryDue(OUTBOX, now, limit);
    return items.map((item) => DispatchSchema.parse(item));
  }

  /**
   * The gate as a conditional update of its trigger-state slot: free, already the owner's, or
   * (windowed) last taken at or before the cutoff. Items written before #207 have no owner.
   */
  #gateUpdate(leagueId: string, gate: TriggerGate) {
    const update = {
      TableName: this.table.tableName,
      Key: stateKey(leagueId, gate.slot),
      UpdateExpression: 'SET leagueId = :league, agentId = :slot, lastTriggeredAt = :now, #owner = :owner',
      ExpressionAttributeNames: { '#owner': 'owner' },
      ExpressionAttributeValues: {
        ':league': leagueId,
        ':slot': gate.slot,
        ':now': gate.now.toISOString(),
        ':owner': gate.owner
      }
    };
    if (gate.windowMs === 0) return update;
    return {
      ...update,
      ConditionExpression: `attribute_not_exists(pk) OR #owner = :owner${
        gate.windowMs === null ? '' : ' OR lastTriggeredAt <= :cutoff'
      }`,
      ExpressionAttributeValues: {
        ...update.ExpressionAttributeValues,
        ...(gate.windowMs === null ? {} : { ':cutoff': gateCutoff({ ...gate, windowMs: gate.windowMs }) })
      }
    };
  }

  /** Items in a time-keyed GSI1 partition (leases, the outbox) due at or before `now`, oldest first. */
  async #queryDue(partition: string, now: Date, limit: number): Promise<Record<string, unknown>[]> {
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        IndexName: TABLE_KEYS.gsi1.name,
        KeyConditionExpression: '#k = :k AND #s < :before',
        ExpressionAttributeNames: { '#k': TABLE_KEYS.gsi1.pk, '#s': TABLE_KEYS.gsi1.sk },
        ExpressionAttributeValues: { ':k': partition, ':before': timeKey(now.getTime() + 1, '') },
        ScanIndexForward: true,
        Limit: limit
      })
    );
    return result.Items ?? [];
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

  async #get(
    key: { pk: string; sk: string },
    consistent = false
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: key,
        ...(consistent ? { ConsistentRead: true } : {})
      })
    );
    return result.Item;
  }

  async #queryPrefix(
    pk: string,
    prefix: string,
    forward: boolean,
    limit: number,
    consistent = false
  ): Promise<Record<string, unknown>[]> {
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
        ScanIndexForward: forward,
        Limit: limit,
        ...(consistent ? { ConsistentRead: true } : {})
      })
    );
    return result.Items ?? [];
  }
}
