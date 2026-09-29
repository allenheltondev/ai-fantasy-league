import { OWNER_ONLY, emptyMemory, rememberEvent } from '@fantasy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalTable, type LocalTable } from '../../src/dev/local-table.js';
import type { AgentDispatch, AgentSeatRecord, AgentTaskRecord } from '../../src/repos/agents.js';
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
      status: 'started',
      attempt: 1,
      effects: 0,
      pending: null
    });
    expect(await agents.claimTask({ taskId: record.taskId, now: T0, lockUntil })).toEqual({
      status: 'in_progress'
    });
    const later = new Date(T0.getTime() + 61_000);
    expect(await agents.claimTask({ taskId: record.taskId, now: later, lockUntil: later })).toEqual({
      status: 'started',
      attempt: 2,
      effects: 0,
      pending: null
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

  it('fences every write to the attempt holding the task, and lists expired leases for recovery (#207)', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    const record = task(leagueId, 't1', T0.toISOString());
    const { taskId } = record;
    const request = { taskId, leagueId, kind: 'lineup' };
    const lease = new Date(T0.getTime() + 60_000);
    expect(await agents.claimTask({ taskId, now: T0, lockUntil: lease, request })).toMatchObject({
      attempt: 1
    });
    const first = { taskId, attempt: 1 };
    expect(await agents.recordTaskEffect(first)).toBe(true);
    // Nothing expired yet; at the lease's end it is listed with its request.
    expect((await agents.listExpiredTaskLeases(T0, 10)).map((l) => l.taskId)).not.toContain(taskId);
    const expired = await agents.listExpiredTaskLeases(lease, 10);
    expect(expired).toContainEqual({ taskId, attempt: 1, lockUntil: lease.getTime(), request });

    // Two sweeps race to requeue it: one wins; the requeued task can be claimed at once.
    const until = new Date(lease.getTime() + 300_000);
    const requeued = await Promise.all([
      agents.requeueTaskLease({ taskId, lockUntil: lease.getTime() }, until),
      agents.requeueTaskLease({ taskId, lockUntil: lease.getTime() }, until)
    ]);
    expect(requeued.filter(Boolean)).toHaveLength(1);
    expect((await agents.listExpiredTaskLeases(lease, 10)).map((l) => l.taskId)).not.toContain(taskId);
    const second = await agents.claimTask({ taskId, now: lease, lockUntil: until });
    expect(second).toEqual({ status: 'started', attempt: 2, effects: 1, pending: null });

    // The stale first attempt is fenced off everywhere.
    const pending = {
      status: 'completed' as const,
      fallbackReason: null,
      toolsCalled: [],
      finalAction: 'none',
      reasoningSummary: 'Done.',
      usage: [],
      followUps: [{ kind: 'noop', payload: { a: 1 }, delayMs: 5 }]
    };
    expect(await agents.recordTaskEffect(first)).toBe(false);
    expect(await agents.saveTaskPending(first, pending)).toBe(false);
    expect(await agents.releaseTask(first, until, 'Error')).toBe(false);
    expect(await agents.completeTask(record, until, first)).toBe(false);

    // The live attempt checkpoints, gives the task back for a retry, and the retry sees the checkpoint.
    const live = { taskId, attempt: 2 };
    expect(await agents.saveTaskPending(live, pending)).toBe(true);
    const retryAt = new Date(lease.getTime() + 120_000);
    expect(await agents.releaseTask(live, retryAt, 'ThrottlingException')).toBe(true);
    expect((await agents.listExpiredTaskLeases(retryAt, 10)).map((l) => l.taskId)).toContain(taskId);
    expect(await agents.claimTask({ taskId, now: lease, lockUntil: until })).toEqual({
      status: 'started',
      attempt: 3,
      effects: 1,
      pending
    });
    expect(await agents.completeTask(record, until, { taskId, attempt: 3 })).toBe(true);
    expect(await agents.recordTaskEffect({ taskId, attempt: 3 })).toBe(false);
    expect((await agents.listExpiredTaskLeases(until, 10)).map((l) => l.taskId)).not.toContain(taskId);
    expect(await agents.claimTask({ taskId, now: until, lockUntil: until })).toEqual({
      status: 'done',
      record
    });
    // A claim made before #207 kept no request.
    const legacy = unique('task');
    await agents.claimTask({ taskId: legacy, now: T0, lockUntil: T0 });
    expect(await agents.listExpiredTaskLeases(T0, 100)).toContainEqual(
      expect.objectContaining({ taskId: legacy, request: null })
    );
  });

  it('admits a trigger gate atomically: once per key, a window, and the same answer for its owner (#207)', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    const gate = (owner: string, now: Date, windowMs: number | null, slot = 'league#waivers#week-5') =>
      agents.admitTrigger(leagueId, { slot, owner, now, windowMs });
    // Two events race for a once-per key: exactly one gets it; its redelivery still does.
    const raced = await Promise.all(['evt-1', 'evt-2', 'evt-3'].map((owner) => gate(owner, T0, null)));
    expect(raced.filter(Boolean)).toHaveLength(1);
    const winner = ['evt-1', 'evt-2', 'evt-3'][raced.indexOf(true)] as string;
    expect(await gate(winner, new Date(T0.getTime() + 86_400_000), null)).toBe(true);
    expect(await gate('evt-9', new Date(T0.getTime() + 86_400_000), null)).toBe(false);
    // A windowed gate opens again once the window has passed.
    expect(await gate('a', T0, 60_000, 'agent#lineup')).toBe(true);
    expect(await gate('b', new Date(T0.getTime() + 59_999), 60_000, 'agent#lineup')).toBe(false);
    expect(await gate('b', new Date(T0.getTime() + 60_000), 60_000, 'agent#lineup')).toBe(true);
    expect((await agents.getTriggerState(leagueId, 'agent#lineup'))?.lastTriggeredAt).toBe(
      new Date(T0.getTime() + 60_000).toISOString()
    );
    // A slot written before #207 (no owner) is judged by its time alone.
    await agents.putTriggerState({ leagueId, agentId: 'old', lastTriggeredAt: T0.toISOString() });
    expect(await gate('c', T0, 60_000, 'old')).toBe(false);
    expect(await gate('c', new Date(T0.getTime() + 60_000), 60_000, 'old')).toBe(true);
  });

  it('keeps a dispatch outbox: reserve once (with its gate), relay what is due, settle (#207)', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    const dispatch = (taskId: string, retryAt = T0): AgentDispatch => ({
      taskId,
      leagueId,
      request: { taskId, payload: { week: 5 } },
      at: null,
      delayMs: 0,
      state: 'reserved',
      attempts: 0,
      reservedAt: T0.toISOString(),
      retryAt: retryAt.toISOString()
    });
    const a = unique('task');
    const b = unique('task');
    const gate = { slot: 'agent#waivers', owner: a, now: T0, windowMs: 3_600_000 };
    expect(await agents.getDispatch(a)).toBeNull();
    // Racing reservations of one task: one reserves, the other finds it.
    const raced = await Promise.all([
      agents.reserveDispatch(dispatch(a), gate),
      agents.reserveDispatch(dispatch(a), gate)
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual(['exists', 'reserved']);
    expect(raced.find((r) => r.status === 'exists')).toEqual({ status: 'exists', dispatch: dispatch(a) });
    // Another task for the same agent inside the cooldown is gated, and nothing is written for it.
    expect(await agents.reserveDispatch(dispatch(b), { ...gate, owner: b })).toEqual({ status: 'gated' });
    expect(await agents.getDispatch(b)).toBeNull();
    // Without a gate it reserves; later than now it is not due yet.
    const later = new Date(T0.getTime() + 120_000);
    expect(await agents.reserveDispatch(dispatch(b, later))).toEqual({ status: 'reserved' });
    expect(await agents.reserveDispatch(dispatch(b, later))).toMatchObject({ status: 'exists' });
    const due = async (now: Date) =>
      (await agents.listDueDispatches(now, 100)).filter((d) => d.leagueId === leagueId).map((d) => d.taskId);
    expect(await due(T0)).toEqual([a]);
    expect(await due(later)).toEqual([a, b]);
    // A failed send pushes it back and counts; a settled one leaves the outbox.
    expect(await agents.failDispatch(a, new Date(T0.getTime() + 300_000))).toBe(1);
    expect(await agents.failDispatch(a, new Date(T0.getTime() + 300_000))).toBe(2);
    expect(await due(later)).toEqual([b]);
    await agents.settleDispatch(b, 'dispatched');
    await agents.settleDispatch(a, 'abandoned');
    expect(await due(new Date(T0.getTime() + 600_000))).toEqual([]);
    expect(await agents.getDispatch(a)).toMatchObject({ state: 'abandoned', attempts: 2 });
    expect(await agents.getDispatch(b)).toMatchObject({ state: 'dispatched', attempts: 0 });
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
