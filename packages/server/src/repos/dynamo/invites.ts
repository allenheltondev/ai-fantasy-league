import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { staleInvite } from '../errors.js';
import type { Invite, InviteRepository } from '../types.js';
import { ENTITY, InviteRecordSchema, inviteKey, leaguePk } from './league-records.js';
import { queryAll } from './query.js';
import { epochSeconds, isConditionalCheckFailure, TABLE_KEYS, type TableContext } from './table.js';

/** Expired invites stay listable for a while, then TTL removes them. */
export const INVITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** GSI1 `INVITE#<tokenHash>` / `INVITE`: accepting a link is one query on the token's hash. */
export const inviteItem = (invite: Invite) => ({
  ...inviteKey(invite.leagueId, invite.id),
  entity: ENTITY.invite,
  GSI1PK: `INVITE#${invite.tokenHash}`,
  GSI1SK: 'INVITE',
  ttl: epochSeconds(new Date(new Date(invite.expiresAt).getTime() + INVITE_RETENTION_MS)),
  ...invite
});

export class DynamoInviteRepository implements InviteRepository {
  constructor(private readonly table: TableContext) {}

  async create(invite: Invite): Promise<void> {
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: inviteItem(invite),
        ConditionExpression: 'attribute_not_exists(pk)'
      })
    );
  }

  async get(leagueId: string, inviteId: string): Promise<Invite | null> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: inviteKey(leagueId, inviteId),
        ConsistentRead: true
      })
    );
    return result.Item === undefined ? null : InviteRecordSchema.parse(result.Item);
  }

  async getByTokenHash(tokenHash: string): Promise<Invite | null> {
    const { gsi1 } = TABLE_KEYS;
    const result = await this.table.doc.send(
      new QueryCommand({
        TableName: this.table.tableName,
        IndexName: gsi1.name,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': gsi1.pk },
        ExpressionAttributeValues: { ':pk': `INVITE#${tokenHash}` },
        Limit: 1
      })
    );
    const item = result.Items?.[0];
    return item === undefined ? null : InviteRecordSchema.parse(item);
  }

  async list(leagueId: string): Promise<Invite[]> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':prefix': 'INVITE#' }
    });
    return items
      .map((item) => InviteRecordSchema.parse(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async update(invite: Invite): Promise<Invite> {
    const next: Invite = { ...invite, version: invite.version + 1 };
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: inviteItem(next),
          ConditionExpression: 'version = :expected',
          ExpressionAttributeValues: { ':expected': invite.version }
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) throw staleInvite(invite.id);
      throw error;
    }
    return next;
  }
}
