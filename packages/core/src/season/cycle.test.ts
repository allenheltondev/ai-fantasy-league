import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ROSTER_SLOTS, type RosterSlot } from '../rules/positions.js';
import { yahooDefaultSettings } from '../rules/settings.js';
import { computeStandings } from '../standings/standings.js';
import { HOUR_MS } from '../time.js';
import {
  applyLineupMoves,
  firstKickoff,
  gameWindows,
  nextLeagueWeek,
  playoffBracket,
  playoffMatchups,
  reconcileLineup,
  weekEndsAt
} from './cycle.js';

const game = (kickoff: string, homeTeam: string, awayTeam: string) => ({ kickoff, homeTeam, awayTeam });

// A typical week: Thursday night, Sunday 1pm (two games), 4:05 and 4:25, Sunday night, Monday night.
const WEEK = [
  game('2026-09-18T17:00:00.000Z', 'NYG', 'DAL'),
  game('2026-09-18T17:00:00.000Z', 'CHI', 'DET'),
  game('2026-09-11T00:15:00.000Z', 'KC', 'BAL'),
  game('2026-09-18T20:05:00.000Z', 'SF', 'ARI'),
  game('2026-09-18T20:25:00.000Z', 'SEA', 'LAR'),
  game('2026-09-19T00:20:00.000Z', 'PHI', 'WAS'),
  game('2026-09-20T00:15:00.000Z', 'BUF', 'MIA')
];

describe('gameWindows', () => {
  it('groups kickoffs into windows in time order', () => {
    const windows = gameWindows(WEEK);
    expect(windows.map((w) => w.startsAt)).toEqual([
      '2026-09-11T00:15:00.000Z',
      '2026-09-18T17:00:00.000Z',
      '2026-09-18T20:05:00.000Z',
      '2026-09-19T00:20:00.000Z',
      '2026-09-20T00:15:00.000Z'
    ]);
    expect(windows[1]?.teams).toEqual(['CHI', 'DAL', 'DET', 'NYG']);
    expect(windows[2]?.teams).toEqual(['ARI', 'LAR', 'SEA', 'SF']);
  });

  it('is empty without games', () => {
    expect(gameWindows([])).toEqual([]);
    expect(firstKickoff([])).toBeNull();
    expect(weekEndsAt([], HOUR_MS)).toBeNull();
  });

  it('finds the first kickoff and when the last game ends', () => {
    expect(firstKickoff(WEEK)).toBe('2026-09-11T00:15:00.000Z');
    expect(weekEndsAt(WEEK, 4 * HOUR_MS)).toBe('2026-09-20T04:15:00.000Z');
  });

  it('puts every game in exactly one window, starting no later than its kickoff', () => {
    const kickoffs = fc.array(fc.integer({ min: 0, max: 7 * 24 * 60 }), { minLength: 1, maxLength: 16 });
    fc.assert(
      fc.property(kickoffs, (minutes) => {
        const games = minutes.map((m, i) =>
          game(new Date(Date.UTC(2026, 8, 10) + m * 60_000).toISOString(), `H${i}`, `A${i}`)
        );
        const windows = gameWindows(games);
        for (const g of games) {
          const holding = windows.filter((w) => w.teams.includes(g.homeTeam));
          expect(holding).toHaveLength(1);
          expect(Date.parse(holding[0]?.startsAt ?? '')).toBeLessThanOrEqual(Date.parse(g.kickoff));
        }
        const starts = windows.map((w) => Date.parse(w.startsAt));
        for (let i = 1; i < starts.length; i++) {
          expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThan(HOUR_MS);
        }
      })
    );
  });
});

describe('nextLeagueWeek', () => {
  const settings = yahooDefaultSettings(8);

  it('walks the regular season, into the playoffs, and to the end', () => {
    expect(nextLeagueWeek(settings, 'regular_season', 1)).toEqual({ phase: 'regular_season', week: 2 });
    expect(nextLeagueWeek(settings, 'regular_season', 14)).toEqual({ phase: 'playoffs', week: 15 });
    expect(nextLeagueWeek(settings, 'playoffs', 15)).toEqual({ phase: 'playoffs', week: 16 });
    expect(nextLeagueWeek(settings, 'playoffs', 17)).toEqual({ phase: 'complete', week: 17 });
  });
});

describe('reconcileLineup', () => {
  it('drops players who left, benches newcomers, and removes duplicates', () => {
    expect(
      reconcileLineup(
        [
          { playerId: 'a', slot: 'QB' },
          { playerId: 'gone', slot: 'WR' },
          { playerId: 'a', slot: 'BN' },
          { playerId: 'b', slot: 'RB' }
        ],
        ['a', 'b', 'c']
      )
    ).toEqual([
      { playerId: 'a', slot: 'QB' },
      { playerId: 'b', slot: 'RB' },
      { playerId: 'c', slot: 'BN' }
    ]);
  });

  it('always yields each rostered player exactly once', () => {
    const slot = fc.constantFrom<RosterSlot>(...ROSTER_SLOTS);
    const id = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f');
    fc.assert(
      fc.property(fc.array(fc.record({ playerId: id, slot })), fc.uniqueArray(id), (lineup, roster) => {
        const out = reconcileLineup(lineup, roster);
        expect(out.map((e) => e.playerId).sort()).toEqual([...roster].sort());
      })
    );
  });
});

describe('applyLineupMoves', () => {
  const lineup = [
    { playerId: 'a', slot: 'QB' as const },
    { playerId: 'b', slot: 'BN' as const }
  ];

  it('moves players, keeps the rest, and lets the last move win', () => {
    expect(
      applyLineupMoves(lineup, [
        { playerId: 'b', slot: 'WR' },
        { playerId: 'b', slot: 'RB' }
      ])
    ).toEqual([
      { playerId: 'a', slot: 'QB' },
      { playerId: 'b', slot: 'RB' }
    ]);
  });

  it('appends players it does not know so validation can reject them', () => {
    expect(applyLineupMoves(lineup, [{ playerId: 'z', slot: 'TE' }])).toContainEqual({
      playerId: 'z',
      slot: 'TE'
    });
  });
});

describe('playoffMatchups', () => {
  const settings = yahooDefaultSettings(8);
  const teams = Array.from({ length: 8 }, (_, i) => `t${i + 1}`);
  // t1 beats everyone, t2 everyone else, and so on: the standings rank t1..t8.
  const final = computeStandings(
    settings,
    teams.flatMap((home, i) =>
      teams
        .slice(i + 1)
        .map((away) => ({ week: 1, homeTeamId: home, awayTeamId: away, homeScore: 100, awayScore: 90 }))
    ),
    { teamIds: teams }
  );

  it('pairs the first round, then the winners with the byes', () => {
    const round1 = playoffMatchups(settings, final, [], 15);
    expect(round1).toEqual({
      ok: true,
      value: [
        { gameId: 'championship-r1-g1', bracket: 'championship', homeTeamId: 't4', awayTeamId: 't5' },
        { gameId: 'championship-r1-g2', bracket: 'championship', homeTeamId: 't3', awayTeamId: 't6' }
      ]
    });
    const round2 = playoffMatchups(
      settings,
      final,
      [
        {
          week: 15,
          results: [
            { homeTeamId: 't4', awayTeamId: 't5', homeScore: 80, awayScore: 99 },
            { homeTeamId: 't3', awayTeamId: 't6', homeScore: 120, awayScore: 99 }
          ]
        }
      ],
      16
    );
    expect(round2.ok && round2.value.map((g) => [g.homeTeamId, g.awayTeamId])).toEqual([
      ['t1', 't5'],
      ['t2', 't3']
    ]);
  });

  const upsetWeek15 = {
    week: 15,
    results: [
      { homeTeamId: 't4', awayTeamId: 't5', homeScore: 80, awayScore: 99 },
      { homeTeamId: 't3', awayTeamId: 't6', homeScore: 120, awayScore: 99 },
      { homeTeamId: 't7', awayTeamId: 't8', homeScore: 50, awayScore: 60 }
    ]
  };

  it('reseeds after each round when the settings say so: the top seed meets the lowest left', () => {
    // 4 beats 5 and 6 upsets 3: a fixed bracket plays 1 v 4 and 2 v 6; reseeding plays 1 v 6.
    const week15 = {
      week: 15,
      results: [
        { homeTeamId: 't4', awayTeamId: 't5', homeScore: 99, awayScore: 80 },
        { homeTeamId: 't3', awayTeamId: 't6', homeScore: 90, awayScore: 99 }
      ]
    };
    const pairs = (r: ReturnType<typeof playoffMatchups>) =>
      r.ok ? r.value.map((g) => [g.homeTeamId, g.awayTeamId]) : r.issues;
    expect(pairs(playoffMatchups(settings, final, [week15], 16))).toEqual([
      ['t1', 't4'],
      ['t2', 't6']
    ]);
    const reseeded = { playoffs: { ...settings.playoffs, reseed: true } };
    expect(pairs(playoffMatchups(reseeded, final, [week15], 16))).toEqual([
      ['t1', 't6'],
      ['t2', 't4']
    ]);
    expect(pairs(playoffMatchups(reseeded, final, [], 16))).toEqual([]);
  });

  it('adds consolation games only when the settings call for them', () => {
    const plain = playoffMatchups(settings, final, [], 17);
    expect(plain.ok && plain.value).toEqual([]);
    const withConsolation = { playoffs: { ...settings.playoffs, consolation: true } };
    // The two teams that missed the playoffs meet in the final week.
    const week17 = playoffMatchups(withConsolation, final, [upsetWeek15], 17);
    expect(week17.ok && week17.value).toEqual([
      { gameId: 'consolation-r1-g1', bracket: 'consolation', homeTeamId: 't7', awayTeamId: 't8' }
    ]);
    const bracket = playoffBracket(withConsolation, final, []);
    expect(bracket.ok && bracket.value.consolationSeeds.map((s) => s.teamId)).toEqual(['t7', 't8']);
  });

  it('fails when the standings cannot fill the bracket or a week is missing', () => {
    expect(playoffMatchups(settings, final.slice(0, 3), [], 15).ok).toBe(false);
    expect(playoffMatchups(settings, final, [{ week: 15, results: [] }], 16).ok).toBe(false);
  });
});
