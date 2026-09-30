import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
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

/**
 * A join code is its own item, `INVITECODE#<code>` / `LOOKUP`, pointing at the invite. The invite's
 * GSI1 key already holds its token hash, and a conditional put here keeps every code unique.
 */
export const inviteCodeKey = (code: string) => ({ pk: `INVITECODE#${code}`, sk: 'LOOKUP' });

/** Counts a user's reserved join-code lookups per clock hour; the item expires two hours later. */
export const codeAttemptKey = (userId: string, now: Date) => ({
  pk: `RATE#INVITECODE#${userId}`,
  sk: `HOUR#${Math.floor(now.getTime() / HOUR_MS)}`
});

const HOUR_MS = 60 * 60 * 1000;

const CodeLookupSchema = z.object({ leagueId: z.string(), inviteId: z.string() });

export class DynamoInviteRepository implements InviteRepository {
  constructor(private readonly table: TableContext) {}

  async create(invite: Invite): Promise<boolean> {
    if (invite.code !== null) {
      try {
        await this.table.doc.send(
          new PutCommand({
            TableName: this.table.tableName,
            Item: {
              ...inviteCodeKey(invite.code),
              entity: ENTITY.inviteCode,
              leagueId: invite.leagueId,
              inviteId: invite.id,
              ttl: inviteItem(invite).ttl
            },
            ConditionExpression: 'attribute_not_exists(pk)'
          })
        );
      } catch (error) {
        if (isConditionalCheckFailure(error)) return false;
        throw error;
      }
    }
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: inviteItem(invite),
        ConditionExpression: 'attribute_not_exists(pk)'
      })
    );
    return true;
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

  async getByCode(code: string): Promise<Invite | null> {
    const found = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: inviteCodeKey(code), ConsistentRead: true })
    );
    if (found.Item === undefined) return null;
    const { leagueId, inviteId } = CodeLookupSchema.parse(found.Item);
    return this.get(leagueId, inviteId);
  }

  async takeCodeAttempt(userId: string, now: Date, limit: number): Promise<boolean> {
    try {
      await this.table.doc.send(
        new UpdateCommand({
          TableName: this.table.tableName,
          Key: codeAttemptKey(userId, now),
          UpdateExpression: 'ADD attempts :one SET #ttl = :ttl, entity = :entity',
          // One conditional write, so parallel callers cannot all read "under the limit".
          ConditionExpression: 'attribute_not_exists(attempts) OR attempts < :limit',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':limit': limit,
            ':ttl': epochSeconds(new Date(now.getTime() + 2 * HOUR_MS)),
            ':entity': ENTITY.codeAttempts
          }
        })
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async refundCodeAttempt(userId: string, now: Date): Promise<void> {
    try {
      await this.table.doc.send(
        new UpdateCommand({
          TableName: this.table.tableName,
          Key: codeAttemptKey(userId, now),
          UpdateExpression: 'ADD attempts :minusOne',
          ConditionExpression: 'attempts > :zero',
          ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 }
        })
      );
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
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
