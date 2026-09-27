import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import type {
  IdempotencyBeginInput,
  IdempotencyBeginResult,
  IdempotencyRepository,
  StoredResponse
} from '../types.js';
import { epochSeconds, isConditionalCheckFailure, type TableContext } from './table.js';

export const idempotencyKey = (scope: string, key: string) => ({ pk: `IDEMP#${scope}`, sk: `KEY#${key}` });

const RecordSchema = z.object({
  operation: z.string(),
  requestHash: z.string(),
  state: z.enum(['in_progress', 'complete']),
  responseStatus: z.number().optional(),
  /** Stored as a JSON string so any response shape round-trips exactly. */
  responseBody: z.string().optional()
});

export class DynamoIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly table: TableContext) {}

  async begin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult> {
    const key = idempotencyKey(input.scope, input.key);
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: {
            ...key,
            operation: input.operation,
            requestHash: input.requestHash,
            state: 'in_progress',
            lockUntil: input.lockUntil.getTime(),
            ttl: epochSeconds(input.expiresAt)
          },
          ConditionExpression:
            'attribute_not_exists(pk) OR #ttl <= :nowSec OR (#state = :inProgress AND lockUntil <= :nowMs)',
          ExpressionAttributeNames: { '#ttl': 'ttl', '#state': 'state' },
          ExpressionAttributeValues: {
            ':nowSec': epochSeconds(input.now),
            ':nowMs': input.now.getTime(),
            ':inProgress': 'in_progress'
          }
        })
      );
      return { status: 'started' };
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
    const existing = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: key, ConsistentRead: true })
    );
    if (existing.Item === undefined) return { status: 'in_progress' };
    const record = RecordSchema.parse(existing.Item);
    if (record.requestHash !== input.requestHash) return { status: 'mismatch', operation: record.operation };
    if (
      record.state === 'complete' &&
      record.responseStatus !== undefined &&
      record.responseBody !== undefined
    ) {
      const body: unknown = JSON.parse(record.responseBody);
      return { status: 'replay', response: { status: record.responseStatus, body } };
    }
    return { status: 'in_progress' };
  }

  async complete(scope: string, key: string, response: StoredResponse, expiresAt: Date): Promise<void> {
    await this.table.doc.send(
      new UpdateCommand({
        TableName: this.table.tableName,
        Key: idempotencyKey(scope, key),
        UpdateExpression:
          'SET #state = :complete, responseStatus = :status, responseBody = :body, #ttl = :ttl',
        ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':complete': 'complete',
          ':status': response.status,
          ':body': JSON.stringify(response.body),
          ':ttl': epochSeconds(expiresAt)
        }
      })
    );
  }

  async release(scope: string, key: string): Promise<void> {
    await this.table.doc.send(
      new DeleteCommand({ TableName: this.table.tableName, Key: idempotencyKey(scope, key) })
    );
  }
}
