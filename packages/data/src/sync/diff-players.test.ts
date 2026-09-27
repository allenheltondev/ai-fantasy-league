import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makePlayer } from '../../test/helpers.js';
import type { InjuryStatus, Player } from '../types.js';
import { TRACKED_FIELDS, deepEqual, diffPlayers } from './diff-players.js';

describe('diffPlayers', () => {
  it('reports new players as upserts without change events', () => {
    const d = diffPlayers([], [makePlayer({ id: '1' })]);
    expect(d.upserts.map((p) => p.id)).toEqual(['1']);
    expect(d.changes).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('emits one change per tracked field', () => {
    const before = makePlayer({
      id: '1',
      status: 'Active',
      injuryStatus: null,
      team: 'KC',
      depthChartOrder: 1
    });
    const after = {
      ...before,
      status: 'Injured Reserve',
      injuryStatus: 'IR' as const,
      team: 'LV',
      depthChartOrder: 2
    };
    const d = diffPlayers([before], [after]);
    expect(d.upserts).toEqual([after]);
    expect(d.changes).toEqual([
      { playerId: '1', field: 'status', from: 'Active', to: 'Injured Reserve' },
      { playerId: '1', field: 'injuryStatus', from: null, to: 'IR' },
      { playerId: '1', field: 'team', from: 'KC', to: 'LV' },
      { playerId: '1', field: 'depthChartOrder', from: 1, to: 2 }
    ]);
  });

  it('upserts untracked changes silently', () => {
    const before = makePlayer({ id: '1', age: 25 });
    const d = diffPlayers([before], [{ ...before, age: 26 }]);
    expect(d.upserts).toHaveLength(1);
    expect(d.changes).toEqual([]);
  });

  it('ignores key order and undefined-valued keys', () => {
    const a = makePlayer({ id: '1' });
    const b: Player = { ...a, byeWeek: undefined };
    expect(diffPlayers([a], [b]).upserts).toEqual([]);
  });

  it('lists removed ids and accepts maps', () => {
    const a = makePlayer({ id: '1' });
    const b = makePlayer({ id: '2' });
    const d = diffPlayers(
      new Map([
        ['1', a],
        ['2', b]
      ]),
      new Map([['2', b]])
    );
    expect(d.removed).toEqual(['1']);
    expect(d.upserts).toEqual([]);
  });

  it('deepEqual compares arrays and nested values', () => {
    expect(deepEqual([1, [2]], [1, [2]])).toBe(true);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

const injuries: (InjuryStatus | null)[] = [null, 'Questionable', 'Doubtful', 'Out', 'IR'];
const arbPlayer = (id: string): fc.Arbitrary<Player> =>
  fc
    .record({
      status: fc.constantFrom('Active', 'Inactive', 'Injured Reserve', null),
      injuryStatus: fc.constantFrom(...injuries),
      team: fc.constantFrom('KC', 'BUF', 'LAR', null),
      depthChartOrder: fc.constantFrom(1, 2, 3, null),
      age: fc.integer({ min: 21, max: 40 }),
      searchNames: fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 2 })
    })
    .map((fields) => makePlayer({ id, ...fields }));

const arbUniverse: fc.Arbitrary<Player[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 25 })
  .chain((ids) => fc.tuple(...ids.map((i) => arbPlayer(String(i)))));

describe('diffPlayers properties', () => {
  it('a snapshot diffed against itself is empty', () => {
    fc.assert(
      fc.property(arbUniverse, (players) => {
        const d = diffPlayers(
          players,
          players.map((p) => ({ ...p }))
        );
        expect(d).toEqual({ upserts: [], removed: [], changes: [] });
      })
    );
  });

  it('applying upserts and removals to the previous snapshot reproduces the next one', () => {
    fc.assert(
      fc.property(arbUniverse, arbUniverse, (prev, next) => {
        const d = diffPlayers(prev, next);
        const state = new Map(prev.map((p) => [p.id, p]));
        for (const id of d.removed) state.delete(id);
        for (const p of d.upserts) state.set(p.id, p);
        expect(new Map([...state].sort())).toEqual(new Map(next.map((p) => [p.id, p] as const).sort()));
      })
    );
  });

  it('change events are exactly the tracked-field differences of players in both snapshots', () => {
    fc.assert(
      fc.property(arbUniverse, arbUniverse, (prev, next) => {
        const d = diffPlayers(prev, next);
        const before = new Map(prev.map((p) => [p.id, p]));
        const expected = next.flatMap((p) => {
          const b = before.get(p.id);
          if (!b) return [];
          return TRACKED_FIELDS.filter((f) => b[f] !== p[f]).map((f) => `${p.id}:${f}:${b[f]}->${p[f]}`);
        });
        expect(d.changes.map((c) => `${c.playerId}:${c.field}:${c.from}->${c.to}`).sort()).toEqual(
          expected.sort()
        );
        // every changed player is upserted
        const upserted = new Set(d.upserts.map((p) => p.id));
        for (const c of d.changes) expect(upserted.has(c.playerId)).toBe(true);
      })
    );
  });

  it('is deterministic regardless of input order', () => {
    fc.assert(
      fc.property(arbUniverse, arbUniverse, (prev, next) => {
        expect(diffPlayers([...prev].reverse(), [...next].reverse())).toEqual(diffPlayers(prev, next));
      })
    );
  });
});
