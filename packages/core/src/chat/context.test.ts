import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { headToHead, type PlayedGame } from '../history/records.js';
import { fitLines, formatSeries, powerRankings, seriesBetween } from './context.js';

const game = (
  week: number,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number
): PlayedGame => ({
  week,
  kind: 'regular',
  homeTeamId: home,
  awayTeamId: away,
  homeScore,
  awayScore
});

const TEAMS = ['t1', 't2', 't3', 't4'];
const gameArb = fc
  .record({
    week: fc.integer({ min: 1, max: 14 }),
    pair: fc.shuffledSubarray(TEAMS, { minLength: 2, maxLength: 2 }),
    homeScore: fc.integer({ min: 40, max: 180 }),
    awayScore: fc.integer({ min: 40, max: 180 })
  })
  .map(({ week, pair, homeScore, awayScore }) =>
    game(week, pair[0] as string, pair[1] as string, homeScore, awayScore)
  );

describe('chat context helpers', () => {
  it('ranks by record, scoring, and form; ties go to the team id', () => {
    const games = [
      game(1, 't1', 't2', 120, 100),
      game(1, 't3', 't4', 90, 80),
      game(2, 't1', 't3', 130, 70),
      game(2, 't2', 't4', 110, 100)
    ];
    expect(powerRankings(games, TEAMS).map((r) => r.teamId)).toEqual(['t1', 't2', 't3', 't4']);
    expect(powerRankings([], ['b', 'a']).map((r) => [r.rank, r.teamId, r.score])).toEqual([
      [1, 'a', 0],
      [2, 'b', 0]
    ]);
    // Playoff games do not count.
    expect(
      powerRankings([{ ...game(15, 't4', 't1', 200, 1), kind: 'playoff' }], ['t1', 't4'])[0]?.score
    ).toBe(0);
  });

  it('power rankings are a permutation of the teams and ignore input order (property)', () => {
    fc.assert(
      fc.property(fc.array(gameArb, { maxLength: 30 }), (games) => {
        const ranked = powerRankings(games, TEAMS);
        expect([...ranked.map((r) => r.teamId)].sort()).toEqual(TEAMS);
        expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
        expect(powerRankings([...games].reverse(), [...TEAMS].reverse())).toEqual(ranked);
        for (let i = 1; i < ranked.length; i++)
          expect((ranked[i - 1] as { score: number }).score).toBeGreaterThanOrEqual(
            (ranked[i] as { score: number }).score
          );
      })
    );
  });

  it('reads a series from either side (property: the two sides mirror)', () => {
    fc.assert(
      fc.property(fc.array(gameArb, { maxLength: 30 }), (games) => {
        const records = headToHead(games);
        for (const a of TEAMS)
          for (const b of TEAMS) {
            if (a === b) continue;
            const ab = seriesBetween(records, a, b);
            const ba = seriesBetween(records, b, a);
            if (ab === null) expect(ba).toBeNull();
            else expect(ba).toEqual({ wins: ab.losses, losses: ab.wins, ties: ab.ties });
          }
      })
    );
    expect(formatSeries({ wins: 2, losses: 1, ties: 0 })).toBe('2-1');
    expect(formatSeries({ wins: 2, losses: 1, ties: 1 })).toBe('2-1-1');
  });

  it('fits whole lines within a character budget (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 80 }), { maxLength: 40 }), fc.nat(2000), (lines, max) => {
        const kept = fitLines(lines, max);
        expect(kept.join('\n').length).toBeLessThanOrEqual(max);
        expect(kept).toEqual(lines.slice(0, kept.length));
      })
    );
    expect(fitLines(['aaaa', 'bb', 'c'], 7)).toEqual(['aaaa', 'bb']);
  });
});
