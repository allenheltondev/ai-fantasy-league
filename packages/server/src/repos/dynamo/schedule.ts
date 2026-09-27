import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Matchup, ScheduleRepository, StandingsSnapshot } from '../types.js';
import {
  ENTITY,
  leaguePk,
  MatchupRecordSchema,
  matchupKey,
  StandingsRecordSchema,
  standingsKey
} from './league-records.js';
import { batchWrite, queryAll, weekKey } from './query.js';
import type { TableContext } from './table.js';

export const matchupItem = (m: Matchup) => ({
  ...matchupKey(m.leagueId, m.week, m.id),
  entity: ENTITY.matchup,
  ...m
});

export class DynamoScheduleRepository implements ScheduleRepository {
  constructor(private readonly table: TableContext) {}

  async putMatchups(matchups: readonly Matchup[]): Promise<void> {
    await batchWrite(
      this.table,
      matchups.map((m) => ({ PutRequest: { Item: matchupItem(m) } }))
    );
  }

  async listMatchups(leagueId: string, week?: number): Promise<Matchup[]> {
    const prefix = week === undefined ? 'MATCHUP#' : `MATCHUP#${weekKey(week)}#`;
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':prefix': prefix }
    });
    return items
      .map((item) => MatchupRecordSchema.parse(item))
      .sort((a, b) => a.week - b.week || a.id.localeCompare(b.id));
  }

  async putStandings(snapshot: StandingsSnapshot): Promise<void> {
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: { ...standingsKey(snapshot.leagueId, snapshot.week), entity: ENTITY.standings, ...snapshot }
      })
    );
  }

  async latestStandings(leagueId: string): Promise<StandingsSnapshot | null> {
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':prefix': 'STANDINGS#' },
        ScanIndexForward: false,
        Limit: 1
      })
    );
    const item = result.Items?.[0];
    return item === undefined ? null : StandingsRecordSchema.parse(item);
  }
}
