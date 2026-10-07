import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput
} from '@aws-sdk/lib-dynamodb';
import { ApiError } from '../../errors.js';
import { staleTeam, teamExists } from '../errors.js';
import { backfillSeatTenure, needsSeatTenure, type Team, type TeamRepository } from '../types.js';
import {
  ENTITY,
  leaguePk,
  MemberRecordSchema,
  memberKey,
  TeamRecordSchema,
  teamKey
} from './league-records.js';
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
    const teams = items
      .map((item) => TeamRecordSchema.parse(item))
      .sort((a, b) => a.draftSlot - b.draftSlot || a.id.localeCompare(b.id));
    if (!teams.some(needsSeatTenure)) return teams;
    // Teams stored before `occupiedSince`: one more query reads the league's memberships.
    const members = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'entity = :member',
      ExpressionAttributeValues: {
        ':pk': leaguePk(leagueId),
        ':prefix': 'MEMBER#',
        ':member': ENTITY.member
      },
      ConsistentRead: true
    });
    const byUser = new Map(
      members.map((item) => MemberRecordSchema.parse(item)).map((member) => [member.userId, member])
    );
    return teams.map((team) => backfillSeatTenure(team, byUser.get(team.ownerUserId ?? '') ?? null));
  }

  async get(leagueId: string, teamId: string): Promise<Team | null> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: teamKey(leagueId, teamId),
        ConsistentRead: true
      })
    );
    if (result.Item === undefined) return null;
    const team = TeamRecordSchema.parse(result.Item);
    return needsSeatTenure(team) ? backfillSeatTenure(team, await this.#member(team)) : team;
  }

  /** The membership of the person holding the team, for `backfillSeatTenure`. */
  async #member(team: Team) {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: memberKey(team.leagueId, team.ownerUserId as string),
        ConsistentRead: true
      })
    );
    return result.Item === undefined ? null : MemberRecordSchema.parse(result.Item);
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
    const previous = await this.get(team.leagueId, team.id);
    if (previous?.version !== team.version) throw staleTeam(team.id);
    const added = team.roster.filter((id) => !previous.roster.includes(id));
    const removed = previous.roster.filter((id) => !team.roster.includes(id));
    if (added.length > 0 || removed.length > 0) {
      await this.writeRoster(previous, next, added, removed);
      return next;
    }
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

  /** Ownership and the version-checked roster change commit together, including stale-lock recovery. */
  private async writeRoster(previous: Team, next: Team, added: string[], removed: string[]): Promise<void> {
    const TableName = this.table.tableName;
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName,
          Item: teamItem(next),
          ConditionExpression: 'version = :expected',
          ExpressionAttributeValues: { ':expected': previous.version }
        }
      }
    ];
    const holders = new Map<string, string[]>();
    for (const playerId of [...added, ...removed]) {
      const Key = { pk: leaguePk(next.leagueId), sk: `OWN#${playerId}` };
      const result = await this.table.doc.send(new GetCommand({ TableName, Key, ConsistentRead: true }));
      const holder = typeof result.Item?.teamId === 'string' ? result.Item.teamId : null;
      if (added.includes(playerId)) {
        if (holder !== null && holder !== next.id) {
          const owner = await this.get(next.leagueId, holder);
          if (owner?.roster.includes(playerId))
            throw new ApiError('PLAYER_NOT_AVAILABLE', `Player ${playerId} is on another roster.`, {
              fix: 'Refresh the available players and choose another player.'
            });
          holders.set(holder, [...(holders.get(holder) ?? []), playerId]);
        }
        items.push({
          Put: {
            TableName,
            Item: { ...Key, entity: 'player_lock', leagueId: next.leagueId, playerId, teamId: next.id },
            ConditionExpression:
              holder === null
                ? 'attribute_not_exists(pk) OR attribute_type(teamId, :null)'
                : 'teamId = :holder',
            ExpressionAttributeValues: holder === null ? { ':null': 'NULL' } : { ':holder': holder }
          }
        });
      } else if (holder === next.id) {
        items.push({
          Delete: {
            TableName,
            Key,
            ConditionExpression: 'teamId = :holder',
            ExpressionAttributeValues: { ':holder': next.id }
          }
        });
      }
    }
    // One check per holder: DynamoDB forbids two transaction actions on the same item.
    for (const [holder, players] of holders) {
      items.push({
        ConditionCheck: {
          TableName,
          Key: teamKey(next.leagueId, holder),
          ConditionExpression: players.map((_, i) => `NOT contains(roster, :p${i})`).join(' AND '),
          ExpressionAttributeValues: Object.fromEntries(players.map((id, i) => [`:p${i}`, id]))
        }
      });
    }
    try {
      await this.table.doc.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') throw staleTeam(next.id);
      throw error;
    }
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
