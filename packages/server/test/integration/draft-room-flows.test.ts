import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/operations/index.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, type Caller } from '../support/league-client.js';
import { ALICE, BOB, seedLeague } from '../support/leagues.js';

/**
 * The draft room's decision aids (#170) over HTTP (DynamoDB Local): your roster laid out by slot,
 * who will likely be gone before your next pick, and how deep each position still runs.
 */

const L = 'lg-draft-room';
let h: Harness;
let alice: Caller;
let bob: Caller;

interface Ref {
  id: string;
  name: string;
  position: string;
}

interface Board {
  onTheClock: { teamId: string } | null;
  yourNextPick: { picksAway: number } | null;
  bestAvailable: { player: Ref }[];
  yourRoster: { starters: { slot: string; player: Ref | null }[]; bench: Ref[]; benchSize: number } | null;
  likelyGone: Ref[];
  scarcity: { position: string; left: number; likelyGone: number }[];
}

const board = async (caller: Caller) => data<Board>(await caller.get(`/leagues/${L}/draft?limit=10`));

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry, players: fixtureDraftPool });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  await seedLeague(h.repos, { id: L, owners: [ALICE, BOB], teamCount: 4 });
  const started = await alice.post(`/leagues/${L}/draft/start`, {
    order: ['team-1', 'team-2', 'team-3', 'team-4']
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
});
afterAll(() => h.close());

describe('draft room aids', () => {
  it('lays out every starting seat empty before your first pick, with your bench spots', async () => {
    const b = await board(alice);
    expect(b.yourRoster?.starters.map((s) => s.slot)).toEqual([
      'QB',
      'WR',
      'WR',
      'WR',
      'RB',
      'RB',
      'TE',
      'W/R/T',
      'K',
      'DEF'
    ]);
    expect(b.yourRoster?.starters.every((s) => s.player === null)).toBe(true);
    expect(b.yourRoster?.bench).toEqual([]);
    expect(b.yourRoster?.benchSize).toBe(6);
  });

  it('names who will likely be gone before your next pick, on the clock or waiting', async () => {
    // Alice picks 1st and 8th in a 4-team snake: six picks in between.
    const mine = await board(alice);
    expect(mine.onTheClock?.teamId).toBe('team-1');
    expect(mine.likelyGone).toHaveLength(6);
    expect(new Set(mine.likelyGone.map((p) => p.id)).size).toBe(6);
    // Bob picks 2nd: only Alice's pick comes first, and she likely takes the top player.
    const his = await board(bob);
    expect(his.yourNextPick?.picksAway).toBe(1);
    expect(his.likelyGone.map((p) => p.id)).toEqual([his.bestAvailable[0]?.player.id]);
  });

  it('counts each position among the top 100 available, and how many go before your pick', async () => {
    const b = await board(bob);
    expect(b.scarcity.map((s) => s.position)).toEqual(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
    expect(b.scarcity.reduce((sum, s) => sum + s.left, 0)).toBeLessThanOrEqual(100);
    expect(b.scarcity.reduce((sum, s) => sum + s.likelyGone, 0)).toBe(1);
    for (const s of b.scarcity) expect(s.likelyGone).toBeLessThanOrEqual(s.left);
  });

  it('fills your seats as you draft', async () => {
    const res = await alice.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-chase' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = await board(alice);
    const filled = b.yourRoster?.starters.filter((s) => s.player !== null);
    expect(filled).toEqual([{ slot: 'WR', player: expect.objectContaining({ id: 'fx-chase' }) }]);
    expect(b.likelyGone.some((p) => p.id === 'fx-chase')).toBe(false);
  });

  it("never reads another team's private queue into your estimate (#151)", async () => {
    // Bob is on the clock and next to pick; his queue's top player is deep in the pool.
    const before = await board(alice);
    const deep = data<Board>(await bob.get(`/leagues/${L}/draft?limit=100`)).bestAvailable.at(-1)?.player.id;
    expect(deep).toBeDefined();
    expect(before.likelyGone.some((p) => p.id === deep)).toBe(false);
    const queued = await bob.put(`/leagues/${L}/draft/queue`, { playerIds: [deep] });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect((await board(alice)).likelyGone).toEqual(before.likelyGone);
  });
});
