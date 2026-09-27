import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import type { AuditEntry, AuditQuery, AuditRepository } from '../types.js';
import { TABLE_KEYS, type TableContext } from './table.js';

const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  principal: z.string(),
  principalType: z.enum(['user', 'agent', 'anonymous']),
  teamId: z.string().nullable(),
  operation: z.string(),
  leagueId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  outcome: z.enum(['ok', 'error']),
  errorCode: z.string().nullable()
});

/** League-scoped entries live under their league; the rest are bucketed by UTC day. */
export function auditKeys(entry: AuditEntry) {
  const pk =
    entry.leagueId === null ? `AUDIT#DAY#${entry.at.slice(0, 10)}` : `AUDIT#LEAGUE#${entry.leagueId}`;
  const sk = `${entry.at}#${entry.id}`;
  return { pk, sk, gsi2pk: `AUDIT#PRINCIPAL#${entry.principal}`, gsi2sk: sk };
}

export class DynamoAuditRepository implements AuditRepository {
  constructor(private readonly table: TableContext) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.table.doc.send(
      new PutCommand({ TableName: this.table.tableName, Item: { ...auditKeys(entry), ...entry } })
    );
  }

  listByLeague(leagueId: string, query: AuditQuery = {}): Promise<AuditEntry[]> {
    return this.#query(undefined, 'pk', `AUDIT#LEAGUE#${leagueId}`, query);
  }

  listByPrincipal(principal: string, query: AuditQuery = {}): Promise<AuditEntry[]> {
    const { gsi2 } = TABLE_KEYS;
    return this.#query(gsi2.name, gsi2.pk, `AUDIT#PRINCIPAL#${principal}`, query);
  }

  async #query(
    indexName: string | undefined,
    keyName: string,
    value: string,
    query: AuditQuery
  ): Promise<AuditEntry[]> {
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        IndexName: indexName,
        KeyConditionExpression: '#k = :v',
        ExpressionAttributeNames: { '#k': keyName },
        ExpressionAttributeValues: { ':v': value },
        ScanIndexForward: false,
        Limit: query.limit ?? 50
      })
    );
    return (result.Items ?? []).map((item) => AuditEntrySchema.parse(item));
  }
}
