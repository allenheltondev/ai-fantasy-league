import { buildBracket, seedPlayoffs, yahooDefaultSettings } from '@fantasy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/operations/index.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { recordStandings } from '../../src/season/scoring.js';
import { createHarness, START, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../support/leagues.js';
import { liveGame, seedNflSchedule, seedSeasonLeague } from '../support/season.js';
import { seedSeasonLeague as seedWaiverLeague } from '../support/waivers.js';

/**
 * The league dashboard (#166) over HTTP (dynalite): one read with this week's matchups, the
 * standings, and the move board (trades, adds, drops, and waiver awards grouped into moves), plus
 * the draft before the season and the champion after it.
 */

interface Ref {
  teamId: string;
  teamName: string;
  ownerName: string | null;
  manager: { name: string } | null;
}
interface Dashboard {
  phase: string;
  week: number | null;
  yourTeamId: string | null;
  draft: {
    status: string;
    scheduledAt: string | null;
    seatsFilled: number;
    seats: number;
    picksMade: number;
    totalPicks: number | null;
    onTheClock: (Ref & { overall: number }) | null;
    yourPickIn: number | null;
  } | null;
  matchups: {
    id: string;
    status: string;
    live: boolean;
    home: Ref & { score: number | null; record: string | null };
    away: Ref;
  }[];
  standings: { throughWeek: number | null; rows: (Ref & { rank: number; record: string })[] };
  moves: {
    id: string;
    type: string;
    teams: (Ref & { added: { id: string }[]; dropped: { id: string }[]; cost: number | null })[];
  }[];
  hasMoreMoves: boolean;
  champion: Ref | null;
}

let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;
const dashboard = async (c: Caller, leagueId: string, query = '') => {
  const res = await c.get(`/leagues/${leagueId}/dashboard${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return data<Dashboard>(res);
};

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry, players: fixtureDraftPool });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
});
afterAll(() => h.close());

describe('before the season', () => {
  it('shows the draft time and the seats still open, with no matchups or standings', async () => {
    const settings = yahooDefaultSettings(4);
    settings.draft.scheduledAt = '2026-09-12T00:00:00.000Z';
    await seedLeague(h.repos, {
      id: 'lg-ds',
      owners: [ALICE, BOB, null, null],
      teamCount: 4,
      overrides: { settings }
    });
    const open = await h.repos.teams.get('lg-ds', 'team-4');
    await h.repos.teams.update({ ...open!, seatType: 'human' });

    const board = await dashboard(alice, 'lg-ds');
    expect(board).toMatchObject({
      phase: 'setup',
      week: null,
      yourTeamId: 'team-1',
      draft: {
        status: 'not_started',
        scheduledAt: '2026-09-12T00:00:00.000Z',
        seatsFilled: 3,
        seats: 4,
        picksMade: 0,
        totalPicks: null,
        onTheClock: null,
        yourPickIn: null
      },
      matchups: [],
      standings: { throughWeek: null, rows: [] },
      moves: [],
      hasMoreMoves: false,
      champion: null
    });
  });

  it('shows who is on the clock during the draft and how long until your pick', async () => {
    await seedLeague(h.repos, { id: 'lg-dd', owners: [ALICE, BOB, null, null], teamCount: 4 });
    const start = await alice.post('/leagues/lg-dd/draft/start', {
      order: ['team-2', 'team-3', 'team-1', 'team-4']
    });
    expect(start.status, JSON.stringify(start.body)).toBe(200);

    const board = await dashboard(alice, 'lg-dd');
    expect(board.phase).toBe('drafting');
    expect(board.draft).toMatchObject({
      status: 'in_progress',
      scheduledAt: null,
      seatsFilled: 4,
      picksMade: 0,
      onTheClock: { teamId: 'team-2', ownerName: 'Bob', manager: null, overall: 1, round: 1 },
      yourPickIn: 2
    });
    expect(board.draft?.totalPicks).toBeGreaterThan(4);
    expect((await dashboard(bob, 'lg-dd')).draft?.yourPickIn).toBe(0);
    expect(board.matchups).toEqual([]);
  });
});

describe('in season', () => {
  beforeAll(async () => {
    await seedNflSchedule(h.services.data.reference);
    await seedSeasonLeague(
      { repos: h.repos, reference: h.services.data.reference },
      { id: 'lg-dm', owners: [ALICE, null, BOB, null] }
    );
  });

  it("lists this week's matchups with scores, managers, and records, and the standings", async () => {
    const week = await h.repos.schedule.listMatchups('lg-dm', 1);
    await h.repos.schedule.putMatchups(
      week.map((m, i) => ({ ...m, homeScore: 50 + i, awayScore: 40, status: 'in_progress' }))
    );
    const board = await dashboard(alice, 'lg-dm');
    expect(board).toMatchObject({ phase: 'regular_season', week: 1, yourTeamId: 'team-1', draft: null });
    expect(board.matchups).toHaveLength(2);
    expect(board.matchups[0]).toMatchObject({ status: 'in_progress', home: { score: 50, record: '0-0' } });
    const sides = board.matchups.flatMap((m) => [m.home, m.away]);
    expect(sides.find((s) => s.teamId === 'team-1')).toMatchObject({ ownerName: 'Alice', manager: null });
    expect(sides.find((s) => s.teamId === 'team-2')).toMatchObject({
      ownerName: null,
      manager: { name: expect.any(String) }
    });
    expect(board.standings.throughWeek).toBeNull();
    expect(board.standings.rows.map((r) => r.record)).toEqual(['0-0', '0-0', '0-0', '0-0']);
  });

  it('marks a matchup live only while a rostered player is in an NFL game', async () => {
    // The week is in progress, but no game has kicked off.
    const before = await dashboard(alice, 'lg-dm');
    expect(before.matchups.map((m) => [m.status, m.live])).toEqual([
      ['in_progress', false],
      ['in_progress', false]
    ]);

    const games = await h.services.data.reference.schedule.getWeek(2026, 1);
    await h.services.data.reference.nflGames.put({
      season: 2026,
      week: 1,
      games: games.map((g) => liveGame(g.gameId)),
      updatedAt: h.clock.now().toISOString()
    });
    const during = await dashboard(alice, 'lg-dm');
    // Only team-1 and team-2 have players; teams 3 and 4 have empty rosters.
    const rostered = (m: Dashboard['matchups'][number]) =>
      ['team-1', 'team-2'].includes(m.home.teamId) || ['team-1', 'team-2'].includes(m.away.teamId);
    expect(during.matchups.map((m) => m.live)).toEqual(during.matchups.map(rostered));
    expect(during.matchups.some((m) => m.live)).toBe(true);
    await h.services.data.reference.nflGames.put({
      season: 2026,
      week: 1,
      games: [],
      updatedAt: h.clock.now().toISOString()
    });
  });

  it('carries the records once a week is final', async () => {
    const week = await h.repos.schedule.listMatchups('lg-dm', 1);
    await h.repos.schedule.putMatchups(week.map((m) => ({ ...m, status: 'final' })));
    const league = await h.repos.leagues.get('lg-dm');
    await recordStandings({ repos: h.repos }, league!, 1, new Date(START));
    const board = await dashboard(bob, 'lg-dm');
    expect(board.standings.throughWeek).toBe(1);
    expect(board.standings.rows[0]).toMatchObject({ rank: 1, record: '1-0' });
    expect(board.matchups[0]?.home.record).toBe('1-0');
    expect(board.yourTeamId).toBe('team-3');
  });

  it('is for members only', async () => {
    expect(errorCode(await carol.get('/leagues/lg-dm/dashboard'))).toBe('FORBIDDEN');
    expect((await alice.get('/leagues/lg-dm/dashboard?moves=51')).status).toBe(400);
  });
});

describe('the move board', () => {
  beforeAll(async () => {
    await seedWaiverLeague(h.repos, {
      id: 'lg-dv',
      owners: [ALICE, BOB, null, null],
      rosters: {
        'team-1': ['fx-jallen', 'fx-cmc', 'fx-chase'],
        'team-2': ['fx-mahomes', 'fx-bijan'],
        'team-3': ['fx-hurts']
      }
    });
    const league = await h.repos.leagues.get('lg-dv');
    await h.repos.leagues.update({
      ...league!,
      settings: { ...league!.settings, trades: { ...league!.settings.trades, review: 'none' } }
    });
  });

  it('groups trades, adds with their drops, drops, and waiver awards into moves, newest first', async () => {
    h.clock.set(START);
    await h.repos.waivers.addTransactions([
      {
        id: 'seed-waiver',
        leagueId: 'lg-dv',
        at: START,
        week: 2,
        type: 'waiver_claim',
        teamId: 'team-3',
        addPlayerId: 'fx-lamb',
        dropPlayerId: null,
        cost: 7,
        claimId: 'claim-1'
      }
    ]);
    h.clock.advance(1000);
    const add = await alice.post('/leagues/lg-dv/waivers/claims', {
      playerId: 'fx-tucker',
      dropPlayerId: 'fx-chase'
    });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    h.clock.advance(1000);
    expect((await bob.post('/leagues/lg-dv/drops', { playerId: 'fx-bijan' })).status).toBe(200);
    h.clock.advance(1000);
    const offer = await alice.post('/leagues/lg-dv/trades', {
      withTeamId: 'team-2',
      send: ['fx-cmc'],
      receive: ['fx-mahomes']
    });
    expect(offer.status, JSON.stringify(offer.body)).toBe(200);
    const tradeId = data<{ trade: { id: string } }>(offer).trade.id;
    const accept = await bob.post(`/leagues/lg-dv/trades/${tradeId}/respond`, { response: 'accept' });
    expect(data<{ trade: { status: string } }>(accept).trade.status).toBe('processed');

    const board = await dashboard(bob, 'lg-dv');
    expect(board.moves.map((m) => m.type)).toEqual(['trade', 'drop', 'add', 'waiver']);
    const [trade, drop, added, waiver] = board.moves;
    expect(trade).toMatchObject({ id: tradeId });
    expect(trade?.teams).toEqual([
      expect.objectContaining({
        teamId: 'team-1',
        ownerName: 'Alice',
        added: [expect.objectContaining({ id: 'fx-mahomes' })],
        dropped: []
      }),
      expect.objectContaining({
        teamId: 'team-2',
        ownerName: 'Bob',
        added: [expect.objectContaining({ id: 'fx-cmc' })],
        dropped: []
      })
    ]);
    expect(drop?.teams).toEqual([
      expect.objectContaining({
        teamId: 'team-2',
        added: [],
        dropped: [{ id: 'fx-bijan', name: 'Bijan Robinson', team: expect.any(String), position: 'RB' }]
      })
    ]);
    expect(added?.teams[0]).toMatchObject({
      added: [{ id: 'fx-tucker' }],
      dropped: [{ id: 'fx-chase' }],
      cost: null
    });
    expect(waiver?.teams[0]).toMatchObject({
      teamId: 'team-3',
      ownerName: null,
      manager: { name: expect.any(String) },
      added: [{ id: 'fx-lamb' }],
      cost: 7
    });
    expect(board.hasMoreMoves).toBe(false);

    const first = await dashboard(alice, 'lg-dv', '?moves=2');
    expect(first.moves.map((m) => m.type)).toEqual(['trade', 'drop']);
    expect(first.hasMoreMoves).toBe(true);
  });
});

describe('after the season', () => {
  it('names the champion', async () => {
    const settings = yahooDefaultSettings(4);
    await seedLeague(h.repos, {
      id: 'lg-dc',
      owners: [ALICE, BOB, null, null],
      teamCount: 4,
      overrides: { phase: 'complete', week: 17, settings }
    });
    const seeding = seedPlayoffs(
      settings,
      Array.from({ length: 4 }, (_, i) => ({ teamId: `team-${i + 1}`, rank: i + 1 }))
    );
    if (!seeding.ok) throw new Error('seeding');
    const bracket = buildBracket(settings, seeding.value.seeds, { consolation: false, nonPlayoff: [] });
    if (!bracket.ok) throw new Error('bracket');
    await h.repos.history.putPlayoffs({
      leagueId: 'lg-dc',
      season: 2026,
      seedingWeek: 14,
      bracket: bracket.value,
      championTeamId: 'team-2',
      consolationChampionTeamId: null,
      updatedAt: START
    });
    const board = await dashboard(alice, 'lg-dc');
    expect(board).toMatchObject({
      phase: 'complete',
      draft: null,
      matchups: [],
      champion: { teamId: 'team-2', teamName: "Bob's Team", ownerName: 'Bob' }
    });
    expect(board.standings.rows).toHaveLength(4);
  });
});
