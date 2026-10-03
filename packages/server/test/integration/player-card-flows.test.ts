import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { currentWeek } from '../../src/players/current-form.js';
import { registry } from '../../src/operations/index.js';
import { seasonInPlay } from '../../src/operations/research/get-points-allowed.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { createHarness, type Harness } from '../support/harness.js';
import { sourcePlayer } from '../support/jobs.js';
import { as, data, type Caller } from '../support/league-client.js';
import { ALICE, seedLeague } from '../support/leagues.js';

/**
 * The player card in season (the card anywhere in the app): this season so far, week by week, and
 * next week's projection with the matchup, scored under the league's settings.
 */

const L = 'lg-card';
let h: Harness;
let alice: Caller;

interface Card {
  player: { id: string; team: string | null; injuryNote?: { text: string; reportedAt: string | null } };
  injuryStatus: string | null;
  injuryNote: { text: string; reportedAt: string | null } | null;
  bio: { age: number | null; yearsExp: number | null; number: number | null };
  thisSeason: {
    season: number;
    points: number;
    ppg: number;
    games: number;
    weekly: { week: number; points: number }[];
    totals: Record<string, number>;
    recent: {
      week: number;
      points: number;
      vsAverage: number;
      opponent: { team: string; home: boolean } | null;
      breakdown: { stat: string; text: string; points: number }[];
    }[];
    usage: Record<string, number | null> | null;
  } | null;
  nextWeek: {
    season: number;
    week: number;
    points: number | null;
    totals: Record<string, number>;
    bye: boolean;
    opponent: { team: string; home: boolean } | null;
    kickoff: string | null;
    matchup: {
      position: string;
      perGame: number;
      rank: number;
      of: number;
      games: number;
      throughWeek: number;
    } | null;
  } | null;
}

interface PointsAllowed {
  season: number | null;
  throughWeek: number | null;
  scoring: string;
  teams: {
    team: string;
    games: number;
    positions: Record<string, { perGame: number; rank: number; of: number }>;
  }[];
}

const CHASE_NOTE = { text: 'Chase (hip) is questionable for Sunday.', reportedAt: '2026-10-02T20:00Z' };

/** A team defense's week: its id is the team code, and `fan_pts_allow_*` are Sleeper's PPR points allowed. */
const defense = (team: string, season: number, week: number, stats: Record<string, number>) => ({
  playerId: team,
  season,
  week,
  stats: { gp: 1, ...stats },
  updatedAt: 'x'
});

const card = async (playerId: string) =>
  data<Card>(await alice.get(`/players/card?playerId=${playerId}&leagueId=${L}`));

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry, players: fixtureDraftPool });
  alice = as(h, ALICE);
  await seedLeague(h.repos, { id: L, owners: [ALICE] });
  const reference = h.services.data.reference;
  await reference.nflState.put(
    {
      season: 2026,
      seasonType: 'regular',
      week: 4,
      displayWeek: 4,
      leagueSeason: 2026,
      previousSeason: 2025,
      seasonStartDate: '2026-09-10',
      updatedAt: 'x'
    },
    null
  );
  const chase = fixtureDraftPool.find((p) => p.id === 'fx-chase')!;
  // Chase: two games (week 2 was a missing line), 100 and 50 receiving yards, one touchdown.
  await reference.stats.putLines([
    // Weeks 1 and 3 are official: they carry nflverse's usage stats (`nfv_…`).
    {
      playerId: 'fx-chase',
      season: 2026,
      week: 1,
      stats: {
        gp: 1,
        rec: 8,
        rec_yd: 100,
        rec_td: 1,
        rec_tgt: 10,
        nfv_tgt_share: 0.3,
        nfv_air_yd_share: 0.4,
        nfv_wopr: 0.73,
        nfv_rec_air_yd: 90,
        nfv_rec_yac: 30,
        nfv_rec_epa: 5
      },
      updatedAt: 'x'
    },
    {
      playerId: 'fx-chase',
      season: 2026,
      week: 3,
      stats: {
        gp: 1,
        rec: 4,
        rec_yd: 50,
        rec_tgt: 6,
        nfv_tgt_share: 0.2,
        nfv_air_yd_share: 0.2,
        nfv_wopr: 0.44,
        nfv_rec_air_yd: 60,
        nfv_rec_yac: 10,
        nfv_rec_epa: -1
      },
      updatedAt: 'x'
    },
    // Last season and the playoffs are not this season.
    { playerId: 'fx-chase', season: 2025, week: 3, stats: { gp: 1, rec: 9, rec_yd: 200 }, updatedAt: 'x' },
    { playerId: 'fx-chase', season: 2026, week: 19, stats: { gp: 1, rec: 9, rec_yd: 200 }, updatedAt: 'x' }
  ]);
  // Defenses' points allowed to receivers, per game: CLE 50, BAL 35, KC 15, MIA 0 (Sleeper leaves
  // the zero out). NYG's line has no points-allowed keys and the game in progress (week 4) is not
  // complete: neither counts. BAL's 2025 line is another season.
  await reference.stats.putLines([
    defense('BAL', 2026, 1, { fan_pts_allow: 100, fan_pts_allow_wr: 40, fan_pts_allow_qb: 20 }),
    defense('BAL', 2026, 2, { fan_pts_allow: 90, fan_pts_allow_wr: 30, fan_pts_allow_qb: 10 }),
    defense('BAL', 2026, 3, { fan_pts_allow: 95, fan_pts_allow_wr: 35, fan_pts_allow_qb: 15 }),
    defense('BAL', 2025, 17, { fan_pts_allow: 60, fan_pts_allow_wr: 22 }),
    defense('KC', 2026, 1, { fan_pts_allow: 70, fan_pts_allow_wr: 20, fan_pts_allow_qb: 30 }),
    defense('KC', 2026, 3, { fan_pts_allow: 60, fan_pts_allow_wr: 10, fan_pts_allow_qb: 30 }),
    defense('CLE', 2026, 1, { fan_pts_allow: 120, fan_pts_allow_wr: 50, fan_pts_allow_qb: 5 }),
    defense('CLE', 2026, 4, { fan_pts_allow: 200, fan_pts_allow_wr: 99 }),
    defense('MIA', 2026, 1, { fan_pts_allow: 10, fan_pts_allow_qb: 10 }),
    defense('NYG', 2026, 2, { pts_allow: 17 })
  ]);
  // Chase's synced Sleeper record (age, experience, jersey) and ESPN's note on his designation.
  await reference.playerSync.upsert([
    {
      player: { ...chase, injuryStatus: 'Questionable', injuryNote: CHASE_NOTE },
      source: sourcePlayer({ id: 'fx-chase', team: chase.team, age: 26, yearsExp: 5, number: 1 })
    }
  ]);
  // The research sync's copy of this season: week 2, which the live job missed, and a stale week 1
  // that the live line overrides.
  await reference.seasons.put(
    { kind: 'stats', season: 2026, updatedAt: 'x', checkedAt: 'x', players: 1, weeks: [1, 2], hash: 'h' },
    [
      {
        playerId: 'fx-chase',
        season: 2026,
        weeks: [
          { week: 1, stats: { gp: 1, rec: 1, rec_yd: 1 } },
          { week: 2, stats: { gp: 1, rec: 5, rec_yd: 60 } }
        ]
      }
    ]
  );
  await reference.projections.putSnapshot(
    { season: 2026, week: 4, capturedAt: '2026-09-09T00:00:00.000Z', hash: 'h', count: 1 },
    [{ playerId: 'fx-chase', season: 2026, week: 4, stats: { rec: 6, rec_yd: 80 } }]
  );
  await reference.schedule.putSeason(
    2026,
    [
      {
        gameId: '2026_01_CIN_CLE',
        season: 2026,
        seasonType: 'regular',
        week: 1,
        kickoff: '2026-09-13T17:00:00.000Z',
        homeTeam: 'CLE',
        awayTeam: chase.team!,
        status: 'final'
      },
      {
        gameId: '2026_03_KC_CIN',
        season: 2026,
        seasonType: 'regular',
        week: 3,
        kickoff: '2026-09-27T17:00:00.000Z',
        homeTeam: chase.team!,
        awayTeam: 'KC',
        status: 'final'
      },
      {
        gameId: '2026_04_BAL_CIN',
        season: 2026,
        seasonType: 'regular',
        week: 4,
        kickoff: '2026-10-04T17:00:00.000Z',
        homeTeam: chase.team!,
        awayTeam: 'BAL',
        status: 'scheduled'
      }
    ],
    {},
    new Date('2026-05-01')
  );
});

afterAll(() => h.close());

describe('the player card in season', () => {
  it('sums up his usage over the official weeks, from the nflverse numbers on those lines', async () => {
    const { thisSeason } = await card('fx-chase');
    // Weeks 1 and 3 (week 2 is not official yet): 16 targets, 12 catches, 150 air yards, 40 YAC.
    expect(thisSeason?.usage).toEqual({
      games: 2,
      throughWeek: 3,
      targetShare: 0.25,
      airYardsShare: 0.3,
      wopr: 0.585,
      aDot: 9.4,
      yacPerReception: 3.3,
      receivingEpa: 2,
      rushingEpa: null,
      passingEpa: null,
      cpoe: null,
      passingAdot: null
    });
    // Lamb has no official week: no usage.
    expect((await card('fx-lamb')).thisSeason).toBeNull();
  });

  it("shows this season so far, week by week, with weeks the live job missed, scored with the league's settings", async () => {
    const { thisSeason } = await card('fx-chase');
    // Half PPR: week 1 = 4 + 10 + 6 = 20 (the live line, not the stale copy); week 2 = 2.5 + 6 =
    // 8.5 (only in the research set); week 3 = 2 + 5 = 7.
    expect(thisSeason).toMatchObject({
      season: 2026,
      points: 35.5,
      ppg: 11.83,
      games: 3,
      weekly: [
        { week: 1, points: 20 },
        { week: 2, points: 8.5 },
        { week: 3, points: 7 }
      ],
      totals: expect.objectContaining({ rec: 17, rec_yd: 210, rec_td: 1 })
    });
  });

  it('details his last three games: points against his average, the opponent, and where the points came from', async () => {
    const { thisSeason } = await card('fx-chase');
    // Newest first. Half PPR: week 3 = 4 rec (2) + 50 yds (5); week 2 = 5 rec (2.5) + 60 yds (6);
    // week 1 = 8 rec (4) + 100 yds (10) + 1 TD (6). His average is 11.83.
    expect(thisSeason?.recent).toEqual([
      {
        week: 3,
        points: 7,
        vsAverage: -4.8,
        opponent: { team: 'KC', home: true },
        breakdown: [
          { stat: 'rec_yd', text: '50 rec yds', points: 5 },
          { stat: 'rec', text: '4 rec', points: 2 }
        ]
      },
      {
        week: 2,
        points: 8.5,
        vsAverage: -3.3,
        // The week's schedule is not known: no opponent, rather than a wrong one.
        opponent: null,
        breakdown: [
          { stat: 'rec_yd', text: '60 rec yds', points: 6 },
          { stat: 'rec', text: '5 rec', points: 2.5 }
        ]
      },
      {
        week: 1,
        points: 20,
        vsAverage: 8.2,
        opponent: { team: 'CLE', home: false },
        breakdown: [
          { stat: 'rec_yd', text: '100 rec yds', points: 10 },
          { stat: 'rec_td', text: '1 rec TD', points: 6 },
          { stat: 'rec', text: '8 rec', points: 4 }
        ]
      }
    ]);
  });

  it('projects the current week with the opponent and kickoff', async () => {
    const { nextWeek, player } = await card('fx-chase');
    // Half PPR: 3 + 8 = 11.
    expect(nextWeek).toEqual({
      season: 2026,
      week: 4,
      points: 11,
      totals: expect.objectContaining({ rec: 6, rec_yd: 80 }),
      bye: false,
      opponent: { team: 'BAL', home: true },
      kickoff: '2026-10-04T17:00:00.000Z',
      // BAL allows 35 PPR points a game to receivers through week 3: second most of four.
      matchup: { position: 'WR', perGame: 35, rank: 2, of: 4, games: 3, throughWeek: 3 }
    });
    expect(player.team).toBeTruthy();
  });

  it('still loads, without the matchup or the bio, when their reads fail', async () => {
    const reference = h.services.data.reference;
    // One defense's read fails (BAL, his opponent, still reads): the whole table is unavailable.
    const read = reference.stats.getPlayerHistory.bind(reference.stats);
    const history = vi
      .spyOn(reference.stats, 'getPlayerHistory')
      .mockImplementation(async (playerId, season) => {
        if (playerId === 'KC') throw new Error('throttled');
        return read(playerId, season);
      });
    const sync = vi.spyOn(reference.playerSync, 'getMany').mockRejectedValue(new Error('throttled'));
    try {
      const chase = await card('fx-chase');
      expect(chase.nextWeek).toMatchObject({
        opponent: { team: 'BAL', home: true },
        points: 11,
        matchup: null
      });
      expect(chase.bio).toEqual({ age: null, yearsExp: null, number: null });
      expect(chase.thisSeason?.games).toBe(3);
    } finally {
      history.mockRestore();
      sync.mockRestore();
    }
  });

  it('shows his age, experience, and jersey number, and ESPN’s note on his injury', async () => {
    const chase = await card('fx-chase');
    expect(chase.bio).toEqual({ age: 26, yearsExp: 5, number: 1 });
    expect(chase.injuryStatus).toBe('Questionable');
    expect(chase.injuryNote).toEqual(CHASE_NOTE);
    expect(chase.player.injuryNote).toEqual(CHASE_NOTE);
    // No synced record and no note: unknowns, not guesses.
    const lamb = await card('fx-lamb');
    expect(lamb.bio).toEqual({ age: null, yearsExp: null, number: null });
    expect(lamb.injuryNote).toBeNull();
  });

  it('marks a bye and leaves out what is not there yet', async () => {
    // Lamb's team has no game in week 4, no projection, and no stats this season.
    const lamb = await card('fx-lamb');
    expect(lamb.thisSeason).toBeNull();
    expect(lamb.nextWeek).toMatchObject({
      week: 4,
      points: null,
      totals: {},
      bye: true,
      opponent: null,
      kickoff: null
    });
  });
});

describe('get_points_allowed', () => {
  const get = async (query: string) =>
    (await alice.get(`/nfl-teams/points-allowed${query}`)).body as {
      data: PointsAllowed;
      warnings?: { code: string }[];
    };

  it('ranks every defense with completed games, 1 allowing the most', async () => {
    const { data: table } = await get('');
    expect(table).toMatchObject({ season: 2026, throughWeek: 3, scoring: 'ppr' });
    expect(table.teams.map((t) => t.team)).toEqual(['BAL', 'CLE', 'KC', 'MIA']);
    const kc = table.teams.find((t) => t.team === 'KC')!;
    expect(kc.games).toBe(2);
    // KC allows 30 a game to quarterbacks, the most; BAL and the rest follow. Ties share a rank.
    expect(kc.positions.QB).toEqual({ perGame: 30, rank: 1, of: 4 });
    expect(kc.positions.RB).toEqual({ perGame: 0, rank: 1, of: 4 });
    expect(table.teams.find((t) => t.team === 'MIA')!.positions.WR).toEqual({ perGame: 0, rank: 4, of: 4 });
  });

  it('sorts by a position, filters to a team, and counts a past season whole', async () => {
    expect((await get('?position=WR')).data.teams.map((t) => [t.team, t.positions.WR!.perGame])).toEqual([
      ['CLE', 50],
      ['BAL', 35],
      ['KC', 15],
      ['MIA', 0]
    ]);
    expect((await get('?team=BAL')).data.teams.map((t) => t.team)).toEqual(['BAL']);
    const past = (await get('?season=2025')).data;
    expect(past).toMatchObject({ season: 2025, throughWeek: 18 });
    expect(past.teams).toEqual([
      { team: 'BAL', games: 1, positions: expect.objectContaining({ WR: { perGame: 22, rank: 1, of: 1 } }) }
    ]);
  });

  it('defaults to the season just played, all 18 weeks, once the regular season is over', async () => {
    const reference = h.services.data.reference;
    const regular = (await reference.nflState.get())!;
    const { updatedAt: _at, ...expected } = regular;
    await reference.nflState.put({ ...regular, seasonType: 'post', week: 1 }, expected);
    try {
      const { data: table, warnings } = await get('');
      // Week 4's line (CLE's 99 to receivers) now counts: CLE averages (50 + 99) / 2.
      expect(table).toMatchObject({ season: 2026, throughWeek: 18 });
      expect(warnings ?? []).toEqual([]);
      expect(table.teams.find((t) => t.team === 'CLE')).toMatchObject({
        games: 2,
        positions: expect.objectContaining({ WR: { perGame: 74.5, rank: 1, of: 4 } })
      });
    } finally {
      const { updatedAt: _post, ...post } = (await reference.nflState.get())!;
      await reference.nflState.put(regular, post);
    }
  });

  it('is empty with a warning when no completed week has defense stats', async () => {
    const none = await get('?season=2024');
    expect(none.data).toMatchObject({ season: 2024, throughWeek: null, teams: [] });
    expect(none.warnings?.map((w) => w.code)).toEqual(['NO_POINTS_ALLOWED']);
  });
});

describe('seasonInPlay', () => {
  it('is the coming season in the preseason, the weeks so far in season, and all 18 weeks after it', () => {
    const base = { season: 2026, week: 7, leagueSeason: 2026 };
    expect(seasonInPlay({ ...base, seasonType: 'pre', season: 2025 })).toEqual({ season: 2026, week: 1 });
    expect(seasonInPlay({ ...base, seasonType: 'regular' })).toEqual({ season: 2026, week: 7 });
    expect(seasonInPlay({ ...base, seasonType: 'regular', week: 0 })).toEqual({ season: 2026, week: 1 });
    expect(seasonInPlay({ ...base, seasonType: 'post', week: 2 })).toEqual({ season: 2026, week: 19 });
    expect(seasonInPlay({ ...base, seasonType: 'off', week: 0 })).toEqual({ season: 2026, week: 19 });
    expect(seasonInPlay(null)).toBeNull();
  });
});

describe('currentWeek', () => {
  it('is the NFL week in season, week 1 in the preseason, and nothing otherwise', () => {
    const base = { season: 2026, week: 7, leagueSeason: 2026 };
    expect(currentWeek({ ...base, seasonType: 'regular' })).toEqual({ season: 2026, week: 7 });
    expect(currentWeek({ ...base, seasonType: 'regular', week: 0 })).toEqual({ season: 2026, week: 1 });
    expect(currentWeek({ ...base, seasonType: 'pre', season: 2025, leagueSeason: 2026 })).toEqual({
      season: 2026,
      week: 1
    });
    expect(currentWeek({ ...base, seasonType: 'post' })).toBeNull();
    expect(currentWeek({ ...base, seasonType: 'off' })).toBeNull();
    expect(currentWeek(null)).toBeNull();
  });
});
