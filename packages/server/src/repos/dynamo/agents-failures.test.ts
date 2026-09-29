import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoAgentRepository } from './agents.js';

/** An outage is never mistaken for a lost race (#207): every conditional write rethrows it. */
describe('DynamoDB agent task lifecycle under failure', () => {
  const agents = new DynamoAgentRepository({
    tableName: 'T',
    doc: { send: () => Promise.reject(new Error('dynamo down')) } as unknown as DynamoDBDocumentClient
  });
  const now = new Date('2026-09-10T12:00:00.000Z');
  const fence = { taskId: 't', attempt: 1 };
  const dispatch = {
    taskId: 't',
    leagueId: 'lg',
    request: {},
    at: null,
    delayMs: 0,
    state: 'reserved' as const,
    attempts: 0,
    reservedAt: now.toISOString(),
    retryAt: now.toISOString()
  };
  const gate = { slot: 's', owner: 'o', now, windowMs: 60_000 };

  it.each([
    ['claimTask', () => agents.claimTask({ taskId: 't', now, lockUntil: now })],
    ['completeTask', () => agents.completeTask({ taskId: 't' } as never, now, fence)],
    ['recordTaskEffect', () => agents.recordTaskEffect(fence)],
    ['requeueTaskLease', () => agents.requeueTaskLease({ taskId: 't', lockUntil: 0 }, now)],
    ['admitTrigger', () => agents.admitTrigger('lg', gate)],
    ['reserveDispatch', () => agents.reserveDispatch(dispatch)],
    ['reserveDispatch with a gate', () => agents.reserveDispatch(dispatch, gate)]
  ])('%s rethrows', async (_name, call) => {
    await expect(call()).rejects.toThrow('dynamo down');
  });
});

/** Budget holds and the usage ledger (#209) when DynamoDB refuses or fails. */
describe('DynamoDB budget holds under failure', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const hold = {
    leagueId: 'lg',
    week: 1,
    agentId: 'a',
    taskId: 't',
    key: 'A001#C001',
    modelKey: 'nova-lite',
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0.1,
    expiresAt: now.toISOString()
  };
  const entry = { ...hold, tasks: 0, estimated: false, at: now.toISOString() };
  const canceled = (codes: string[]) =>
    Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
      ...(codes.length === 0 ? {} : { CancellationReasons: codes.map((Code) => ({ Code })) })
    });
  /** Reads find nothing; every transaction fails with `error`. */
  const repo = (error: Error) =>
    new DynamoAgentRepository({
      tableName: 'T',
      doc: {
        send: (command: { constructor: { name: string } }) =>
          command.constructor.name === 'TransactWriteCommand'
            ? Promise.reject(error)
            : Promise.resolve(command.constructor.name === 'QueryCommand' ? { Items: [] } : {})
      } as unknown as DynamoDBDocumentClient
    });

  it('gives up an admission that stays contended', async () => {
    expect(await repo(canceled(['None', 'TransactionConflict'])).reserveBudget(hold, 1)).toEqual({
      status: 'contended'
    });
  });

  it('rethrows an outage or a conflict rather than guessing what was charged', async () => {
    const down = repo(new Error('dynamo down'));
    await expect(down.reserveBudget(hold, 1)).rejects.toThrow('dynamo down');
    await expect(down.recordUsage(entry, hold)).rejects.toThrow('dynamo down');
    await expect(down.releaseBudget(hold)).rejects.toThrow('dynamo down');
    const conflict = repo(canceled(['None', 'None', 'TransactionConflict', 'None']));
    await expect(conflict.recordUsage(entry, hold)).rejects.toThrow('canceled');
    await expect(conflict.releaseBudget(hold)).rejects.toThrow('canceled');
    // A cancellation without reasons is not taken for a duplicate either.
    await expect(repo(canceled([])).recordUsage(entry)).rejects.toThrow('canceled');
  });
});
