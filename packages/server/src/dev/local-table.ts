import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { createDocumentClient, tableDefinition, type TableContext } from '../repos/dynamo/table.js';

export interface LocalTable extends TableContext {
  endpoint: string;
  close(): Promise<void>;
}

/**
 * An isolated table in DynamoDB Local, which supports atomic roster transactions.
 * Start it with `docker compose up -d dynamodb` before local development or tests.
 */
export async function startLocalTable(prefix = 'FantasyTable'): Promise<LocalTable> {
  const tableName = `${prefix}-${randomUUID()}`;
  const endpoint = process.env.FANTASY_DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000';
  const doc = createDocumentClient({
    endpoint,
    region: 'us-east-1',
    maxAttempts: 2,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
  });
  try {
    await doc.send(new CreateTableCommand(tableDefinition(tableName)));
    await waitUntilTableExists(
      { client: doc, maxWaitTime: 20, minDelay: 1, maxDelay: 2 },
      { TableName: tableName }
    );
  } catch (cause) {
    doc.destroy();
    throw new Error(`Cannot create local DynamoDB table at ${endpoint}. Run docker compose up -d dynamodb.`, {
      cause
    });
  }
  return {
    doc,
    tableName,
    endpoint,
    close: async () => {
      try {
        await doc.send(new DeleteTableCommand({ TableName: tableName }));
      } finally {
        doc.destroy();
      }
    }
  };
}
