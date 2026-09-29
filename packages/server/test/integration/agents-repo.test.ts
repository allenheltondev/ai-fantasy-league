import { OWNER_ONLY, emptyMemory, rememberEvent } from '@fantasy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalTable, type LocalTable } from '../../src/dev/local-table.js';
import type { AgentSeatRecord, AgentTaskRecord } from '../../src/repos/agents.js';
import { createDynamoRepos } from '../../src/repos/dynamo/index.js';
import { createInMemoryRepos } from '../../src/repos/memory.js';
import type { Repos } from '../../src/repos/types.js';

let table: LocalTable;
beforeAll(async () => {
  table = await startLocalTable();
});
afterAll(() => table.close());

const backends: [string, () => Repos][] = [
  ['in-memory', () => createInMemoryRepos()],
  ['DynamoDB (DynamoDB Local)', () => createDynamoRepos(table)]
];

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;
const T0 = new Date('2026-09-10T12:00:00.000Z');

function seat(leagueId: string, teamId: string, version: number): AgentSeatRecord {
  return {
    leagueId,
    teamId,
    agentId: `${leagueId}.${teamId}`,
    config: { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' },
    version,
    updatedAt: T0.toISOString(),
    updatedBy: 'user#u'
  };
}

function task(leagueId: string, teamId: string, startedAt: string): AgentTaskRecord {
  return {
    taskId: unique('task'),
    leagueId,
    teamId,
    agentId: `${leagueId}.${teamId}`,
    kind: 'lineup',
    week: 3,
    trigger: { detailType: 'Lineup Lock Approaching', eventId: 'evt' },
    status: 'completed',
    fallbackReason: null,
    toolsCalled: [{ name: 'set_lineup', mutation: true, ok: true, errorCode: null }],
    finalAction: 'set_lineup',
    reasoningSummary: 'Started the best projected lineup.',
    latencyMs: 12,
    usage: [
      {
        modelKey: 'nova-lite',
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: 0.1,
        estimatedTokens: false
      }
    ],
    costUsd: 0.1,
    startedAt,
    finishedAt: startedAt
  };
}

describe.each(backends)('%s agent repository', (_name, make) => {
  it('versions seats, keeps history, and rejects stale writes', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    expect(await agents.getSeat(leagueId, 't1')).toBeNull();
    await expect(agents.putSeat(seat(leagueId, 't1', 2))).rejects.toMatchObject({ code: 'CONFLICT' });
    await agents.putSeat(seat(leagueId, 't1', 1));
    await expect(agents.putSeat(seat(leagueId, 't1', 1))).rejects.toMatchObject({ code: 'CONFLICT' });
    await agents.putSeat({
      ...seat(leagueId, 't1', 2),
      config: { ...seat(leagueId, 't1', 2).config, difficulty: 'rookie' }
    });
    await agents.putSeat(seat(leagueId, 't2', 1));
    expect((await agents.getSeat(leagueId, 't1'))?.config.difficulty).toBe('rookie');
    expect((await agents.listSeats(leagueId)).map((s) => s.teamId)).toEqual(['t1', 't2']);
    expect((await agents.seatHistory(leagueId, 't1')).map((s) => s.version)).toEqual([2, 1]);
    expect(await agents.seatHistory(leagueId, 't1', 1)).toHaveLength(1);
  });

  it('keeps each agent its own league memory', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    expect(await agents.getMemory(leagueId, 'a')).toEqual(emptyMemory());
    await agents.updateMemory(leagueId, 'a', (m) => rememberEvent(m, { type: 'note', text: 'one' }));
    const after = await agents.updateMemory(leagueId, 'a', (m) =>
      rememberEvent(m, {
        type: 'trade',
        teamId: 't2',
        tradeId: 'x',
        outcome: 'vetoed',
        summary: 'Vetoed.',
        at: T0.toISOString()
      })
    );
    expect(after.notes).toEqual([{ text: 'one', visibility: OWNER_ONLY }]);
    expect(after.rivals).toEqual([expect.objectContaining({ teamId: 't2', grudge: 2 })]);
    expect(await agents.getMemory(leagueId, 'a')).toEqual(after);
    expect(await agents.getMemory(leagueId, 'b')).toEqual(emptyMemory());
  });

  it('claims a task once, takes over crashed runs, and replays completed ones', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    const record = task(leagueId, 't1', '2026-09-10T12:00:01.000Z');
    const lockUntil = new Date(T0.getTime() + 60_000);
    expect(await agents.claimTask({ taskId: record.taskId, now: T0, lockUntil })).toEqual({
      status: 'started'
    });
    expect(await agents.claimTask({ taskId: record.taskId, now: T0, lockUntil })).toEqual({
      status: 'in_progress'
    });
    const later = new Date(T0.getTime() + 61_000);
    expect(await agents.claimTask({ taskId: record.taskId, now: later, lockUntil: later })).toEqual({
      status: 'started'
    });
    await agents.completeTask(record, new Date(T0.getTime() + 86_400_000));
    expect(await agents.claimTask({ taskId: record.taskId, now: later, lockUntil })).toEqual({
      status: 'done',
      record
    });
    const other = task(leagueId, 't2', '2026-09-10T12:00:02.000Z');
    await agents.completeTask(other, new Date(T0.getTime() + 86_400_000));
    expect((await agents.listTasks(leagueId)).map((t) => t.taskId)).toEqual([other.taskId, record.taskId]);
    expect((await agents.listTasks(leagueId, { teamId: 't1' })).map((t) => t.taskId)).toEqual([
      record.taskId
    ]);
    expect(await agents.listTasks(leagueId, { limit: 1 })).toHaveLength(1);
  });

  it('claims a rolling-window limit atomically: N parallel claims against a cap of 3 get exactly 3', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    const claim = (now: Date, key = 'a#chat-action') =>
      agents.claimLimit({ leagueId, key, now, windowMs: 86_400_000, cap: 3 });
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(T0)));
    expect(results.filter((r) => r === 'claimed')).toHaveLength(3);
    expect(results.filter((r) => r !== 'claimed').every((r) => r === 'full' || r === 'contended')).toBe(true);
    expect(await claim(T0)).toBe('full');
    // Another limit has its own count.
    expect(await claim(T0, 'a#dm#team-1')).toBe('claimed');
    // A day later the uses have aged out.
    const later = new Date(T0.getTime() + 86_400_001);
    expect(await Promise.all([claim(later), claim(later), claim(later), claim(later)])).toContain('full');
  });

  it('adds weekly usage rows', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    const row = {
      leagueId,
      week: 3,
      agentId: 'a',
      modelKey: 'nova-lite',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
      tasks: 1
    };
    await agents.addUsage(row);
    await agents.addUsage({ ...row, costUsd: 0.25 });
    await agents.addUsage({ ...row, modelKey: 'claude-opus-5' });
    await agents.addUsage({ ...row, week: 4 });
    const rows = await agents.weekUsage(leagueId, 3);
    expect(rows).toEqual([
      { ...row, modelKey: 'claude-opus-5' },
      { ...row, inputTokens: 20, outputTokens: 10, costUsd: 0.75, tasks: 2 }
    ]);
  });

  it('stores trigger state', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    expect(await agents.getTriggerState(leagueId, 'a')).toBeNull();
    await agents.putTriggerState({ leagueId, agentId: 'a', lastTriggeredAt: T0.toISOString() });
    expect(await agents.getTriggerState(leagueId, 'a')).toEqual({
      leagueId,
      agentId: 'a',
      lastTriggeredAt: T0.toISOString()
    });
  });
});
