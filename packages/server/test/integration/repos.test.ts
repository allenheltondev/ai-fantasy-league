import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalTable, type LocalTable } from '../../src/dev/local-table.js';
import { fixturePlayers } from '../../src/players/fixtures.js';
import type { Player } from '../../src/players/model.js';
import { createDynamoRepos } from '../../src/repos/dynamo/index.js';
import { createInMemoryRepos } from '../../src/repos/memory.js';
import type { AuditEntry, IdempotencyBeginInput, Repos } from '../../src/repos/types.js';
import { league } from '../support/harness.js';

let table: LocalTable;
beforeAll(async () => {
  table = await startLocalTable();
});
afterAll(() => table.close());

/** The same behavioral contract, run against both implementations. */
const backends: [string, () => Repos][] = [
  ['in-memory', () => createInMemoryRepos()],
  ['DynamoDB (DynamoDB Local)', () => createDynamoRepos(table)]
];

const T0 = new Date('2026-09-10T12:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;

function begin(overrides: Partial<IdempotencyBeginInput> & { scope: string }): IdempotencyBeginInput {
  return {
    key: 'k-1',
    operation: 'op',
    requestHash: 'h1',
    now: T0,
    lockUntil: plus(60_000),
    expiresAt: plus(86_400_000),
    ...overrides
  };
}

function auditEntry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: unique('audit'),
    at: T0.toISOString(),
    principal: 'user#u',
    principalType: 'user',
    teamId: null,
    operation: 'op',
    leagueId: null,
    idempotencyKey: 'k',
    outcome: 'ok',
    errorCode: null,
    ...overrides
  };
}

describe.each(backends)('%s repositories', (_name, make) => {
  describe('idempotency', () => {
    it('starts, replays, and rejects mismatches', async () => {
      const { idempotency } = make();
      const scope = unique('user#u');
      expect(await idempotency.begin(begin({ scope }))).toEqual({ status: 'started' });
      expect(await idempotency.begin(begin({ scope }))).toEqual({ status: 'in_progress' });
      const response = {
        status: 200,
        body: { data: { nested: [1, null, 'x'] }, league: null, warnings: [] }
      };
      await idempotency.complete(scope, 'k-1', response, plus(86_400_000));
      expect(await idempotency.begin(begin({ scope }))).toEqual({ status: 'replay', response });
      expect(await idempotency.begin(begin({ scope, requestHash: 'h2' }))).toEqual({
        status: 'mismatch',
        operation: 'op'
      });
    });

    it('lets a stale in-progress claim or an expired record be taken over', async () => {
      const { idempotency } = make();
      const scope = unique('user#u');
      await idempotency.begin(begin({ scope }));
      expect(await idempotency.begin(begin({ scope, now: plus(60_000), lockUntil: plus(120_000) }))).toEqual({
        status: 'started'
      });
      await idempotency.complete(scope, 'k-1', { status: 200, body: {} }, plus(100_000));
      expect(await idempotency.begin(begin({ scope, now: plus(99_000) }))).toMatchObject({
        status: 'replay'
      });
      expect(await idempotency.begin(begin({ scope, now: plus(100_000), lockUntil: plus(200_000) }))).toEqual(
        {
          status: 'started'
        }
      );
    });

    it('releases a claim', async () => {
      const { idempotency } = make();
      const scope = unique('user#u');
      await idempotency.begin(begin({ scope }));
      await idempotency.release(scope, 'k-1');
      expect(await idempotency.begin(begin({ scope }))).toEqual({ status: 'started' });
    });

    it('ignores completing an unknown key', async () => {
      const { idempotency } = make();
      await expect(
        idempotency.complete(unique('s'), 'k', { status: 200, body: {} }, T0)
      ).resolves.toBeUndefined();
    });
  });

  describe('audit', () => {
    it('lists by league and by principal, newest first, with a limit', async () => {
      const { audit } = make();
      const leagueId = unique('lg');
      const principal = unique('agent#a');
      const older = auditEntry({ leagueId, principal, at: '2026-09-10T12:00:00.000Z' });
      const newer = auditEntry({
        leagueId,
        principal,
        at: '2026-09-10T12:05:00.000Z',
        outcome: 'error',
        errorCode: 'X'
      });
      const noLeague = auditEntry({ principal, at: '2026-09-10T12:10:00.000Z' });
      for (const entry of [older, newer, noLeague]) await audit.record(entry);
      expect(await audit.listByLeague(leagueId)).toEqual([newer, older]);
      expect(await audit.listByPrincipal(principal)).toEqual([noLeague, newer, older]);
      expect(await audit.listByPrincipal(principal, { limit: 1 })).toEqual([noLeague]);
    });
  });

  describe('players', () => {
    it('writes in batches and reads by id, ids, and position shard', async () => {
      const { players } = make();
      const many: Player[] = Array.from({ length: 60 }, (_, i) => ({
        ...fixturePlayers[0]!,
        id: `bulk-${i}`,
        name: `Bulk Player ${i}`,
        aliases: [],
        position: i % 2 === 0 ? 'WR' : 'TE'
      }));
      await players.putMany([...fixturePlayers, ...many]);
      expect(await players.get('fx-cmc')).toEqual(fixturePlayers[0]);
      expect(await players.get('missing')).toBeNull();
      const ids = ['fx-lamb', 'missing', 'bulk-3', 'fx-lamb'];
      expect((await players.getMany(ids)).map((p) => p.id)).toEqual(['fx-lamb', 'bulk-3', 'fx-lamb']);
      const tes = await players.listIndex('TE');
      expect(tes.every((p) => p.position === 'TE')).toBe(true);
      expect(tes.length).toBe(30 + fixturePlayers.filter((p) => p.position === 'TE').length);
      expect((await players.listIndex()).length).toBe(fixturePlayers.length + 60);
    });
  });

  describe('leagues', () => {
    it('creates once and updates with optimistic concurrency', async () => {
      const { leagues } = make();
      const id = unique('lg');
      await leagues.create(league({ id }));
      await expect(leagues.create(league({ id }))).rejects.toMatchObject({ code: 'CONFLICT' });
      const stored = await leagues.get(id);
      expect(stored).toEqual(league({ id }));
      const updated = await leagues.update({ ...stored!, phase: 'drafting' });
      expect(updated.version).toBe(2);
      await expect(leagues.update({ ...stored!, phase: 'playoffs' })).rejects.toMatchObject({
        code: 'CONFLICT'
      });
      await expect(leagues.update(league({ id: unique('missing') }))).rejects.toMatchObject({
        code: 'CONFLICT'
      });
      expect((await leagues.get(id))?.phase).toBe('drafting');
      expect(await leagues.get(unique('nope'))).toBeNull();
    });
  });
});
