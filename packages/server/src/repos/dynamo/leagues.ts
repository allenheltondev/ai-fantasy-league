import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { leagueExists, staleLeague } from '../errors.js';
import type { League, LeagueRepository } from '../types.js';
import { ENTITY, LeagueRecordSchema, leagueKey, leaguePk } from './league-records.js';
import { batchWrite, queryAll } from './query.js';
import { isConditionalCheckFailure, TABLE_KEYS, type TableContext } from './table.js';

/** The league item carries GSI1 `CREATOR#<sub>` so a user's created leagues (the quota) are one query. */
export function leagueItem(league: League): Record<string, unknown> {
  return {
    ...leagueKey(league.id),
    entity: ENTITY.league,
    GSI1PK: `CREATOR#${league.createdBy}`,
    GSI1SK: `LEAGUE#${league.createdAt}#${league.id}`,
    ...league
  };
}

export class DynamoLeagueRepository implements LeagueRepository {
  constructor(private readonly table: TableContext) {}

  async get(leagueId: string): Promise<League | null> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: leagueKey(leagueId), ConsistentRead: true })
    );
    return result.Item === undefined ? null : LeagueRecordSchema.parse(result.Item);
  }

  /** A user is in a handful of leagues, so parallel GetItems are simpler than a paged BatchGet. */
  async getMany(leagueIds: readonly string[]): Promise<League[]> {
    const leagues = await Promise.all(leagueIds.map((id) => this.get(id)));
    return leagues.filter((league): league is League => league !== null);
  }

  async create(league: League): Promise<void> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: leagueItem(league),
          ConditionExpression: 'attribute_not_exists(pk)'
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw leagueExists(league.id);
      throw error;
    }
  }

  async update(league: League): Promise<League> {
    const next: League = { ...league, version: league.version + 1 };
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: leagueItem(next),
          ConditionExpression: 'version = :expected',
          ExpressionAttributeValues: { ':expected': league.version }
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw staleLeague(league.id);
      throw error;
    }
    return next;
  }

  async listByCreator(userId: string): Promise<League[]> {
    const { gsi1 } = TABLE_KEYS;
    const items = await queryAll(this.table, {
      IndexName: gsi1.name,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': gsi1.pk },
      ExpressionAttributeValues: { ':pk': `CREATOR#${userId}` }
    });
    return items.map((item) => LeagueRecordSchema.parse(item));
  }

  async delete(leagueId: string): Promise<void> {
    const keys = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId) },
      ProjectionExpression: 'pk, sk'
    });
    // META goes last, so a delete interrupted part-way can be retried: the league still exists.
    const ordered = [...keys.filter((k) => k.sk !== 'META'), ...keys.filter((k) => k.sk === 'META')];
    await batchWrite(
      this.table,
      ordered.map((key) => ({ DeleteRequest: { Key: { pk: key.pk, sk: key.sk } } }))
    );
  }
}
