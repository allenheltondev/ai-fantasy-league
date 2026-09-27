import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { leagueExists, staleLeague } from '../errors.js';
import { LEAGUE_PHASES, type League, type LeagueRepository } from '../types.js';
import { isConditionalCheckFailure, type TableContext } from './table.js';

const LeagueRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  season: z.number(),
  phase: z.enum(LEAGUE_PHASES),
  week: z.number().nullable(),
  commissionerSub: z.string(),
  teamCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number()
});

export const leagueKey = (id: string) => ({ pk: `LEAGUE#${id}`, sk: 'META' });

export class DynamoLeagueRepository implements LeagueRepository {
  constructor(private readonly table: TableContext) {}

  async get(leagueId: string): Promise<League | null> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: leagueKey(leagueId) })
    );
    return result.Item === undefined ? null : LeagueRecordSchema.parse(result.Item);
  }

  async create(league: League): Promise<void> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: { ...leagueKey(league.id), ...league },
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
          Item: { ...leagueKey(league.id), ...next },
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
}
