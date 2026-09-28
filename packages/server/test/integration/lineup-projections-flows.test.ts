import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/operations/index.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, type Caller } from '../support/league-client.js';
import { ALICE } from '../support/leagues.js';
import { SEASON, seedNflSchedule, seedSeasonLeague } from '../support/season.js';

/**
 * The lineup editor's numbers (#176) over HTTP: get_roster's per-player opponent and recent
 * average, the lineup's projected total, and the optimal lineup as set_lineup moves, with locks
 * and injuries respected. The league is in week 2; team-1 is Alice's, with the demo lineup saved.
 */

const L = '/leagues/lg-lineup-ux';
const THURSDAY_WEEK2 = '2026-09-18T00:20:00.000Z';
let h: Harness;
let alice: Caller;

interface Row {
  player: { id: string };
  slot: string;
  locked: boolean;
  opponent: { team: string; home: boolean } | null;
  projectedPoints: number | null;
  recentPoints: { average: number; games: number } | null;
}
interface RosterData {
  players: Row[];
  projectedPoints: number;
  optimal: { projectedPoints: number; moves: { playerId: string; slot: string }[] } | null;
}

const row = (roster: RosterData, id: string) => roster.players.find((p) => p.player.id === id);

beforeAll(async () => {
  h = await createHarness({ registry });
  alice = as(h, ALICE);
  const reference = h.services.data.reference;
  await seedNflSchedule(reference);
  await seedSeasonLeague({ repos: h.repos, reference }, { id: 'lg-lineup-ux', owners: [ALICE], overrides: { week: 2 } });
  const [bijan] = await h.repos.players.getMany(['fx-bijan']);
  await h.repos.players.putMany([{ ...bijan!, injuryStatus: 'Out' }]);
  const line = (playerId: string, stats: Record<string, number>) => ({ playerId, season: SEASON, week: 2, stats });
  await reference.projections.putSnapshot(
    { season: SEASON, week: 2, capturedAt: '2026-09-09T12:00:00.000Z', hash: 'ux', count: 6 },
    [
      line('fx-jallen', { pass_yd: 500 }),
      line('fx-mahomes', { pass_yd: 625 }),
      line('fx-cmc', { rush_yd: 100 }),
      line('fx-bijan', { rush_yd: 180 }),
      line('fx-bhall', { rush_yd: 150 }),
      line('fx-kwalker', { rush_yd: 200 })
    ]
  );
  await reference.stats.putLines([
    { playerId: 'fx-cmc', season: SEASON, week: 1, stats: { rush_yd: 100 }, updatedAt: '2026-09-16T00:00:00Z' },
    { playerId: 'fx-chase', season: SEASON, week: 1, stats: { gp: 0 }, updatedAt: '2026-09-16T00:00:00Z' }
  ]);
});
afterAll(() => h.close());

describe('get_roster for the lineup editor', () => {
  it('shows each player’s opponent, projection, and recent average, and the lineup’s total', async () => {
    const res = await alice.get(`${L}/teams/team-1/roster`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const roster = data<RosterData>(res);
    expect(row(roster, 'fx-jallen')).toMatchObject({
      opponent: { team: 'MIA', home: true },
      projectedPoints: 20,
      recentPoints: null
    });
    expect(row(roster, 'fx-cmc')).toMatchObject({
      opponent: { team: 'ARI', home: true },
      recentPoints: { average: 10, games: 1 }
    });
    // A week without a game played does not count.
    expect(row(roster, 'fx-chase')?.recentPoints).toBeNull();
    expect(row(roster, 'fx-kwalker')?.opponent).toBeNull();
    // Allen 20 + McCaffrey 10; Bijan (Out) counts 0.
    expect(roster.projectedPoints).toBe(30);
  });

  it('offers the optimal lineup as set_lineup moves: nobody Out or on bye starts', async () => {
    const roster = data<RosterData>(await alice.get(`${L}/teams/team-1/roster`));
    expect(roster.optimal?.projectedPoints).toBe(50);
    // The saved lineup leaves TE empty, so Kelce moves there from the flex and Lamb fills it.
    expect(roster.optimal?.moves).toHaveLength(6);
    expect(roster.optimal?.moves).toEqual(
      expect.arrayContaining([
        { playerId: 'fx-mahomes', slot: 'QB' },
        { playerId: 'fx-jallen', slot: 'BN' },
        { playerId: 'fx-bhall', slot: 'RB' },
        { playerId: 'fx-bijan', slot: 'BN' },
        { playerId: 'fx-kelce', slot: 'TE' },
        { playerId: 'fx-lamb', slot: 'W/R/T' }
      ])
    );
  });

  it('keeps locked players where they are', async () => {
    h.clock.set(new Date(Date.parse(THURSDAY_WEEK2) + 60_000));
    try {
      const roster = data<RosterData>(await alice.get(`${L}/teams/team-1/roster`));
      expect(row(roster, 'fx-mahomes')).toMatchObject({ slot: 'BN', locked: true });
      expect(roster.optimal).toEqual({
        projectedPoints: 45,
        moves: expect.arrayContaining([
          { playerId: 'fx-bhall', slot: 'RB' },
          { playerId: 'fx-bijan', slot: 'BN' }
        ])
      });
      expect(roster.optimal?.moves).toHaveLength(2);
    } finally {
      h.clock.set('2026-09-10T12:00:00.000Z');
    }
  });

  it('applies the optimal moves through set_lineup, after which there is nothing left to gain', async () => {
    const before = data<RosterData>(await alice.get(`${L}/teams/team-1/roster`));
    const put = await alice.put(`${L}/teams/team-1/lineup`, { moves: before.optimal?.moves });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = data<RosterData>(await alice.get(`${L}/teams/team-1/roster`));
    expect(after.projectedPoints).toBe(50);
    expect(after.optimal).toEqual({ projectedPoints: 50, moves: [] });
  });

  it('has no optimal lineup without projections', async () => {
    const roster = data<RosterData>(await alice.get(`${L}/teams/team-1/roster?week=3`));
    expect(roster.optimal).toBeNull();
    expect(roster.projectedPoints).toBe(0);
  });
});
