import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Member, MemberRepository } from '../types.js';
import { ENTITY, MemberRecordSchema, memberKey } from './league-records.js';
import { queryAll } from './query.js';
import { isConditionalCheckFailure, TABLE_KEYS, type TableContext } from './table.js';

/** GSI1 `USER#<sub>` / `LEAGUE#<leagueId>`: "my leagues" is one query. */
export const memberItem = (member: Member) => ({
  ...memberKey(member.leagueId, member.userId),
  entity: ENTITY.member,
  GSI1PK: `USER#${member.userId}`,
  GSI1SK: `LEAGUE#${member.leagueId}`,
  ...member
});

export class DynamoMemberRepository implements MemberRepository {
  constructor(private readonly table: TableContext) {}

  async get(leagueId: string, userId: string): Promise<Member | null> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: memberKey(leagueId, userId),
        ConsistentRead: true
      })
    );
    return result.Item === undefined ? null : MemberRecordSchema.parse(result.Item);
  }

  async add(member: Member): Promise<boolean> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: memberItem(member),
          ConditionExpression: 'attribute_not_exists(pk)'
        })
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async remove(leagueId: string, userId: string): Promise<void> {
    await this.table.doc.send(
      new DeleteCommand({ TableName: this.table.tableName, Key: memberKey(leagueId, userId) })
    );
  }

  async listByUser(userId: string): Promise<Member[]> {
    const { gsi1 } = TABLE_KEYS;
    const items = await queryAll(this.table, {
      IndexName: gsi1.name,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': gsi1.pk },
      ExpressionAttributeValues: { ':pk': `USER#${userId}` }
    });
    return items.map((item) => MemberRecordSchema.parse(item));
  }
}
