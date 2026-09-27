import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings } from '../rules/settings.js';
import {
  computeStandings,
  formatRecord,
  matchupResult,
  standingsTiebreakers,
  type FinalizedMatchup
} from './standings.js';

const settings = yahooDefaultSettings(4);
const g = (week: number, home: string, away: string, hs: number, as: number): FinalizedMatchup => ({
  week,
  homeTeamId: home,
  awayTeamId: away,
  homeScore: hs,
  awayScore: as
});

describe('matchupResult', () => {
  it('scores wins, losses, and ties to the cent', () => {
    expect(matchupResult(100, 90)).toEqual({ home: 'W', away: 'L', winner: 'home' });
    expect(matchupResult(90, 100)).toEqual({ home: 'L', away: 'W', winner: 'away' });
    expect(matchupResult(0.1 + 0.2, 0.3)).toEqual({ home: 'T', away: 'T', winner: null });
    expect(matchupResult(100.01, 100)).toMatchObject({ winner: 'home' });
  });
});

describe('computeStandings', () => {
  it('computes records, points, streaks, and win percentage', () => {
    const rows = computeStandings(
      settings,
      [
        g(1, 'a', 'b', 100, 90),
        g(1, 'c', 'd', 80, 80),
        g(2, 'a', 'c', 110, 70),
        g(2, 'b', 'd', 95, 100),
        g(3, 'd', 'a', 120, 100),
        g(3, 'b', 'c', 60, 50)
      ],
      { teamIds: ['a', 'b', 'c', 'd', 'e'] }
    );
    expect(rows.map((r) => r.teamId)).toEqual(['d', 'a', 'b', 'c', 'e']);
    const d = rows[0]!;
    expect(d).toMatchObject({
      wins: 2,
      losses: 0,
      ties: 1,
      gamesPlayed: 3,
      pointsFor: 300,
      pointsAgainst: 275
    });
    expect(d.winPct).toBeCloseTo(5 / 6);
    expect(d.streak).toEqual({ result: 'W', length: 2 });
    expect(rows[1]!.streak).toEqual({ result: 'L', length: 1 });
    expect(formatRecord(d)).toBe('2-0-1');
    expect(formatRecord(rows[1]!)).toBe('2-1');
    const e = rows[4]!;
    expect(e).toMatchObject({ rank: 5, gamesPlayed: 0, winPct: 0, streak: null, tiebreakerOverNext: null });
    expect(rows[1]!.tiebreakerOverNext).toBeNull();
    expect(rows[0]!.tiebreakerOverNext).toBeNull();
  });

  it('ignores games outside the regular season', () => {
    const s = yahooDefaultSettings(4, { startWeek: 3 });
    const rows = computeStandings(s, [g(2, 'a', 'b', 100, 0), g(3, 'b', 'a', 100, 0), g(16, 'a', 'b', 1, 0)]);
    expect(rows[0]!.teamId).toBe('b');
    expect(rows[0]!.wins).toBe(1);
  });

  it('uses head-to-head after points for, then a seeded coin flip', () => {
    // a and b: same record, same points; a beat b.
    const games = [g(1, 'a', 'b', 100, 90), g(2, 'b', 'c', 100, 0), g(2, 'a', 'd', 90, 0)];
    let rows = computeStandings(settings, [...games, g(3, 'c', 'a', 0, 0), g(3, 'b', 'd', 0, 0)]);
    // a: W, W, T -> PF 190; b: L, W, T -> PF 190. Records differ, so no tiebreak.
    expect(rows[0]!.teamId).toBe('a');

    rows = computeStandings(settings, [
      g(1, 'a', 'b', 100, 90),
      g(2, 'b', 'c', 100, 90),
      g(2, 'd', 'a', 100, 90)
    ]);
    // a and b are both 1-1 with 190 PF; a won the head-to-head game.
    const ab = rows.filter((r) => r.teamId === 'a' || r.teamId === 'b');
    expect(ab.map((r) => r.teamId)).toEqual(['a', 'b']);
    expect(ab[0]!.tiebreakerOverNext).toBe('head_to_head');
  });

  it('puts head-to-head first when the settings say so', () => {
    const h2h = yahooDefaultSettings(4);
    h2h.playoffs.tiebreaker = 'head_to_head';
    expect(standingsTiebreakers(h2h)).toEqual(['head_to_head', 'points_for', 'coin_flip']);
    expect(standingsTiebreakers(settings)).toEqual(['points_for', 'head_to_head', 'coin_flip']);
    // a beat b, but b has more points; both 1-1.
    const games = [g(1, 'a', 'b', 100, 90), g(2, 'b', 'c', 200, 0), g(2, 'd', 'a', 100, 90)];
    expect(computeStandings(h2h, games)[1]!.teamId).toBe('a');
    const byPf = computeStandings(settings, games);
    expect(byPf[1]!.teamId).toBe('b');
    expect(byPf[1]!.tiebreakerOverNext).toBe('points_for');
  });

  it('breaks full ties with a deterministic coin flip that depends on the seed', () => {
    const games = [g(1, 'a', 'b', 50, 50), g(1, 'c', 'd', 50, 50)];
    const one = computeStandings(settings, games, { seed: 's1' }).map((r) => r.teamId);
    expect(computeStandings(settings, games, { seed: 's1' }).map((r) => r.teamId)).toEqual(one);
    const orders = new Set(
      Array.from({ length: 20 }, (_, i) =>
        computeStandings(settings, games, { seed: i })
          .map((r) => r.teamId)
          .join()
      )
    );
    expect(orders.size).toBeGreaterThan(1);
    const rows = computeStandings(settings, games);
    expect(rows.slice(0, 3).every((r) => r.tiebreakerOverNext === 'coin_flip')).toBe(true);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('recomputes head-to-head among the teams still tied (three-way tie)', () => {
    // a, b, c all 2-1 on the same points; a beat b, b beat c, c beat a: head-to-head is even, coin flip decides.
    const games = [
      g(1, 'a', 'b', 100, 90),
      g(2, 'b', 'c', 100, 90),
      g(3, 'c', 'a', 100, 90),
      g(4, 'a', 'd', 90, 0),
      g(4, 'b', 'e', 90, 0),
      g(4, 'c', 'f', 90, 0)
    ];
    const rows = computeStandings(settings, games);
    const top = rows.slice(0, 3);
    expect(top.map((r) => r.teamId).sort()).toEqual(['a', 'b', 'c']);
    expect(top.slice(0, 2).every((r) => r.tiebreakerOverNext === 'coin_flip')).toBe(true);
    expect(top[2]!.tiebreakerOverNext).toBeNull();
  });
});
