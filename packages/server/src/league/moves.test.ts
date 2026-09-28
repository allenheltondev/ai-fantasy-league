import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TransactionRecord } from '../repos/waivers.js';
import { groupMoves, latestMoves, moveSides, type TransactionPager } from './moves.js';

const txn = (overrides: Partial<TransactionRecord> & Pick<TransactionRecord, 'id'>): TransactionRecord => ({
  leagueId: 'lg',
  at: '2026-09-10T12:00:00.000Z',
  week: 2,
  type: 'add',
  teamId: 'team-1',
  addPlayerId: null,
  dropPlayerId: null,
  cost: null,
  claimId: null,
  ...overrides
});

/** A trade: each side receives the other's players; team-2 releases one to make room. */
const trade = (id: string, at: string): TransactionRecord[] => [
  txn({ id: `${id}.p1`, at, type: 'trade', teamId: 'team-1', addPlayerId: 'p1', tradeId: id }),
  txn({ id: `${id}.p2`, at, type: 'trade', teamId: 'team-2', addPlayerId: 'p2', tradeId: id }),
  txn({ id: `${id}.p3`, at, type: 'trade', teamId: 'team-2', addPlayerId: 'p3', tradeId: id }),
  txn({ id: `${id}.drop.p4`, at, type: 'drop', teamId: 'team-2', dropPlayerId: 'p4', tradeId: id })
];

/** Serves `records` newest first in pages of `size`, like the repository. */
function pager(records: readonly TransactionRecord[], size: number): TransactionPager {
  return async (cursor) => {
    const start = cursor === null ? 0 : Number(cursor);
    const end = start + size;
    return { items: records.slice(start, end), nextCursor: end < records.length ? String(end) : null };
  };
}

describe('groupMoves', () => {
  it('folds a trade into one move and keeps adds, drops, and waiver awards as their own', () => {
    const log = [
      ...trade('tr-1', '2026-09-10T12:00:03.000Z'),
      txn({
        id: 'w-1',
        type: 'waiver_claim',
        teamId: 'team-3',
        addPlayerId: 'p5',
        dropPlayerId: 'p6',
        cost: 7
      }),
      txn({ id: 'a-1', type: 'add', teamId: 'team-1', addPlayerId: 'p7', dropPlayerId: 'p8' }),
      txn({ id: 'd-1', type: 'drop', teamId: 'team-4', dropPlayerId: 'p9' })
    ];
    const moves = groupMoves(log);
    expect(moves.map((m) => [m.id, m.type, m.records.length])).toEqual([
      ['tr-1', 'trade', 4],
      ['w-1', 'waiver', 1],
      ['a-1', 'add', 1],
      ['d-1', 'drop', 1]
    ]);
    expect(moveSides(moves[0]!)).toEqual([
      { teamId: 'team-1', added: ['p1'], dropped: [], cost: null },
      { teamId: 'team-2', added: ['p2', 'p3'], dropped: ['p4'], cost: null }
    ]);
    expect(moveSides(moves[1]!)).toEqual([{ teamId: 'team-3', added: ['p5'], dropped: ['p6'], cost: 7 }]);
  });

  it('treats a trade record without its trade id as a trade on its own', () => {
    const [move] = groupMoves([txn({ id: 'x', type: 'trade', addPlayerId: 'p1' })]);
    expect(move).toMatchObject({ id: 'x', type: 'trade' });
  });

  it('keeps every record exactly once, one move per trade', () => {
    const record = fc.record({
      id: fc.uuid(),
      teamId: fc.constantFrom('team-1', 'team-2', 'team-3'),
      type: fc.constantFrom('add', 'drop', 'waiver_claim', 'trade' as const),
      tradeId: fc.option(fc.constantFrom('tr-a', 'tr-b', 'tr-c'), { nil: null })
    });
    fc.assert(
      fc.property(fc.uniqueArray(record, { selector: (r) => r.id, maxLength: 30 }), (rows) => {
        const records = rows.map((r) => txn(r));
        const moves = groupMoves(records);
        expect(moves.flatMap((m) => m.records.map((r) => r.id)).sort()).toEqual(
          records.map((r) => r.id).sort()
        );
        const tradeIds = records.flatMap((r) => (r.tradeId == null ? [] : [r.tradeId]));
        expect(moves.filter((m) => m.records[0]?.tradeId != null).length).toBe(new Set(tradeIds).size);
      })
    );
  });
});

describe('latestMoves', () => {
  const log = [
    txn({ id: 'a-1', at: '2026-09-10T12:00:05.000Z' }),
    ...trade('tr-1', '2026-09-10T12:00:04.000Z'),
    txn({ id: 'd-1', type: 'drop', at: '2026-09-10T12:00:03.000Z', dropPlayerId: 'p9' }),
    ...trade('tr-2', '2026-09-10T12:00:02.000Z')
  ];

  it('reads on until the last move it returns is whole', async () => {
    const { moves, hasMore } = await latestMoves(pager(log, 2), 2);
    expect(moves.map((m) => [m.id, m.records.length])).toEqual([
      ['a-1', 1],
      ['tr-1', 4]
    ]);
    expect(hasMore).toBe(true);
  });

  it('says when there are no older moves', async () => {
    const { moves, hasMore } = await latestMoves(pager(log, 100), 4);
    expect(moves.map((m) => m.id)).toEqual(['a-1', 'tr-1', 'd-1', 'tr-2']);
    expect(hasMore).toBe(false);
    expect((await latestMoves(pager([], 10), 5)).moves).toEqual([]);
  });

  it('stops after its page budget and reports more', async () => {
    const { moves, hasMore } = await latestMoves(pager(log, 1), 10, 2);
    expect(moves.map((m) => m.id)).toEqual(['a-1', 'tr-1']);
    expect(hasMore).toBe(true);
  });

  it('matches grouping the whole log, whatever the page size', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 5 }),
        async (size, limit) => {
          const { moves } = await latestMoves(pager(log, size), limit, 100);
          expect(moves).toEqual(groupMoves(log).slice(0, limit));
        }
      )
    );
  });
});
