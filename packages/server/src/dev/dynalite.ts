/// <reference path="../types/dynalite.d.ts" />
import type { AddressInfo } from 'node:net';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import dynalite from 'dynalite';
import { createDocumentClient, tableDefinition, type TableContext } from '../repos/dynamo/table.js';

export interface LocalTable extends TableContext {
  endpoint: string;
  close(): Promise<void>;
}

/**
 * Starts an in-process DynamoDB (dynalite) on a free port and creates the
 * FantasyTable in it. Used by local dev and the integration tests.
 */
export async function startLocalTable(tableName = 'FantasyTable'): Promise<LocalTable> {
  const server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}`;
  const doc = createDocumentClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
  });
  await doc.send(new CreateTableCommand(tableDefinition(tableName)));
  return {
    doc,
    tableName,
    endpoint,
    close: async () => {
      doc.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}
