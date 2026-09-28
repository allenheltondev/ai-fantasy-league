import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalTable, type LocalTable } from '../../src/dev/dynalite.js';
import { createDynamoRepos } from '../../src/repos/dynamo/index.js';
import { createInMemoryRepos } from '../../src/repos/memory.js';
import type { Repos } from '../../src/repos/types.js';
import type { TransactionRecord, WaiverClaimRecord } from '../../src/repos/waivers.js';
import { league, START } from '../support/harness.js';

let table: LocalTable;
beforeAll(async () => {
  table = await startLocalTable();
});
afterAll(() => table.close());

/** The waiver repository's behavioral contract, run against both implementations. */
const backends: [string, () => Repos][] = [
  ['in-memory', () => createInMemoryRepos()],
  ['DynamoDB (dynalite)', () => createDynamoRepos(table)]
];

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;

function claim(leagueId: string, overrides: Partial<WaiverClaimRecord> = {}): WaiverClaimRecord {
  return {
    id: unique('claim'),
    leagueId,
    teamId: 'team-1',
    addPlayerId: 'p1',
    dropPlayerId: null,
    bid: 5,
    priority: 1,
    status: 'pending',
    week: 3,
    processesAt: '2026-09-13T08:00:00.000Z',
    createdAt: START,
    createdBy: 'user#u',
    resolvedAt: null,
    failure: null,
    cost: null,
    awardingRunId: null,
    version: 1,
    ...overrides
  };
}

function txn(
  leagueId: string,
  id: string,
  at: string,
  overrides: Partial<TransactionRecord> = {}
): TransactionRecord {
  return {
    id,
    leagueId,
    at,
    week: 3,
    type: 'add',
    teamId: 'team-1',
    addPlayerId: 'p1',
    dropPlayerId: null,
    cost: null,
    claimId: null,
    ...overrides
  };
}

describe.each(backends)('waiver repository (%s)', (_name, make) => {
  it('creates, lists, and version-checks claims', async () => {
    const repos = make();
    const leagueId = unique('lg');
    const a = claim(leagueId, { createdAt: '2026-09-10T12:00:01.000Z' });
    const b = claim(leagueId, { status: 'failed', createdAt: '2026-09-10T12:00:00.000Z' });
    await repos.waivers.createClaim(a);
    await repos.waivers.createClaim(b);
    await expect(repos.waivers.createClaim(a)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repos.waivers.listClaims(leagueId)).map((c) => c.id)).toEqual([b.id, a.id]);
    expect((await repos.waivers.listClaims(leagueId, 'pending')).map((c) => c.id)).toEqual([a.id]);
    expect(await repos.waivers.getClaim(leagueId, 'missing')).toBeNull();
    const updated = await repos.waivers.updateClaim({ ...a, priority: 2 });
    expect(updated.version).toBe(2);
    expect(await repos.waivers.getClaim(leagueId, a.id)).toMatchObject({ priority: 2, version: 2 });
    await expect(repos.waivers.updateClaim(a)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps the waiver wire and pages the transaction log newest first', async () => {
    const repos = make();
    const leagueId = unique('lg');
    const entry = { leagueId, playerId: 'p9', droppedByTeamId: 'team-1', droppedAt: START, clearsAt: START };
    await repos.waivers.putWireEntry(entry);
    await repos.waivers.putWireEntry({ ...entry, clearsAt: '2026-09-12T12:00:00.000Z' });
    expect(await repos.waivers.listWire(leagueId)).toEqual([
      { ...entry, clearsAt: '2026-09-12T12:00:00.000Z' }
    ]);

    await repos.waivers.addTransactions([
      txn(leagueId, 't1', '2026-09-10T12:00:00.000Z'),
      txn(leagueId, 't2', '2026-09-11T12:00:00.000Z'),
      txn(leagueId, 't3', '2026-09-12T12:00:00.000Z', { type: 'waiver_claim', cost: 4, claimId: 'c' })
    ]);
    await repos.waivers.addTransactions([txn(leagueId, 't3', '2026-09-12T12:00:00.000Z', { cost: 99 })]);
    const first = await repos.waivers.listTransactions(leagueId, { limit: 2 });
    expect(first.items.map((t) => t.id)).toEqual(['t3', 't2']);
    expect(first.items[0]?.cost).toBe(4);
    const second = await repos.waivers.listTransactions(leagueId, { limit: 2, cursor: first.nextCursor });
    expect(second).toMatchObject({ items: [{ id: 't1' }], nextCursor: null });
    expect(
      (await repos.waivers.listTransactionsSince(leagueId, '2026-09-11T00:00:00.000Z')).map((t) => t.id)
    ).toEqual(['t2', 't3']);
  });

  it('starts each run once, allowing a stale or failed run to be taken over', async () => {
    const repos = make();
    const leagueId = unique('lg');
    const run = {
      leagueId,
      runId: '2026-09-13',
      status: 'running' as const,
      startedAt: '2026-09-13T08:00:00.000Z',
      completedAt: null,
      awarded: 0,
      failed: 0
    };
    expect(await repos.waivers.beginRun(run, '2026-09-13T07:45:00.000Z')).toBe(true);
    expect(await repos.waivers.beginRun(run, '2026-09-13T07:50:00.000Z')).toBe(false);
    expect(
      await repos.waivers.beginRun(
        { ...run, startedAt: '2026-09-13T08:20:00.000Z' },
        '2026-09-13T08:05:00.000Z'
      )
    ).toBe(true);
    // A run that failed with an error is released: the retry takes it over at once.
    await repos.waivers.completeRun({ ...run, status: 'failed' });
    expect(await repos.waivers.getRun(leagueId, run.runId)).toMatchObject({ status: 'failed' });
    expect(await repos.waivers.beginRun(run, '2026-09-13T07:50:00.000Z')).toBe(true);
    expect(await repos.waivers.beginRun(run, '2026-09-13T07:50:00.000Z')).toBe(false);
    await repos.waivers.completeRun({ ...run, status: 'complete', completedAt: '2026-09-13T08:21:00.000Z' });
    expect(await repos.waivers.beginRun(run, '2026-09-14T00:00:00.000Z')).toBe(false);
    expect(await repos.waivers.getRun(leagueId, run.runId)).toMatchObject({ status: 'complete' });
    expect(await repos.waivers.getRun(leagueId, 'nope')).toBeNull();
  });

  it('locks a player to one team at a time', async () => {
    const repos = make();
    const leagueId = unique('lg');
    expect(await repos.waivers.playerOwner(leagueId, 'p1')).toBeNull();
    expect(await repos.waivers.acquirePlayer(leagueId, 'p1', 'team-1')).toBe(true);
    expect(await repos.waivers.acquirePlayer(leagueId, 'p1', 'team-1')).toBe(true);
    expect(await repos.waivers.acquirePlayer(leagueId, 'p1', 'team-2')).toBe(false);
    expect(await repos.waivers.acquirePlayer(leagueId, 'p1', 'team-2', 'team-3')).toBe(false);
    await repos.waivers.releasePlayer(leagueId, 'p1', 'team-2');
    expect(await repos.waivers.playerOwner(leagueId, 'p1')).toBe('team-1');
    expect(await repos.waivers.acquirePlayer(leagueId, 'p1', 'team-2', 'team-1')).toBe(true);
    await repos.waivers.releasePlayer(leagueId, 'p1', 'team-2');
    expect(await repos.waivers.playerOwner(leagueId, 'p1')).toBeNull();
    expect(await repos.waivers.acquirePlayer(leagueId, 'p1', 'team-3')).toBe(true);
  });

  it('lists leagues by phase', async () => {
    const repos = make();
    const a = league({ id: unique('lg'), phase: 'regular_season' });
    await repos.leagues.create(a);
    await repos.leagues.create(league({ id: unique('lg'), phase: 'setup' }));
    expect((await repos.leagues.listByPhase('regular_season')).map((l) => l.id)).toContain(a.id);
    expect(
      (await repos.leagues.listByPhase('regular_season')).every((l) => l.phase === 'regular_season')
    ).toBe(true);
  });
});
