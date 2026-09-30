import {
  OWNER_ONLY,
  claimReply,
  emptyAgenda,
  emptyAttachments,
  emptyCommitments,
  emptyMemory,
  emptySocialActs,
  observePerformance,
  openTradeInterest,
  reconcileAgenda,
  recordAcquisition,
  recordSocialAct,
  rememberEvent
} from '@fantasy/core';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startLocalTable, type LocalTable } from '../../src/dev/local-table.js';
import {
  roundUsd,
  taskCountKey,
  usageKey,
  type AgentDispatch,
  type AgentSeatRecord,
  type AgentTaskRecord,
  type AgentUsageEntry,
  type BudgetHold
} from '../../src/repos/agents.js';
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
  it('persists a separate, versioned agenda per league, agent and occupant', async () => {
    const { agents } = make();
    const leagueId = unique('agenda');
    const tenure = T0.toISOString();
    const observe = { at: tenure, taskId: 'task', week: 5, complete: false, holes: ['RB' as const] };
    expect(await agents.getAgenda(leagueId, 'a', tenure)).toEqual(emptyAgenda());
    const first = await agents.updateAgenda(leagueId, 'a', tenure, (current) =>
      reconcileAgenda(current, observe)
    );
    expect(await agents.getAgenda(leagueId, 'a', tenure)).toEqual(first);
    first.goals[0]!.missing = 99;
    expect((await agents.getAgenda(leagueId, 'a', tenure)).goals[0]?.missing).toBe(1);
    expect(await agents.getAgenda(leagueId, 'b', tenure)).toEqual(emptyAgenda());
    expect(await agents.getAgenda(leagueId, 'a', 'new-occupant')).toEqual(emptyAgenda());
    expect(await agents.getAgenda(unique('other'), 'a', tenure)).toEqual(emptyAgenda());
    expect(await agents.getMemory(leagueId, 'a')).toEqual(emptyMemory());
    await agents.updateAgenda(leagueId, 'a', tenure, (current) =>
      reconcileAgenda(current, { ...observe, at: '2026-09-11T12:00:00.000Z', holes: [] })
    );
    await agents.updateAgenda(leagueId, 'a', tenure, (current) => reconcileAgenda(current, observe));
    expect((await agents.getAgenda(leagueId, 'a', tenure)).goals[0]?.status).toBe('completed');
  });

  it('retries concurrent agenda writes without reverting a newer observation', async () => {
    const { agents } = make();
    const leagueId = unique('agenda-race');
    const tenure = T0.toISOString();
    await agents.updateAgenda(leagueId, 'a', tenure, (current) =>
      reconcileAgenda(current, { at: tenure, taskId: 'one', week: 5, complete: false, holes: ['RB'] })
    );
    await Promise.all([
      agents.updateAgenda(leagueId, 'a', tenure, (current) =>
        reconcileAgenda(current, {
          at: '2026-09-11T12:00:00.000Z',
          taskId: 'two',
          week: 5,
          complete: false,
          holes: ['RB', 'RB']
        })
      ),
      agents.updateAgenda(leagueId, 'a', tenure, (current) =>
        reconcileAgenda(current, {
          at: '2026-09-12T12:00:00.000Z',
          taskId: 'three',
          week: 5,
          complete: false,
          holes: []
        })
      )
    ]);
    expect((await agents.getAgenda(leagueId, 'a', tenure)).goals[0]?.status).toBe('completed');
  });

  it('persists attachments per league, agent and occupant, idempotently by source', async () => {
    const { agents } = make();
    const leagueId = unique('attach');
    const tenure = T0.toISOString();
    const pick = {
      sourceId: `draft:${leagueId}:1`,
      kind: 'drafted' as const,
      playerId: 'rb1',
      name: 'Robbie Back',
      position: 'RB' as const,
      at: tenure,
      round: 1
    };
    expect(await agents.getAttachments(leagueId, 'a', tenure)).toEqual(emptyAttachments());
    const first = await agents.updateAttachments(leagueId, 'a', tenure, (s) => recordAcquisition(s, pick));
    expect(await agents.getAttachments(leagueId, 'a', tenure)).toEqual(first);
    // The same source delivered again stores the same thing.
    await agents.updateAttachments(leagueId, 'a', tenure, (s) => recordAcquisition(s, pick));
    expect(await agents.getAttachments(leagueId, 'a', tenure)).toEqual(first);
    first.preferences[0]!.strength = 1;
    expect((await agents.getAttachments(leagueId, 'a', tenure)).preferences[0]?.strength).toBe(0.7);
    // A new occupant, another agent, another league, and memory or agenda see none of it.
    expect(await agents.getAttachments(leagueId, 'a', 'new-occupant')).toEqual(emptyAttachments());
    expect(await agents.getAttachments(leagueId, 'b', tenure)).toEqual(emptyAttachments());
    expect(await agents.getAttachments(unique('other'), 'a', tenure)).toEqual(emptyAttachments());
    expect(await agents.getMemory(leagueId, 'a')).toEqual(emptyMemory());
    expect(await agents.getAgenda(leagueId, 'a', tenure)).toEqual(emptyAgenda());
  });

  it('retries concurrent attachment writes so neither update is lost', async () => {
    const { agents } = make();
    const leagueId = unique('attach-race');
    const tenure = T0.toISOString();
    const pick = (n: number) => ({
      sourceId: `draft:${leagueId}:${n}`,
      kind: 'drafted' as const,
      playerId: `p${n}`,
      name: `Player ${n}`,
      position: 'WR' as const,
      at: tenure,
      round: n
    });
    await agents.updateAttachments(leagueId, 'a', tenure, (s) => recordAcquisition(s, pick(1)));
    await Promise.all([
      agents.updateAttachments(leagueId, 'a', tenure, (s) => recordAcquisition(s, pick(2))),
      agents.updateAttachments(leagueId, 'a', tenure, (s) =>
        observePerformance(s, {
          at: '2026-09-17T12:00:00.000Z',
          week: 1,
          results: [{ playerId: 'p1', points: 30, projected: 10 }]
        })
      )
    ]);
    const stored = await agents.getAttachments(leagueId, 'a', tenure);
    expect(stored.preferences.map((p) => p.playerId).sort()).toEqual(['p1', 'p2']);
    expect(stored.preferences.find((p) => p.playerId === 'p1')?.performance).toHaveLength(1);
  });

  it('persists commitments per league, agent and occupant, apart from the agenda and memory', async () => {
    const { agents } = make();
    const leagueId = unique('commit');
    const tenure = T0.toISOString();
    const interest = {
      at: tenure,
      taskId: 'look',
      selfTeamId: 'team-2',
      source: { roomId: 'dm', messageId: 'm1', fromTeamId: 'team-1', visibility: 'dm' as const },
      send: ['a'],
      receive: ['b'],
      expiresAt: '2026-09-14T12:00:00.000Z',
      agendaId: null
    };
    expect(await agents.getCommitments(leagueId, 'a', tenure)).toEqual(emptyCommitments());
    const first = await agents.updateCommitments(
      leagueId,
      'a',
      tenure,
      (book) => openTradeInterest(book, interest).book
    );
    expect(await agents.getCommitments(leagueId, 'a', tenure)).toEqual(first);
    first.commitments[0]!.status = 'fulfilled';
    expect((await agents.getCommitments(leagueId, 'a', tenure)).commitments[0]?.status).toBe('queued');
    expect(await agents.getCommitments(leagueId, 'b', tenure)).toEqual(emptyCommitments());
    expect(await agents.getCommitments(leagueId, 'a', 'new-occupant')).toEqual(emptyCommitments());
    expect(await agents.getCommitments(unique('other'), 'a', tenure)).toEqual(emptyCommitments());
    expect(await agents.getAgenda(leagueId, 'a', tenure)).toEqual(emptyAgenda());
    expect(await agents.getMemory(leagueId, 'a')).toEqual(emptyMemory());
  });

  it('persists social acts per league, agent and occupant, apart from the other agent state', async () => {
    const { agents } = make();
    const leagueId = unique('social');
    const tenure = T0.toISOString();
    const act = {
      id: 'task-1',
      taskId: 'task-1',
      act: 'callback' as const,
      reason: 'rematch',
      topic: 'callback:team-3:result:w2',
      eventKey: 'callback:w5:team-2|team-3',
      roomId: 'trash-talk',
      counterpartTeamId: 'team-3',
      evidence: ['result:w2', 'matchup:w5'],
      commitmentId: null,
      at: tenure,
      outcome: 'posted' as const,
      detail: null
    };
    expect(await agents.getSocialActs(leagueId, 'a', tenure)).toEqual(emptySocialActs());
    const first = await agents.updateSocialActs(leagueId, 'a', tenure, (book) => recordSocialAct(book, act));
    expect(await agents.getSocialActs(leagueId, 'a', tenure)).toEqual(first);
    first.acts[0]!.outcome = 'withheld';
    expect((await agents.getSocialActs(leagueId, 'a', tenure)).acts[0]?.outcome).toBe('posted');
    expect(await agents.getSocialActs(leagueId, 'b', tenure)).toEqual(emptySocialActs());
    expect(await agents.getSocialActs(leagueId, 'a', 'new-occupant')).toEqual(emptySocialActs());
    expect(await agents.getCommitments(leagueId, 'a', tenure)).toEqual(emptyCommitments());
    // Racing writers both land: the revision check retries the loser on the newer book.
    await Promise.all(
      ['task-2', 'task-3'].map((id) =>
        agents.updateSocialActs(leagueId, 'a', tenure, (book) =>
          recordSocialAct(book, { ...act, id, taskId: id })
        )
      )
    );
    expect((await agents.getSocialActs(leagueId, 'a', tenure)).acts.map((a) => a.id).sort()).toEqual([
      'task-1',
      'task-2',
      'task-3'
    ]);
  });

  it('lists only finished tasks, and no seat history for a team never seated', async () => {
    const { agents } = make();
    const leagueId = unique('unfinished');
    const running = task(leagueId, 'team-1', T0.toISOString());
    await agents.claimTask({ taskId: running.taskId, now: T0, lockUntil: new Date(T0.getTime() + 60_000) });
    expect(await agents.listTasks(leagueId)).toEqual([]);
    expect(await agents.seatHistory(leagueId, 'team-9')).toEqual([]);
  });

  it('retries racing commitment writes so only one task claims the closing line', async () => {
    const { agents } = make();
    const leagueId = unique('commit-race');
    const tenure = T0.toISOString();
    const id = 'trade_interest:m1';
    await agents.updateCommitments(
      leagueId,
      'a',
      tenure,
      (book) =>
        openTradeInterest(book, {
          at: tenure,
          taskId: 'look',
          selfTeamId: 'team-2',
          source: { roomId: 'dm', messageId: 'm1', fromTeamId: 'team-1', visibility: 'dm' },
          send: ['a'],
          receive: ['b'],
          expiresAt: '2026-09-14T12:00:00.000Z',
          agendaId: null
        }).book
    );
    const claims: boolean[] = [];
    await Promise.all(
      [0, 1].map((worker) => {
        let claimed = false;
        return agents
          .updateCommitments(leagueId, 'a', tenure, (book) => {
            const result = claimReply(book, id, {
              at: tenure,
              owner: `worker-${worker}`,
              text: 'Safe closing line.'
            });
            claimed = result.claimed;
            return result.book;
          })
          .then(() => claims.push(claimed));
      })
    );
    expect(claims.sort()).toEqual([false, true]);
    expect((await agents.getCommitments(leagueId, 'a', tenure)).commitments[0]?.reply?.state).toBe('claimed');
  });

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
    expect(after.trades).toEqual([expect.objectContaining({ teamId: 't2', outcome: 'vetoed' })]);
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
    // Leases that expire together come out in task-id order.
    await agents.claimTask({ taskId: `${legacy}-b`, now: T0, lockUntil: T0 });
    const together = (await agents.listExpiredTaskLeases(T0, 100)).map((l) => l.taskId);
    expect(together.indexOf(legacy)).toBeLessThan(together.indexOf(`${legacy}-b`));
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

  it('releases a trigger slot only for its owner, so a gate taken ahead of failed work reopens', async () => {
    const { agents } = make();
    const leagueId = unique('lg');
    const slot = 'agent#chat-burst#league#team-1';
    const take = (owner: string) => agents.admitTrigger(leagueId, { slot, owner, now: T0, windowMs: 60_000 });
    expect(await take('a')).toBe(true);
    expect(await take('b')).toBe(false);
    // Nobody else may free it, and a free slot has nothing to release.
    expect(await agents.releaseTrigger(leagueId, slot, 'b')).toBe(false);
    expect(await agents.releaseTrigger(leagueId, slot, 'a')).toBe(true);
    expect(await agents.getTriggerState(leagueId, slot)).toBeNull();
    expect(await agents.releaseTrigger(leagueId, slot, 'a')).toBe(false);
    expect(await take('b')).toBe(true);
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

  describe('budget holds and the usage ledger (#209)', () => {
    const hold = (leagueId: string, taskId: string, costUsd: number, expiresAt = T0): BudgetHold => ({
      leagueId,
      week: 3,
      agentId: 'a',
      taskId,
      key: usageKey(1, 1),
      modelKey: 'nova-lite',
      inputTokens: 100,
      outputTokens: 50,
      costUsd,
      expiresAt: expiresAt.toISOString()
    });
    const entry = (h: BudgetHold, costUsd: number, key = h.key): AgentUsageEntry => ({
      leagueId: h.leagueId,
      week: h.week,
      agentId: h.agentId,
      taskId: h.taskId,
      key,
      modelKey: h.modelKey,
      inputTokens: 80,
      outputTokens: 20,
      costUsd,
      tasks: 0,
      estimated: false,
      at: T0.toISOString()
    });
    const spent = async (repos: Repos, leagueId: string) =>
      roundUsd((await repos.agents.weekUsage(leagueId, 3)).reduce((n, r) => n + r.costUsd, 0));

    it('admits racing holds only while recorded spend and every hold fit the ceiling', async () => {
      const repos = make();
      const leagueId = unique('lg');
      await repos.agents.addUsage({ ...entry(hold(leagueId, 'x', 0), 0.6), tasks: 1 });
      // $0.40 left: of eight racing $0.15 holds, exactly two fit.
      const holds = Array.from({ length: 8 }, () => hold(leagueId, unique('t'), 0.15));
      const results = await Promise.all(holds.map((h) => repos.agents.reserveBudget(h, 1)));
      expect(results.filter((r) => r.status === 'reserved')).toHaveLength(2);
      expect(
        results
          .filter((r) => r.status !== 'reserved')
          .every((r) => ['refused', 'contended'].includes(r.status))
      ).toBe(true);
      expect(await repos.agents.reserveBudget(hold(leagueId, unique('t'), 0.15), 1)).toEqual({
        status: 'refused',
        spentUsd: 0.6,
        reservedUsd: 0.3
      });
      // Reserving the same call again is the same answer, and holds nothing more.
      const admitted = holds.filter((_, i) => results[i]?.status === 'reserved');
      expect(await repos.agents.reserveBudget(admitted[0] as BudgetHold, 1)).toEqual({ status: 'reserved' });
      expect(await repos.agents.reserveBudget(hold(leagueId, unique('t'), 0.1), 1)).toEqual({
        status: 'reserved'
      });
      // Another week has its own budget.
      expect(await repos.agents.reserveBudget({ ...hold(leagueId, unique('t'), 0.9), week: 4 }, 1)).toEqual({
        status: 'reserved'
      });
    });

    it('charges each ledger key once and releases its hold, whatever the order', async () => {
      const repos = make();
      const leagueId = unique('lg');
      const h = hold(leagueId, unique('t'), 0.5);
      expect(await repos.agents.reserveBudget(h, 1)).toEqual({ status: 'reserved' });
      expect(await repos.agents.reserveBudget(hold(leagueId, unique('t'), 0.6), 1)).toMatchObject({
        status: 'refused'
      });
      // The actual cost replaces the estimate: 0.2 recorded, nothing held.
      expect(await repos.agents.recordUsage(entry(h, 0.2), h)).toBe(true);
      expect(await spent(repos, leagueId)).toBe(0.2);
      expect(await repos.agents.reserveBudget(hold(leagueId, unique('t'), 0.8), 1)).toEqual({
        status: 'reserved'
      });
      // A duplicate (a retry, a replay, a racing reconciliation) charges nothing.
      expect(await repos.agents.recordUsage(entry(h, 0.2), h)).toBe(false);
      expect(await repos.agents.recordUsage(entry(h, 0.2))).toBe(false);
      expect(await spent(repos, leagueId)).toBe(0.2);
      expect(await repos.agents.releaseBudget(h)).toBe(false);

      // Charged without its hold first (a repair), then settled with it: the hold still goes.
      const g = hold(leagueId, unique('t'), 0);
      await repos.agents.reserveBudget(g, 1);
      expect(await repos.agents.recordUsage(entry(g, 0.05))).toBe(true);
      expect(await repos.agents.recordUsage(entry(g, 0.05), g)).toBe(false);
      // Only the $0.80 hold is left.
      const left = await repos.agents.listStaleHolds(new Date(T0.getTime() + 1), 100);
      expect(left.filter((x) => x.leagueId === leagueId).map((x) => x.costUsd)).toEqual([0.8]);
      // A hold already released (the sweep got there first) does not stop a first charge.
      const k = hold(leagueId, unique('t'), 0);
      expect(await repos.agents.recordUsage(entry(k, 0.01), k)).toBe(true);
      expect(await spent(repos, leagueId)).toBe(0.26);
      // A task's count is its own key.
      expect(await repos.agents.recordUsage({ ...entry(h, 0, taskCountKey(0)), tasks: 1 })).toBe(true);
      expect(await repos.agents.recordUsage({ ...entry(h, 0, taskCountKey(0)), tasks: 1 })).toBe(false);
      const rows = await repos.agents.weekUsage(leagueId, 3);
      expect(rows.reduce((n, r) => n + r.tasks, 0)).toBe(1);
    });

    it('releases a hold without a charge, and lists stale holds for the sweep', async () => {
      const repos = make();
      const leagueId = unique('lg');
      const early = hold(leagueId, unique('t'), 0.5, T0);
      const late = hold(leagueId, unique('t'), 0.4, new Date(T0.getTime() + 60_000));
      await repos.agents.reserveBudget(early, 1);
      await repos.agents.reserveBudget(late, 1);
      const stale = (at: number) => repos.agents.listStaleHolds(new Date(T0.getTime() + at), 10);
      expect((await stale(-1)).filter((x) => x.leagueId === leagueId)).toEqual([]);
      expect((await stale(0)).filter((x) => x.leagueId === leagueId)).toEqual([early]);
      expect((await stale(60_000)).filter((x) => x.leagueId === leagueId)).toEqual([early, late]);
      expect(await repos.agents.releaseBudget(early)).toBe(true);
      expect(await repos.agents.releaseBudget(early)).toBe(false);
      expect((await stale(60_000)).filter((x) => x.leagueId === leagueId)).toEqual([late]);
      expect(await spent(repos, leagueId)).toBe(0);
      // The released capacity is free again.
      expect(await repos.agents.reserveBudget(hold(leagueId, unique('t'), 0.6), 1)).toEqual({
        status: 'reserved'
      });
    });
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

describe('DynamoDB versioned agent rows (agenda, attachments, commitments, social acts)', () => {
  const failPuts = (error: Error, times: number) => {
    const send = table.doc.send.bind(table.doc);
    let left = times;
    return vi.spyOn(table.doc, 'send').mockImplementation((async (command: unknown) => {
      if (command instanceof PutCommand && left-- > 0) throw error;
      return send(command as never);
    }) as never);
  };
  const conflict = () => Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
  const puts = (spy: ReturnType<typeof failPuts>) =>
    spy.mock.calls.filter(([command]) => command instanceof PutCommand).length;

  it('retries a lost race, gives up after three conflicts, and never retries another failure', async () => {
    const { agents } = createDynamoRepos(table);
    const leagueId = unique('versioned');
    const tenure = T0.toISOString();
    let spy = failPuts(conflict(), 2);
    await agents.updateCommitments(leagueId, 'a', tenure, (book) => book);
    expect(puts(spy)).toBe(3);
    spy.mockRestore();
    spy = failPuts(conflict(), 3);
    await expect(agents.updateCommitments(leagueId, 'a', tenure, (book) => book)).rejects.toThrow('conflict');
    expect(puts(spy)).toBe(3);
    spy.mockRestore();
    spy = failPuts(conflict(), 1);
    await agents.updateSocialActs(leagueId, 'a', tenure, (book) => book);
    expect(puts(spy)).toBe(2);
    spy.mockRestore();
    spy = failPuts(new Error('throttled'), 1);
    await expect(agents.updateAgenda(leagueId, 'a', tenure, (agenda) => agenda)).rejects.toThrow('throttled');
    expect(puts(spy)).toBe(1);
    spy.mockRestore();
    expect(await agents.getAgenda(leagueId, 'a', tenure)).toEqual(emptyAgenda());
  });

  it('holds league memory to the same rules', async () => {
    const { agents } = createDynamoRepos(table);
    const leagueId = unique('versioned-memory');
    let spy = failPuts(conflict(), 1);
    await agents.updateMemory(leagueId, 'a', (memory) => memory);
    expect(puts(spy)).toBe(2);
    spy.mockRestore();
    spy = failPuts(conflict(), 3);
    await expect(agents.updateMemory(leagueId, 'a', (memory) => memory)).rejects.toThrow('conflict');
    spy.mockRestore();
    spy = failPuts(new Error('throttled'), 1);
    await expect(agents.updateMemory(leagueId, 'a', (memory) => memory)).rejects.toThrow('throttled');
    expect(puts(spy)).toBe(1);
    spy.mockRestore();
  });
});
