import type { ProjectionLine } from '@fantasy/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixturePlayers } from '../../src/players/fixtures.js';
import { registry } from '../../src/operations/index.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL } from '../support/leagues.js';
import { seedNflSchedule } from '../support/season.js';
import { seedSeasonLeague } from '../support/waivers.js';

/**
 * The roster workspace's server side (#205) over the REST adapter and DynamoDB Local: the player
 * market (list_league_players: filters, sorts, stable paging, and its decision data) and editing a
 * pending waiver claim (update_waiver_claim).
 */

const L = '/leagues/lg-m';
let h: Harness;
let alice: Caller;
let bob: Caller;

interface Row {
  player: { id: string; position: string };
  availability: { status: string; teamId?: string; clearsAt?: string };
  status: string;
  byeWeek: number | null;
  game: { state: string; opponent: string | null; home: boolean | null };
  projectedPoints: number | null;
  projectedRos: number | null;
  seasonPoints: number | null;
  average: number | null;
  games: number;
  trend: { adds: number; drops: number } | null;
}
interface Page {
  week: number;
  total: number;
  nextOffset: number | null;
  trendHours: number | null;
  waiverType: string;
  faabRemaining: number | null;
  dropClearsAt: string | null;
  players: Row[];
}

const market = async (query = '', who: Caller = alice) => {
  const res = await who.get(`${L}/players${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return data<Page>(res);
};
const ids = (page: Page) => page.players.map((r) => r.player.id);
const proj = (playerId: string, stats: Record<string, number>, week = 2): ProjectionLine => ({
  playerId,
  season: 2026,
  week,
  stats
});

beforeAll(async () => {
  // Swift is questionable: "healthy only" leaves him out.
  h = await createHarness({
    backend: 'dynamo',
    registry,
    players: fixturePlayers.map((p) => (p.id === 'fx-swift' ? { ...p, injuryStatus: 'Questionable' } : p))
  });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  await seedSeasonLeague(h.repos, {
    id: 'lg-m',
    owners: [ALICE, BOB, null, null],
    rosters: { 'team-1': ['fx-jallen', 'fx-kelce'], 'team-2': ['fx-mahomes', 'fx-cmc', 'fx-hurts'] }
  });
  // Lamb is on waivers until Saturday of week 2, so a claim runs Sunday morning, after the Thursday game.
  await h.repos.waivers.putWireEntry({
    leagueId: 'lg-m',
    playerId: 'fx-lamb',
    droppedByTeamId: 'team-2',
    droppedAt: '2026-09-10T00:00:00.000Z',
    clearsAt: '2026-09-19T12:00:00.000Z'
  });
  const ref = h.services.data.reference;
  await seedNflSchedule(ref);
  await ref.projections.putSnapshot(
    { season: 2026, week: 2, capturedAt: '2026-09-09T12:00:00.000Z', hash: 'm', count: 5 },
    [
      proj('fx-chase', { rec: 7, rec_yd: 100, rec_td: 1 }),
      proj('fx-bijan', { rush_yd: 80, rush_td: 0.5 }),
      proj('fx-lamb', { rec: 5, rec_yd: 60 }),
      proj('fx-swift', { rush_yd: 50 }),
      proj('fx-jallen', { pass_yd: 300, pass_td: 3 })
    ]
  );
  await ref.stats.putLines([
    {
      playerId: 'fx-swift',
      season: 2026,
      week: 1,
      stats: { gp: 1, rush_yd: 150, rush_td: 2 },
      updatedAt: 'x'
    },
    { playerId: 'fx-bijan', season: 2026, week: 1, stats: { gp: 1, rush_yd: 40 }, updatedAt: 'x' },
    { playerId: 'fx-bijan', season: 2026, week: 2, stats: { gp: 1, rush_yd: 20 }, updatedAt: 'x' }
  ]);
  await ref.seasons.put(
    { kind: 'projections', season: 2026, updatedAt: 'x', players: 1, weeks: [1, 2, 3], hash: 'm' },
    [
      {
        playerId: 'fx-bijan',
        season: 2026,
        weeks: [
          { week: 1, stats: { rush_yd: 1000 } },
          { week: 2, stats: { rush_yd: 100 } },
          { week: 3, stats: { rush_yd: 100 } }
        ]
      }
    ]
  );
  await ref.trending.put({
    type: 'add',
    capturedAt: '2026-09-10T11:00:00.000Z',
    lookbacks: {
      '24': [
        { playerId: 'fx-swift', count: 4200 },
        { playerId: 'fx-jamesonw', count: 3100 }
      ]
    }
  });
  await ref.trending.put({
    type: 'drop',
    capturedAt: '2026-09-10T11:00:00.000Z',
    lookbacks: { '24': [{ playerId: 'fx-bijan', count: 500.4 }] }
  });
});
afterAll(() => h.close());

describe('list_league_players', () => {
  it('lists available players by projection this week, with the decision data', async () => {
    const page = await market();
    expect(page).toMatchObject({
      week: 2,
      trendHours: 24,
      waiverType: 'faab',
      faabRemaining: 100,
      dropClearsAt: expect.any(String)
    });
    // Projected first, best first; the rest by consensus rank. Nobody on a roster.
    expect(ids(page).slice(0, 4)).toEqual(['fx-chase', 'fx-bijan', 'fx-lamb', 'fx-swift']);
    expect(ids(page)).not.toContain('fx-jallen');
    expect(ids(page)).not.toContain('fx-cmc');
    const lamb = page.players.find((r) => r.player.id === 'fx-lamb') as Row;
    expect(lamb.availability).toEqual({ status: 'waivers', clearsAt: '2026-09-20T08:00:00.000Z' });
    const chase = page.players[0] as Row;
    expect(chase).toMatchObject({
      availability: { status: 'free_agent' },
      game: { state: 'upcoming', opponent: 'DET', home: true },
      trend: { adds: 0, drops: 0 }
    });
    const bijan = page.players[1] as Row;
    expect(bijan).toMatchObject({ games: 2, trend: { adds: 0, drops: 500 } });
    expect(bijan.average).toBeCloseTo((bijan.seasonPoints as number) / 2, 1);
    // Rest of season counts week 2 on, not week 1.
    expect(bijan.projectedRos).toBe(20);
    const walker = page.players.find((r) => r.player.id === 'fx-kwalker') as Row;
    expect(walker).toMatchObject({
      byeWeek: 1,
      game: { state: 'bye', opponent: null },
      projectedPoints: null
    });
  });

  it('pages in a stable order without repeating anyone', async () => {
    const all = await market('?limit=50');
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Page = await market(`?limit=3&offset=${offset}`);
      expect(page.total).toBe(all.total);
      seen.push(...ids(page));
      offset = page.nextOffset;
    }
    expect(seen).toEqual(ids(all));
    expect(new Set(seen).size).toBe(seen.length);
    expect(all.nextOffset).toBeNull();
  });

  it('sorts by trend, season points, average, rest of season, and rank', async () => {
    expect(ids(await market('?sort=trending')).slice(0, 2)).toEqual(['fx-swift', 'fx-jamesonw']);
    expect(ids(await market('?sort=trending')).at(-1)).toBe('fx-bijan');
    expect(ids(await market('?sort=season_points')).slice(0, 2)).toEqual(['fx-swift', 'fx-bijan']);
    expect(ids(await market('?sort=average')).slice(0, 2)).toEqual(['fx-swift', 'fx-bijan']);
    expect(ids(await market('?sort=projected_ros'))[0]).toBe('fx-bijan');
    const byRank = await market('?sort=rank');
    const ranks = byRank.players.map((r) => fixturePlayers.find((p) => p.id === r.player.id)?.rank ?? 1e9);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('filters by position, FLEX, team, name, health, and availability', async () => {
    const flex = await market('?position=FLEX&limit=50');
    expect(new Set(flex.players.map((r) => r.player.position))).toEqual(new Set(['RB', 'WR', 'TE']));
    expect(ids(await market('?position=QB'))).toEqual(['fx-lamar']);
    expect(ids(await market('?team=DET&limit=50')).sort()).toEqual(['fx-arsb', 'fx-jamesonw', 'fx-laporta']);
    expect(ids(await market('?q=williams&limit=50')).sort()).toEqual([
      'fx-jamesonw',
      'fx-javontew',
      'fx-kyrenw',
      'fx-mikew'
    ]);
    const healthy = await market('?healthy=true&limit=50');
    expect(ids(healthy)).not.toContain('fx-swift');
    expect(healthy.players.every((r) => r.status === 'active')).toBe(true);
    const rostered = await market('?availability=rostered&limit=50');
    expect(rostered.players.find((r) => r.player.id === 'fx-cmc')?.availability).toEqual({
      status: 'rostered',
      teamId: 'team-2'
    });
    expect(ids(await market('?availability=all&limit=50'))).toEqual(
      expect.arrayContaining(['fx-jallen', 'fx-chase', 'fx-lamb'])
    );
    expect(ids(await market('?availability=waivers'))).toEqual(['fx-lamb']);
  });

  it('is for league members only, and refuses bad input', async () => {
    const outsider = await as(h, CAROL).get(`${L}/players`);
    expect(outsider.status).toBe(403);
    expect(errorCode(await alice.get(`${L}/players?limit=51`))).toBe('INVALID_INPUT');
    expect(errorCode(await alice.get(`${L}/players?sort=vibes`))).toBe('INVALID_INPUT');
  });
});

describe('update_waiver_claim', () => {
  let claimId = '';

  it('changes the bid of a pending claim, keeping its place', async () => {
    const res = await alice.post(`${L}/waivers/claims`, { playerId: 'fx-lamb', bid: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    claimId = (data(res).claim as { id: string }).id;
    const edited = await alice.patch(`${L}/waivers/claims/${claimId}`, { bid: 9 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(data(edited).claim).toMatchObject({
      id: claimId,
      bid: 9,
      priority: 1,
      drop: null,
      status: 'pending'
    });
  });

  it('checks the edit like a new claim', async () => {
    expect(errorCode(await alice.patch(`${L}/waivers/claims/${claimId}`, { bid: 500 }))).toBe(
      'INSUFFICIENT_FAAB'
    );
    expect(errorCode(await alice.patch(`${L}/waivers/claims/${claimId}`, { dropPlayerId: 'fx-cmc' }))).toBe(
      'DROP_PLAYER_NOT_ON_ROSTER'
    );
    // Kelce's Thursday game kicks off before the Sunday-morning run: he would be locked.
    const locked = await alice.patch(`${L}/waivers/claims/${claimId}`, { dropPlayerId: 'fx-kelce' });
    expect(errorCode(locked)).toBe('PLAYER_LOCKED');
    expect(errorCode(await bob.patch(`${L}/waivers/claims/${claimId}`, { bid: 1 }))).toBe(
      'WAIVER_CLAIM_NOT_FOUND'
    );
  });

  it('sets and clears the drop player as the roster fills and empties', async () => {
    // A free agent fills the last spot: the claim now needs a drop.
    expect((await alice.post(`${L}/waivers/claims`, { playerId: 'fx-bijan' })).status).toBe(200);
    expect(errorCode(await alice.patch(`${L}/waivers/claims/${claimId}`, { bid: 3 }))).toBe('ROSTER_FULL');
    const withDrop = await alice.patch(`${L}/waivers/claims/${claimId}`, { dropPlayerId: 'fx-jallen' });
    expect(withDrop.status, JSON.stringify(withDrop.body)).toBe(200);
    expect(data(withDrop).claim).toMatchObject({ bid: 9, drop: { id: 'fx-jallen' } });
    // Keeps the drop when only the bid changes.
    expect(data(await alice.patch(`${L}/waivers/claims/${claimId}`, { bid: 4 })).claim).toMatchObject({
      bid: 4,
      drop: { id: 'fx-jallen' }
    });
    expect(errorCode(await alice.patch(`${L}/waivers/claims/${claimId}`, { clearDrop: true }))).toBe(
      'ROSTER_FULL'
    );
    expect((await alice.post(`${L}/drops`, { playerId: 'fx-bijan' })).status).toBe(200);
    expect(
      data(await alice.patch(`${L}/waivers/claims/${claimId}`, { clearDrop: true })).claim
    ).toMatchObject({
      drop: null
    });
  });

  it('refuses a claim that is no longer pending', async () => {
    expect((await alice.del(`${L}/waivers/claims/${claimId}`)).status).toBe(200);
    expect(errorCode(await alice.patch(`${L}/waivers/claims/${claimId}`, { bid: 2 }))).toBe(
      'WAIVER_CLAIM_NOT_PENDING'
    );
  });
});
