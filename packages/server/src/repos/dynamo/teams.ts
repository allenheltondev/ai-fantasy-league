import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { staleTeam, teamExists } from '../errors.js';
import type { Team, TeamRepository } from '../types.js';
import { ENTITY, leaguePk, TeamRecordSchema, teamKey } from './league-records.js';
import { queryAll } from './query.js';
import { isConditionalCheckFailure, type TableContext } from './table.js';

export const teamItem = (team: Team) => ({
  ...teamKey(team.leagueId, team.id),
  entity: ENTITY.team,
  ...team
});

export class DynamoTeamRepository implements TeamRepository {
  constructor(private readonly table: TableContext) {}

  async list(leagueId: string): Promise<Team[]> {
    // `TEAM#<id>#AGENT` and `TEAM#<id>#MEMORY#...` share the prefix; `entity` keeps only teams.
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'entity = :team',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':prefix': 'TEAM#', ':team': ENTITY.team },
      ConsistentRead: true
    });
    return items
      .map((item) => TeamRecordSchema.parse(item))
      .sort((a, b) => a.draftSlot - b.draftSlot || a.id.localeCompare(b.id));
  }

  async get(leagueId: string, teamId: string): Promise<Team | null> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: teamKey(leagueId, teamId),
        ConsistentRead: true
      })
    );
    return result.Item === undefined ? null : TeamRecordSchema.parse(result.Item);
  }

  async create(teams: readonly Team[]): Promise<void> {
    for (const team of teams) {
      try {
        await this.table.doc.send(
          new PutCommand({
            TableName: this.table.tableName,
            Item: teamItem(team),
            ConditionExpression: 'attribute_not_exists(pk)'
          })
        );
      } catch (error) {
        if (isConditionalCheckFailure(error)) throw teamExists(team.id);
        throw error;
      }
    }
  }

  async update(team: Team): Promise<Team> {
    const next: Team = { ...team, version: team.version + 1 };
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: teamItem(next),
          ConditionExpression: 'version = :expected',
          ExpressionAttributeValues: { ':expected': team.version }
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw staleTeam(team.id);
      throw error;
    }
    return next;
  }

  async deleteUnowned(leagueId: string, teamId: string): Promise<boolean> {
    try {
      await this.table.doc.send(
        new DeleteCommand({
          TableName: this.table.tableName,
          Key: teamKey(leagueId, teamId),
          ConditionExpression: 'attribute_not_exists(pk) OR attribute_type(ownerUserId, :null)',
          ExpressionAttributeValues: { ':null': 'NULL' }
        })
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }
}
