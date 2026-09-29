import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentWeek } from '../../src/players/current-form.js';
import { registry } from '../../src/operations/index.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { createHarness, type Harness } from '../support/harness.js';
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
  player: { id: string; team: string | null };
  thisSeason: {
    season: number;
    points: number;
    ppg: number;
    games: number;
    weekly: { week: number; points: number }[];
    totals: Record<string, number>;
  } | null;
  nextWeek: {
    season: number;
    week: number;
    points: number | null;
    totals: Record<string, number>;
    bye: boolean;
    opponent: { team: string; home: boolean } | null;
    kickoff: string | null;
  } | null;
}

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
    {
      playerId: 'fx-chase',
      season: 2026,
      week: 1,
      stats: { gp: 1, rec: 8, rec_yd: 100, rec_td: 1 },
      updatedAt: 'x'
    },
    { playerId: 'fx-chase', season: 2026, week: 3, stats: { gp: 1, rec: 4, rec_yd: 50 }, updatedAt: 'x' },
    // Last season and the playoffs are not this season.
    { playerId: 'fx-chase', season: 2025, week: 3, stats: { gp: 1, rec: 9, rec_yd: 200 }, updatedAt: 'x' },
    { playerId: 'fx-chase', season: 2026, week: 19, stats: { gp: 1, rec: 9, rec_yd: 200 }, updatedAt: 'x' }
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
  it("shows this season so far, week by week, with weeks the live job missed, scored with the league's settings", async () => {
    const { thisSeason } = await card('fx-chase');
    // Half PPR: week 1 = 4 + 10 + 6 = 20 (the live line, not the stale copy); week 2 = 2.5 + 6 =
    // 8.5 (only in the research set); week 3 = 2 + 5 = 7.
    expect(thisSeason).toEqual({
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
      kickoff: '2026-10-04T17:00:00.000Z'
    });
    expect(player.team).toBeTruthy();
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
