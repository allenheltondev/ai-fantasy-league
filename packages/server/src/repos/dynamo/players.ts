import { BatchGetCommand, BatchWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { normalizeName } from '../../players/match.js';
import {
  PLAYER_STATUSES,
  POSITIONS,
  PositionSchema,
  type Player,
  type Position
} from '../../players/model.js';
import type { PlayerRepository } from '../types.js';
import { chunk, TABLE_KEYS, type TableContext } from './table.js';

const PlayerRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  team: z.string().nullable(),
  position: PositionSchema,
  status: z.enum(PLAYER_STATUSES),
  injuryStatus: z.string().nullable(),
  aliases: z.array(z.string()),
  rank: z.number().nullable(),
  updatedAt: z.string()
});

export const playerKey = (id: string) => ({ pk: `PLAYER#${id}`, sk: 'PROFILE' });

/** The name index: one GSI1 partition per position, sorted by normalized name. */
export function playerItem(player: Player): Record<string, unknown> {
  return {
    ...playerKey(player.id),
    gsi1pk: `PLAYERIDX#${player.position}`,
    gsi1sk: `${normalizeName(player.name)}#${player.id}`,
    ...player
  };
}

const MAX_BATCH_ATTEMPTS = 8;

export class DynamoPlayerRepository implements PlayerRepository {
  constructor(private readonly table: TableContext) {}

  async get(id: string): Promise<Player | null> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: playerKey(id) })
    );
    return result.Item === undefined ? null : PlayerRecordSchema.parse(result.Item);
  }

  async getMany(ids: readonly string[]): Promise<Player[]> {
    const found = new Map<string, Player>();
    for (const batch of chunk([...new Set(ids)], 100)) {
      let keys: Record<string, unknown>[] = batch.map(playerKey);
      for (let attempt = 0; keys.length > 0 && attempt < MAX_BATCH_ATTEMPTS; attempt++) {
        const result = await this.table.doc.send(
          new BatchGetCommand({ RequestItems: { [this.table.tableName]: { Keys: keys } } })
        );
        for (const item of result.Responses?.[this.table.tableName] ?? []) {
          const player = PlayerRecordSchema.parse(item);
          found.set(player.id, player);
        }
        keys = result.UnprocessedKeys?.[this.table.tableName]?.Keys ?? [];
      }
    }
    return ids.flatMap((id) => {
      const player = found.get(id);
      return player === undefined ? [] : [player];
    });
  }

  async putMany(players: readonly Player[]): Promise<void> {
    for (const batch of chunk(players, 25)) {
      let requests: { PutRequest: { Item: Record<string, unknown> } }[] = batch.map((player) => ({
        PutRequest: { Item: playerItem(player) }
      }));
      for (let attempt = 0; requests.length > 0; attempt++) {
        if (attempt >= MAX_BATCH_ATTEMPTS) throw new Error('DynamoDB kept throttling the player write batch');
        const result = await this.table.doc.send(
          new BatchWriteCommand({ RequestItems: { [this.table.tableName]: requests } })
        );
        requests = (result.UnprocessedItems?.[this.table.tableName] ?? []).flatMap((r) =>
          r.PutRequest?.Item === undefined ? [] : [{ PutRequest: { Item: r.PutRequest.Item } }]
        );
      }
    }
  }

  async listIndex(position?: Position): Promise<Player[]> {
    const positions = position === undefined ? POSITIONS : [position];
    const shards = await Promise.all(positions.map((p) => this.#listShard(p)));
    return shards.flat();
  }

  async #listShard(position: Position): Promise<Player[]> {
    const { gsi1 } = TABLE_KEYS;
    const players: Player[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.table.doc.send(
        new QueryCommand({
          TableName: this.table.tableName,
          IndexName: gsi1.name,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': gsi1.pk },
          ExpressionAttributeValues: { ':pk': `PLAYERIDX#${position}` },
          ExclusiveStartKey: cursor
        })
      );
      for (const item of result.Items ?? []) players.push(PlayerRecordSchema.parse(item));
      cursor = result.LastEvaluatedKey;
    } while (cursor !== undefined);
    return players;
  }
}
