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
  kickoffTimes,
  nextKickoff,
  nextLeagueWeek,
  playoffMatchups,
  reconcileLineup,
  weekEndsAt,
  weekHighlights
} from './cycle.js';

describe('kickoffTimes and nextKickoff', () => {
  const week = [
    { kickoff: '2026-09-13T17:00:00.000Z', homeTeam: 'NYG', awayTeam: 'DAL' },
    { kickoff: '2026-09-13T17:00:00.000Z', homeTeam: 'CHI', awayTeam: 'DET' },
    { kickoff: '2026-09-11T00:15:00.000Z', homeTeam: 'KC', awayTeam: 'BAL' },
    { kickoff: '2026-09-13T20:25:00.000Z', homeTeam: 'SEA', awayTeam: 'LAR' }
  ];

  it('lists distinct kickoffs in order and finds the next one still ahead', () => {
    const kickoffs = kickoffTimes(week);
    expect(kickoffs).toEqual([
      '2026-09-11T00:15:00.000Z',
      '2026-09-13T17:00:00.000Z',
      '2026-09-13T20:25:00.000Z'
    ]);
    expect(nextKickoff(kickoffs, '2026-09-01T00:00:00.000Z')).toBe(kickoffs[0]);
    expect(nextKickoff(kickoffs, '2026-09-11T00:15:00.000Z')).toBe(kickoffs[1]);
    expect(nextKickoff(kickoffs, '2026-09-13T20:25:00.000Z')).toBeNull();
    expect(kickoffTimes([])).toEqual([]);
  });

  it('nextKickoff is the smallest kickoff after now', () => {
    const iso = (n: number) => new Date(Date.UTC(2026, 8, 10) + n * 60_000).toISOString();
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 10 }),
        fc.integer({ min: -1, max: 1001 }),
        (offsets, at) => {
          const after = offsets.filter((o) => o > at);
          expect(nextKickoff(offsets.map(iso), iso(at))).toBe(
            after.length === 0 ? null : iso(Math.min(...after))
          );
        }
      )
    );
  });
});

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
        { homeTeamId: 't4', awayTeamId: 't5' },
        { homeTeamId: 't3', awayTeamId: 't6' }
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
    expect(round2.ok && round2.value).toEqual([
      { homeTeamId: 't1', awayTeamId: 't5' },
      { homeTeamId: 't2', awayTeamId: 't3' }
    ]);
  });

  it('fails when the standings cannot fill the bracket or a week is missing', () => {
    expect(playoffMatchups(settings, final.slice(0, 3), [], 15).ok).toBe(false);
    expect(playoffMatchups(settings, final, [{ week: 15, results: [] }], 16).ok).toBe(false);
  });
});

describe('weekHighlights', () => {
  const game = (home: string, away: string, homeScore: number | null, awayScore: number | null) => ({
    homeTeamId: home,
    awayTeamId: away,
    homeScore,
    awayScore
  });

  it('finds the top score and the biggest blowout', () => {
    expect(
      weekHighlights([game('t1', 't2', 101.456, 99), game('t3', 't4', 70, 130.2), game('t5', 't6', 88, 88)])
    ).toEqual({
      topTeamId: 't4',
      topScore: 130.2,
      blowout: { winnerTeamId: 't4', loserTeamId: 't3', margin: 60.2 }
    });
  });

  it('breaks ties deterministically and ignores unscored games', () => {
    expect(weekHighlights([game('t2', 't1', 90, 90), game('t3', 't4', null, 95)])).toEqual({
      topTeamId: 't4',
      topScore: 95,
      blowout: null
    });
    expect(weekHighlights([game('t2', 't1', 90, 80), game('t3', 't4', 90, 80)])).toEqual({
      topTeamId: 't2',
      topScore: 90,
      blowout: { winnerTeamId: 't2', loserTeamId: 't1', margin: 10 }
    });
    expect(weekHighlights([])).toEqual({ topTeamId: null, topScore: null, blowout: null });
  });

  it('property: the top score is at least every scored side, and the blowout margin is the largest', () => {
    const score = fc.option(
      fc.integer({ min: 0, max: 20000 }).map((n) => n / 100),
      { nil: null }
    );
    fc.assert(
      fc.property(fc.array(fc.tuple(score, score), { maxLength: 8 }), (pairs) => {
        const games = pairs.map(([h, a], i) => game(`h${i}`, `a${i}`, h, a));
        const result = weekHighlights(games);
        const scores = pairs.flat().filter((s): s is number => s !== null);
        expect(result.topScore).toBe(scores.length === 0 ? null : Math.max(...scores));
        const margins = pairs
          .filter(([h, a]) => h !== null && a !== null && h !== a)
          .map(([h, a]) => Math.round(Math.abs((h as number) - (a as number)) * 100) / 100);
        expect(result.blowout?.margin ?? null).toBe(margins.length === 0 ? null : Math.max(...margins));
      })
    );
  });
});
