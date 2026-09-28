import { BatchWriteCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { chunk, type TableContext } from './table.js';

type Item = Record<string, unknown>;
type WriteRequest = { PutRequest: { Item: Item } } | { DeleteRequest: { Key: Item } };

const MAX_BATCH_ATTEMPTS = 8;

/** Runs a query to the end, following `LastEvaluatedKey`. */
export async function queryAll(
  table: TableContext,
  input: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'>
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: Item | undefined;
  do {
    const result = await table.doc.send(
      new QueryCommand({ ...input, TableName: table.tableName, ExclusiveStartKey: cursor })
    );
    items.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor !== undefined);
  return items;
}

/** BatchWriteItem in groups of 25, retrying unprocessed requests. */
export async function batchWrite(table: TableContext, requests: readonly WriteRequest[]): Promise<void> {
  for (const batch of chunk(requests, 25)) {
    let pending: WriteRequest[] = batch;
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= MAX_BATCH_ATTEMPTS) throw new Error('DynamoDB kept throttling a batch write');
      const result = await table.doc.send(
        new BatchWriteCommand({ RequestItems: { [table.tableName]: pending } })
      );
      pending = (result.UnprocessedItems?.[table.tableName] ?? []) as WriteRequest[];
    }
  }
}

/** `W05`: zero-padded so sort keys order by week. */
export function weekKey(week: number): string {
  return `W${String(week).padStart(2, '0')}`;
}
