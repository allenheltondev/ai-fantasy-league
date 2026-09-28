import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Lineup, LineupRepository } from '../types.js';
import { ENTITY, LineupRecordSchema, leaguePk, lineupKey } from './league-records.js';
import { batchWrite, queryAll, weekKey } from './query.js';
import type { TableContext } from './table.js';

/** Lineups live in the league partition at `LINEUP#W05#<teamId>`, so a week's lineups are one query. */
export class DynamoLineupRepository implements LineupRepository {
  constructor(private readonly table: TableContext) {}

  async get(leagueId: string, teamId: string, week: number): Promise<Lineup | null> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: lineupKey(leagueId, week, teamId),
        ConsistentRead: true
      })
    );
    return result.Item === undefined ? null : LineupRecordSchema.parse(result.Item);
  }

  /**
   * Newest first over `LINEUP#W01#` .. `LINEUP#W05#~`, filtered to the team. A season has at most
   * 18 weeks of 12 lineups, and the first page nearly always holds the answer.
   */
  async latest(leagueId: string, teamId: string, week: number): Promise<Lineup | null> {
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.table.doc.send(
        new QueryCommand({
          TableName: this.table.tableName,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          FilterExpression: 'teamId = :team',
          ExpressionAttributeValues: {
            ':pk': leaguePk(leagueId),
            ':from': 'LINEUP#W00#',
            ':to': `LINEUP#${weekKey(week)}#~`,
            ':team': teamId
          },
          ScanIndexForward: false,
          ExclusiveStartKey: cursor
        })
      );
      const item = result.Items?.[0];
      if (item !== undefined) return LineupRecordSchema.parse(item);
      cursor = result.LastEvaluatedKey;
    } while (cursor !== undefined);
    return null;
  }

  async put(lineups: readonly Lineup[]): Promise<void> {
    await batchWrite(
      this.table,
      lineups.map((l) => ({
        PutRequest: { Item: { ...lineupKey(l.leagueId, l.week, l.teamId), entity: ENTITY.lineup, ...l } }
      }))
    );
  }

  async listWeek(leagueId: string, week: number): Promise<Lineup[]> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':prefix': `LINEUP#${weekKey(week)}#` }
    });
    return items.map((item) => LineupRecordSchema.parse(item));
  }
}
