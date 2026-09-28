import type { PlayerSeasonLines } from '@fantasy/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/operations/index.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../support/leagues.js';

/**
 * Draft research (#136) over HTTP (DynamoDB Local): the board's last-season, projection, bye, and
 * injury fields and its sorts; the player card; the depth view; and who may read them.
 */

const L = 'lg-research';
let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;

interface Available {
  player: { id: string; position: string };
  rank: number | null;
  lastSeason: { points: number; ppg: number; games: number } | null;
  projection: { points: number } | null;
  bye: number | null;
  injuryStatus: string | null;
}

const board = async (caller: Caller, query = '') =>
  data<{ bestAvailable: Available[] }>(await caller.get(`/leagues/${L}/draft${query}`));

/** Weekly lines: each entry is one week's stats, `null` a week without a line (bye). */
function season(playerId: string, year: number, weeks: (Record<string, number> | null)[]): PlayerSeasonLines {
  return {
    playerId,
    season: year,
    weeks: weeks.flatMap((stats, i) => (stats === null ? [] : [{ week: i + 1, stats }])),
    team: 'X'
  };
}

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry, players: fixtureDraftPool });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
  await seedLeague(h.repos, { id: L, owners: [ALICE, BOB] });
  const lamb = fixtureDraftPool.find((p) => p.id === 'fx-lamb')!;
  await h.repos.players.putMany([{ ...lamb, injuryStatus: 'Questionable' }]);

  const reference = h.services.data.reference;
  await reference.nflState.put(
    {
      season: 2026,
      seasonType: 'pre',
      week: 1,
      displayWeek: 1,
      leagueSeason: 2026,
      previousSeason: 2025,
      seasonStartDate: '2026-09-10',
      updatedAt: 'x'
    },
    null
  );
  await reference.schedule.putSeason(2026, [], { CIN: 10, DAL: 7, SF: 14 }, new Date('2026-05-01'));
  const meta = { updatedAt: 'x', weeks: [1, 2, 3], hash: 'h' };
  // Half PPR (league default): Chase 2 games at 20 (40, 20 PPG); Lamb 3 games 10 + 10 + 25 (45, 15 PPG);
  // CMC one game of 30.
  await reference.seasons.put({ ...meta, kind: 'stats', season: 2025, players: 3 }, [
    season('fx-chase', 2025, [{ gp: 1, rec: 10, rec_yd: 150 }, null, { gp: 1, rec: 10, rec_yd: 150 }]),
    season('fx-lamb', 2025, [
      { gp: 1, rec: 4, rec_yd: 80 },
      { gp: 1, rec: 4, rec_yd: 80 },
      { gp: 1, rec: 10, rec_yd: 140, rec_td: 1 }
    ]),
    season('fx-cmc', 2025, [{ gp: 1, rush_att: 20, rush_yd: 150, rush_td: 2, rec: 6, rec_yd: 30 }])
  ]);
  await reference.seasons.put({ ...meta, kind: 'projections', season: 2026, players: 2 }, [
    season('fx-chase', 2026, [{ rec: 6, rec_yd: 90 }]),
    season('fx-bijan', 2026, [{ rush_yd: 400 }])
  ]);
  for (let i = 0; i < 3; i++) {
    await reference.news.add({
      id: `n${i}`,
      url: `https://example.com/${i}`,
      title: `Chase note ${i}`,
      source: 'ESPN',
      publishedAt: `2026-09-0${i + 1}T12:00:00.000Z`,
      summary: null,
      playerIds: ['fx-chase'],
      teams: ['CIN'],
      ingestedAt: '2026-09-01T00:00:00.000Z'
    });
  }
  await reference.news.add({
    id: 'n9',
    url: 'https://example.com/9',
    title: 'Old Chase note',
    source: 'CBS',
    publishedAt: '2026-08-01T12:00:00.000Z',
    summary: null,
    playerIds: ['fx-chase'],
    teams: [],
    ingestedAt: '2026-09-01T00:00:00.000Z'
  });

  const order = ['team-2', 'team-1', 'team-3', 'team-4', 'team-5', 'team-6', 'team-7', 'team-8'];
  const started = await alice.post(`/leagues/${L}/draft/start`, { order });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
});
afterAll(() => h.close());

describe('draft board research fields', () => {
  it('adds last season, projection, bye, and injury under the league scoring', async () => {
    const { bestAvailable } = await board(alice, '?limit=5');
    const chase = bestAvailable.find((a) => a.player.id === 'fx-chase');
    expect(chase).toEqual({
      player: expect.objectContaining({ id: 'fx-chase' }),
      rank: 1,
      lastSeason: { points: 40, ppg: 20, games: 2 },
      projection: { points: 12 },
      bye: 10,
      injuryStatus: null
    });
    const lamb = bestAvailable.find((a) => a.player.id === 'fx-lamb');
    expect(lamb).toMatchObject({ lastSeason: { points: 45, ppg: 15, games: 3 }, bye: 7 });
    expect(lamb?.injuryStatus).toBe('Questionable');
    expect(bestAvailable.find((a) => a.player.id === 'fx-jjefferson')).toMatchObject({
      lastSeason: null,
      projection: null,
      bye: null
    });
  });

  it('sorts by last season points, PPG, or projection, players without one last', async () => {
    const ids = async (sort: string, extra = '') =>
      (await board(alice, `?sort=${sort}&limit=4${extra}`)).bestAvailable.map((a) => a.player.id);
    expect(await ids('lastSeasonPoints')).toEqual(['fx-lamb', 'fx-chase', 'fx-cmc', 'fx-jjefferson']);
    expect(await ids('ppg')).toEqual(['fx-cmc', 'fx-chase', 'fx-lamb', 'fx-jjefferson']);
    expect(await ids('projection')).toEqual(['fx-bijan', 'fx-chase', 'fx-jjefferson', 'fx-cmc']);
    expect(await ids('lastSeasonPoints', '&position=WR')).toEqual([
      'fx-lamb',
      'fx-chase',
      'fx-jjefferson',
      'fx-arsb'
    ]);
    expect(await ids('rank')).toEqual(['fx-chase', 'fx-jjefferson', 'fx-cmc', 'fx-lamb']);
    const bad = await alice.get(`/leagues/${L}/draft?sort=adp`);
    expect(bad.status).toBe(400);
  });
});

describe('get_player_card', () => {
  it('shows weekly points, totals, projection, bye, and the 3 newest headlines', async () => {
    const res = await alice.get(`/players/card?playerId=fx-chase&leagueId=${L}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = data<Record<string, unknown>>(res);
    expect(card).toMatchObject({
      player: { id: 'fx-chase', rank: 1, injuryStatus: null },
      scoring: { source: 'league' },
      bye: 10,
      injuryStatus: null,
      lastSeason: {
        season: 2025,
        points: 40,
        ppg: 20,
        games: 2,
        weekly: [
          { week: 1, points: 20 },
          { week: 3, points: 20 }
        ],
        totals: { rec_tgt: 0, rec: 20, rec_yd: 300, rec_td: 0 }
      },
      projection: { season: 2026, points: 12, totals: { rec: 6, rec_yd: 90 } }
    });
    expect((card.news as { title: string }[]).map((n) => n.title)).toEqual([
      'Chase note 2',
      'Chase note 1',
      'Chase note 0'
    ]);
  });

  it('works without a league (default scoring) and for a player with no data', async () => {
    const card = data<Record<string, unknown>>(await carol.get('/players/card?player=jefferson'));
    expect(card).toMatchObject({
      player: { id: 'fx-jjefferson' },
      scoring: { source: 'default' },
      lastSeason: null,
      projection: null,
      news: []
    });
  });

  it('refuses a league the caller is not in, and an unknown player', async () => {
    expect(errorCode(await carol.get(`/players/card?playerId=fx-chase&leagueId=${L}`))).toBe('FORBIDDEN');
    expect(errorCode(await alice.get('/players/card?playerId=nobody'))).toBe('PLAYER_NOT_FOUND');
  });
});

describe('get_draft_depth', () => {
  interface Depth {
    yourTeamId: string | null;
    teams: {
      teamId: string;
      yours: boolean;
      picksBeforeYou: number;
      positions: { position: string; players: { id: string }[] }[];
      slots: { slot: string; required: number; filled: number }[];
      gaps: string[];
    }[];
  }
  const depth = async (caller: Caller) => data<Depth>(await caller.get(`/leagues/${L}/draft/depth`));

  it('groups each team by position with slot fill and gaps, your team first', async () => {
    const pick = await bob.post(`/leagues/${L}/draft/picks`, { playerId: 'fx-cmc', pick: 1 });
    expect(pick.status, JSON.stringify(pick.body)).toBe(200);
    const view = await depth(bob);
    expect(view.yourTeamId).toBe('team-2');
    expect(view.teams.map((t) => t.teamId)).toEqual([
      'team-2',
      'team-1',
      'team-3',
      'team-4',
      'team-5',
      'team-6',
      'team-7',
      'team-8'
    ]);
    const bobs = view.teams[0]!;
    expect(bobs.yours).toBe(true);
    expect(bobs.positions.find((p) => p.position === 'RB')?.players.map((p) => p.id)).toEqual(['fx-cmc']);
    expect(bobs.positions.map((p) => p.position)).toEqual(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
    expect(bobs.slots.find((s) => s.slot === 'RB')).toEqual({ slot: 'RB', required: 2, filled: 1 });
    expect(bobs.gaps.filter((g) => g === 'RB')).toHaveLength(1);
    expect(bobs.gaps).toContain('W/R/T');
    // Bob picks 16th next: everyone else picks once or twice before him (snake).
    expect(bobs.picksBeforeYou).toBe(0);
    expect(view.teams.find((t) => t.teamId === 'team-1')?.picksBeforeYou).toBe(2);
    expect(view.teams.find((t) => t.teamId === 'team-3')?.picksBeforeYou).toBe(2);
  });

  it('shows no team emphasis for someone without a team, and refuses outsiders', async () => {
    expect(errorCode(await carol.get(`/leagues/${L}/draft/depth`))).toBe('FORBIDDEN');
    const view = await depth(alice);
    expect(view.teams[0]).toMatchObject({ teamId: 'team-1', yours: true, picksBeforeYou: 0 });
  });

  it('has no depth before a draft starts', async () => {
    await seedLeague(h.repos, { id: 'lg-research-2', owners: [ALICE] });
    const res = await alice.get('/leagues/lg-research-2/draft/depth');
    expect(errorCode(res)).toBe('DRAFT_NOT_STARTED');
  });
});
