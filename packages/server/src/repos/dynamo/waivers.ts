import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  claimExists,
  staleClaim,
  TRANSACTION_TYPES,
  WAIVER_CLAIM_STATUSES,
  type TransactionPage,
  type TransactionRecord,
  type WaiverClaimRecord,
  type WaiverClaimStatus,
  type WaiverRepository,
  type WaiverRunRecord,
  type WaiverWireEntry
} from '../waivers.js';
import { leaguePk } from './league-records.js';
import { queryAll } from './query.js';
import { isConditionalCheckFailure, type TableContext } from './table.js';

/**
 * Key layout (league partition `pk = LEAGUE#<leagueId>`):
 * - Waiver claim:     sk WAIVER#<claimId>
 * - Waiver wire:      sk WAIVERWIRE#<playerId>        (the latest drop and when he clears)
 * - Transaction:      sk TXN#<at>#<txnId>             (reverse query for the log)
 * - Processing run:   sk WAIVERRUN#<YYYY-MM-DD>       (one per window; makes processing idempotent)
 * - Ownership lock:   sk OWN#<playerId>               (teamId, or null when free)
 */
const claimKey = (leagueId: string, claimId: string) => ({ pk: leaguePk(leagueId), sk: `WAIVER#${claimId}` });
const wireKey = (leagueId: string, playerId: string) => ({
  pk: leaguePk(leagueId),
  sk: `WAIVERWIRE#${playerId}`
});
const txnSk = (t: Pick<TransactionRecord, 'at' | 'id'>) => `TXN#${t.at}#${t.id}`;
const runKey = (leagueId: string, runId: string) => ({ pk: leaguePk(leagueId), sk: `WAIVERRUN#${runId}` });
const ownKey = (leagueId: string, playerId: string) => ({ pk: leaguePk(leagueId), sk: `OWN#${playerId}` });

const ClaimSchema = z.object({
  id: z.string(),
  leagueId: z.string(),
  teamId: z.string(),
  addPlayerId: z.string(),
  dropPlayerId: z.string().nullable(),
  bid: z.number(),
  priority: z.number(),
  status: z.enum(WAIVER_CLAIM_STATUSES),
  week: z.number(),
  processesAt: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  resolvedAt: z.string().nullable(),
  failure: z.object({ code: z.string(), message: z.string(), fix: z.string() }).nullable(),
  cost: z.number().nullable(),
  awardingRunId: z.string().nullable().default(null),
  version: z.number()
});
const WireSchema = z.object({
  leagueId: z.string(),
  playerId: z.string(),
  droppedByTeamId: z.string(),
  droppedAt: z.string(),
  clearsAt: z.string()
});
const TxnSchema = z.object({
  id: z.string(),
  leagueId: z.string(),
  at: z.string(),
  week: z.number(),
  type: z.enum(TRANSACTION_TYPES),
  teamId: z.string(),
  addPlayerId: z.string().nullable(),
  dropPlayerId: z.string().nullable(),
  cost: z.number().nullable(),
  claimId: z.string().nullable(),
  tradeId: z.string().nullable().optional()
});
const RunSchema = z.object({
  leagueId: z.string(),
  runId: z.string(),
  status: z.enum(['running', 'complete', 'failed']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  awarded: z.number(),
  failed: z.number()
});

export class DynamoWaiverRepository implements WaiverRepository {
  constructor(private readonly table: TableContext) {}

  async createClaim(claim: WaiverClaimRecord): Promise<void> {
    try {
      await this.#put(
        { ...claimKey(claim.leagueId, claim.id), entity: 'waiver_claim', ...claim },
        {
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw claimExists(claim.id);
      throw error;
    }
  }

  async getClaim(leagueId: string, claimId: string): Promise<WaiverClaimRecord | null> {
    const item = await this.#get(claimKey(leagueId, claimId));
    return item === undefined ? null : ClaimSchema.parse(item);
  }

  async listClaims(leagueId: string, status?: WaiverClaimStatus): Promise<WaiverClaimRecord[]> {
    const items = await this.#prefix(leagueId, 'WAIVER#');
    return items
      .map((item) => ClaimSchema.parse(item))
      .filter((c) => status === undefined || c.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async updateClaim(claim: WaiverClaimRecord): Promise<WaiverClaimRecord> {
    const next = { ...claim, version: claim.version + 1 };
    try {
      await this.#put(
        { ...claimKey(claim.leagueId, claim.id), entity: 'waiver_claim', ...next },
        {
          ConditionExpression: 'version = :expected',
          ExpressionAttributeValues: { ':expected': claim.version }
        }
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw staleClaim(claim.id);
      throw error;
    }
    return next;
  }

  async putWireEntry(entry: WaiverWireEntry): Promise<void> {
    await this.#put({ ...wireKey(entry.leagueId, entry.playerId), entity: 'waiver_wire', ...entry });
  }

  async listWire(leagueId: string): Promise<WaiverWireEntry[]> {
    return (await this.#prefix(leagueId, 'WAIVERWIRE#')).map((item) => WireSchema.parse(item));
  }

  async addTransactions(transactions: readonly TransactionRecord[]): Promise<void> {
    for (const t of transactions) {
      try {
        await this.#put(
          { pk: leaguePk(t.leagueId), sk: txnSk(t), entity: 'transaction', ...t },
          { ConditionExpression: 'attribute_not_exists(pk)' }
        );
      } catch (error) {
        if (!isConditionalCheckFailure(error)) throw error;
      }
    }
  }

  async listTransactions(
    leagueId: string,
    query: { limit: number; cursor?: string | null }
  ): Promise<TransactionPage> {
    const pk = leaguePk(leagueId);
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': 'TXN#' },
        ScanIndexForward: false,
        Limit: query.limit + 1,
        ...(query.cursor == null ? {} : { ExclusiveStartKey: { pk, sk: query.cursor } })
      })
    );
    const all = (result.Items ?? []).map((item) => TxnSchema.parse(item));
    const items = all.slice(0, query.limit);
    const last = items[items.length - 1];
    return { items, nextCursor: all.length > query.limit && last !== undefined ? txnSk(last) : null };
  }

  async listTransactionsSince(leagueId: string, since: string): Promise<TransactionRecord[]> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':from': `TXN#${since}`, ':to': 'TXN#~' }
    });
    return items.map((item) => TxnSchema.parse(item));
  }

  async beginRun(run: WaiverRunRecord, staleBefore: string): Promise<boolean> {
    try {
      await this.#put(
        { ...runKey(run.leagueId, run.runId), entity: 'waiver_run', ...run },
        {
          ConditionExpression:
            'attribute_not_exists(pk) OR #status = :failed OR (#status = :running AND startedAt < :stale)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':running': 'running', ':failed': 'failed', ':stale': staleBefore }
        }
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async completeRun(run: WaiverRunRecord): Promise<void> {
    await this.#put({ ...runKey(run.leagueId, run.runId), entity: 'waiver_run', ...run });
  }

  async getRun(leagueId: string, runId: string): Promise<WaiverRunRecord | null> {
    const item = await this.#get(runKey(leagueId, runId));
    return item === undefined ? null : RunSchema.parse(item);
  }

  async acquirePlayer(
    leagueId: string,
    playerId: string,
    teamId: string,
    staleOwner?: string
  ): Promise<boolean> {
    const values: Record<string, unknown> = { ':null': 'NULL', ':team': teamId };
    let condition = 'attribute_not_exists(pk) OR attribute_type(teamId, :null) OR teamId = :team';
    if (staleOwner !== undefined) {
      condition += ' OR teamId = :stale';
      values[':stale'] = staleOwner;
    }
    try {
      await this.#put(
        { ...ownKey(leagueId, playerId), entity: 'player_lock', leagueId, playerId, teamId },
        { ConditionExpression: condition, ExpressionAttributeValues: values }
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async releasePlayer(leagueId: string, playerId: string, teamId: string): Promise<void> {
    try {
      await this.#put(
        { ...ownKey(leagueId, playerId), entity: 'player_lock', leagueId, playerId, teamId: null },
        { ConditionExpression: 'teamId = :team', ExpressionAttributeValues: { ':team': teamId } }
      );
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
  }

  async playerOwner(leagueId: string, playerId: string): Promise<string | null> {
    const item = await this.#get(ownKey(leagueId, playerId));
    return typeof item?.teamId === 'string' ? item.teamId : null;
  }

  async #get(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: key, ConsistentRead: true })
    );
    return result.Item;
  }

  async #prefix(leagueId: string, prefix: string): Promise<Record<string, unknown>[]> {
    return queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':prefix': prefix },
      ConsistentRead: true
    });
  }

  async #put(
    item: Record<string, unknown>,
    condition: {
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    await this.table.doc.send(new PutCommand({ TableName: this.table.tableName, Item: item, ...condition }));
  }
}
