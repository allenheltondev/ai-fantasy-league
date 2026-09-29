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
