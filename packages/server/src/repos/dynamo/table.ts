import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';
import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * FantasyTable key design (docs/adr/001-table-design.md). Infra must create the
 * table with exactly these keys, GSIs, and the `ttl` TTL attribute.
 */
export const TABLE_KEYS = {
  pk: 'pk',
  sk: 'sk',
  gsi1: { name: 'GSI1', pk: 'GSI1PK', sk: 'GSI1SK' },
  gsi2: { name: 'GSI2', pk: 'GSI2PK', sk: 'GSI2SK' },
  ttl: 'ttl'
} as const;

export function tableDefinition(tableName: string): CreateTableCommandInput {
  const { gsi1, gsi2 } = TABLE_KEYS;
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: ['pk', 'sk', gsi1.pk, gsi1.sk, gsi2.pk, gsi2.sk].map((name) => ({
      AttributeName: name,
      AttributeType: 'S'
    })),
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [gsi1, gsi2].map((index) => ({
      IndexName: index.name,
      KeySchema: [
        { AttributeName: index.pk, KeyType: 'HASH' },
        { AttributeName: index.sk, KeyType: 'RANGE' }
      ],
      Projection: { ProjectionType: 'ALL' }
    }))
  };
}

export interface TableContext {
  doc: DynamoDBDocumentClient;
  tableName: string;
}

export function createDocumentClient(config: DynamoDBClientConfig = {}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(config), {
    marshallOptions: { removeUndefinedValues: true }
  });
}

export function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

export function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Splits `items` into arrays of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
