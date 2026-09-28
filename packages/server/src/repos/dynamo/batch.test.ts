import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { batchGet, batchPut } from './batch.js';
import { DynamoNewsRepository, DynamoNflStateRepository } from './reference.js';
import type { TableContext } from './table.js';

/** A document client that answers each `send` from a script and records the inputs. */
function scripted(responses: (unknown | Error)[]): TableContext & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  const doc = {
    send: async (command: { input: unknown }) => {
      inputs.push(command.input);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      return next;
    }
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, tableName: 'T', inputs };
}

describe('batchPut', () => {
  it('retries unprocessed items until they are written', async () => {
    const table = scripted([
      { UnprocessedItems: { T: [{ PutRequest: { Item: { pk: 'b' } } }, { DeleteRequest: { Key: {} } }] } },
      {}
    ]);
    await batchPut(table, [{ pk: 'a' }, { pk: 'b' }]);
    expect(table.inputs).toEqual([
      { RequestItems: { T: [{ PutRequest: { Item: { pk: 'a' } } }, { PutRequest: { Item: { pk: 'b' } } }] } },
      { RequestItems: { T: [{ PutRequest: { Item: { pk: 'b' } } }] } }
    ]);
  });

  it('gives up when DynamoDB keeps throttling', async () => {
    const table = scripted([{ UnprocessedItems: { T: [{ PutRequest: { Item: { pk: 'a' } } }] } }]);
    await expect(batchPut(table, [{ pk: 'a' }])).rejects.toThrow(/throttling a batch write/);
    expect(table.inputs).toHaveLength(8);
  });
});

describe('batchGet', () => {
  it('retries unprocessed keys and gives up eventually', async () => {
    const ok = scripted([
      { Responses: { T: [{ pk: 'a' }] }, UnprocessedKeys: { T: { Keys: [{ pk: 'b' }] } } },
      { Responses: { T: [{ pk: 'b' }] } }
    ]);
    expect(await batchGet(ok, [{ pk: 'a' }, { pk: 'b' }])).toEqual([{ pk: 'a' }, { pk: 'b' }]);

    const stuck = scripted([{ UnprocessedKeys: { T: { Keys: [{ pk: 'a' }] } } }]);
    await expect(batchGet(stuck, [{ pk: 'a' }])).rejects.toThrow(/throttling a batch read/);
  });
});

describe('conditional writes', () => {
  it('rethrow errors that are not condition failures', async () => {
    const boom = new Error('ProvisionedThroughputExceeded');
    const state = new DynamoNflStateRepository(scripted([boom]));
    await expect(
      state.put(
        {
          season: 2025,
          seasonType: 'regular',
          week: 1,
          displayWeek: 1,
          leagueSeason: 2025,
          previousSeason: 2024,
          seasonStartDate: null,
          updatedAt: 'x'
        },
        null
      )
    ).rejects.toThrow(boom);
    const news = new DynamoNewsRepository(scripted([boom]));
    await expect(
      news.add({
        id: 'n',
        url: 'https://x.example',
        title: 't',
        source: 's',
        publishedAt: '2025-01-01T00:00:00.000Z',
        summary: null,
        playerIds: [],
        teams: [],
        ingestedAt: '2025-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow(boom);
  });
});
