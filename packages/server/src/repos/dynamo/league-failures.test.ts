import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { league, START } from '../../../test/support/harness.js';
import { newTeam } from '../../league/seats.js';
import { DynamoInviteRepository } from './invites.js';
import { DynamoLeagueRepository } from './leagues.js';
import { DynamoMemberRepository } from './members.js';
import { batchWrite, weekKey } from './query.js';
import type { TableContext } from './table.js';
import { DynamoTeamRepository } from './teams.js';

/** A table whose client answers every call with `respond`. */
function fakeTable(respond: () => Promise<unknown>): TableContext {
  return { tableName: 'T', doc: { send: respond } as unknown as DynamoDBDocumentClient };
}

const outage = fakeTable(() => Promise.reject(new Error('dynamo down')));
const team = newTeam({
  leagueId: 'lg',
  id: 'team-1',
  draftSlot: 1,
  settings: yahooDefaultSettings(8),
  now: new Date(START)
});
const invite = {
  id: 'i',
  leagueId: 'lg',
  tokenHash: 'h',
  email: null,
  maxUses: 1,
  uses: 0,
  expiresAt: START,
  revokedAt: null,
  createdBy: 'u',
  createdAt: START,
  version: 1
};

describe('DynamoDB league repositories under failure', () => {
  it('passes errors other than a failed condition through', async () => {
    await expect(new DynamoLeagueRepository(outage).create(league())).rejects.toThrow('dynamo down');
    await expect(new DynamoLeagueRepository(outage).update(league())).rejects.toThrow('dynamo down');
    await expect(new DynamoTeamRepository(outage).create([team])).rejects.toThrow('dynamo down');
    await expect(new DynamoTeamRepository(outage).update(team)).rejects.toThrow('dynamo down');
    await expect(new DynamoTeamRepository(outage).deleteUnowned('lg', 'team-1')).rejects.toThrow(
      'dynamo down'
    );
    await expect(
      new DynamoMemberRepository(outage).add({ leagueId: 'lg', userId: 'u', teamId: 't', joinedAt: START })
    ).rejects.toThrow('dynamo down');
    await expect(new DynamoInviteRepository(outage).update(invite)).rejects.toThrow('dynamo down');
  });

  it('retries unprocessed batch writes, then gives up', async () => {
    let calls = 0;
    const throttled = fakeTable(async () => {
      calls++;
      return { UnprocessedItems: { T: [{ DeleteRequest: { Key: { pk: 'a', sk: 'b' } } }] } };
    });
    await expect(batchWrite(throttled, [{ DeleteRequest: { Key: { pk: 'a', sk: 'b' } } }])).rejects.toThrow(
      'kept throttling'
    );
    expect(calls).toBe(8);
    let second = 0;
    const recovers = fakeTable(async () =>
      ++second === 1 ? { UnprocessedItems: { T: [{ DeleteRequest: { Key: { pk: 'a', sk: 'b' } } }] } } : {}
    );
    await batchWrite(recovers, [{ DeleteRequest: { Key: { pk: 'a', sk: 'b' } } }]);
    expect(second).toBe(2);
  });

  it('pads week keys so they sort', () => {
    expect(weekKey(5)).toBe('W05');
    expect(weekKey(17)).toBe('W17');
  });
});
