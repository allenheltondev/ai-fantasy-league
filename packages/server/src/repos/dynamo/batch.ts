import {
  BatchGetCommand,
  BatchWriteCommand,
  QueryCommand,
  type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';
import { chunk, type TableContext } from './table.js';

const MAX_BATCH_ATTEMPTS = 8;

/** Puts items in batches of 25, retrying unprocessed items. */
export async function batchPut(
  table: TableContext,
  items: readonly Record<string, unknown>[]
): Promise<void> {
  for (const batch of chunk(items, 25)) {
    let requests = batch.map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt >= MAX_BATCH_ATTEMPTS) throw new Error('DynamoDB kept throttling a batch write');
      const result = await table.doc.send(
        new BatchWriteCommand({ RequestItems: { [table.tableName]: requests } })
      );
      requests = (result.UnprocessedItems?.[table.tableName] ?? []).flatMap((r) =>
        r.PutRequest?.Item === undefined ? [] : [{ PutRequest: { Item: r.PutRequest.Item } }]
      );
    }
  }
}

/** Deletes items by key in batches of 25, retrying unprocessed deletes. */
export async function batchDelete(
  table: TableContext,
  keys: readonly Record<string, unknown>[]
): Promise<void> {
  for (const batch of chunk(keys, 25)) {
    let requests = batch.map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt >= MAX_BATCH_ATTEMPTS) throw new Error('DynamoDB kept throttling a batch delete');
      const result = await table.doc.send(
        new BatchWriteCommand({ RequestItems: { [table.tableName]: requests } })
      );
      requests = (result.UnprocessedItems?.[table.tableName] ?? []).flatMap((r) =>
        r.DeleteRequest?.Key === undefined ? [] : [{ DeleteRequest: { Key: r.DeleteRequest.Key } }]
      );
    }
  }
}

/** Gets items by key in batches of 100, retrying unprocessed keys. Order is not preserved. */
export async function batchGet(
  table: TableContext,
  keys: readonly Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const batch of chunk(keys, 100)) {
    let pending: Record<string, unknown>[] = batch;
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= MAX_BATCH_ATTEMPTS) throw new Error('DynamoDB kept throttling a batch read');
      const result = await table.doc.send(
        new BatchGetCommand({ RequestItems: { [table.tableName]: { Keys: pending } } })
      );
      out.push(...(result.Responses?.[table.tableName] ?? []));
      pending = result.UnprocessedKeys?.[table.tableName]?.Keys ?? [];
    }
  }
  return out;
}

/**
 * Runs a query to completion (following `LastEvaluatedKey`), or until `limit` items are read.
 * `TableName` is filled in.
 */
export async function queryAll(
  table: TableContext,
  input: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'>,
  limit?: number
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await table.doc.send(
      new QueryCommand({
        ...input,
        TableName: table.tableName,
        ExclusiveStartKey: cursor,
        ...(limit === undefined ? {} : { Limit: limit - items.length })
      })
    );
    items.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor !== undefined && (limit === undefined || items.length < limit));
  return items;
}
