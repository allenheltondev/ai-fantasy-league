import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generateSchedule } from '../schedule/schedule.js';
import {
  DRAFT_GRADES,
  expectedWins,
  gamesPerTeam,
  gradeForScore,
  lineupStdDev,
  projectRecords,
  rankRecords,
  zScores,
  type ProjectedRecord,
  type ReportMatchup,
  type WeekScore
} from './report-card.js';

const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

function season(teamIds: readonly string[], weeks: number, seed = 1): ReportMatchup[] {
  const result = generateSchedule(teamIds, { startWeek: 1, regularSeasonEndWeek: weeks, seed });
  if (!result.ok) throw new Error('bad schedule');
  return result.value.flatMap((w) => w.matchups);
}

/** Independent check: some assignment of winners gives these records iff every group of teams has at least as many wins as the games played among its members. */
function achievable(records: readonly ProjectedRecord[], schedule: readonly ReportMatchup[]): boolean {
  const ids = records.map((r) => r.teamId);
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const group = new Set(ids.filter((_, i) => mask & (1 << i)));
    const inside = schedule.filter((m) => group.has(m.homeTeamId) && group.has(m.awayTeamId)).length;
    const wins = records.filter((r) => group.has(r.teamId)).reduce((a, r) => a + r.wins, 0);
    if (wins < inside) return false;
  }
  return true;
}

function expectBalanced(records: readonly ProjectedRecord[], schedule: readonly ReportMatchup[]) {
  const games = gamesPerTeam(
    records.map((r) => r.teamId),
    schedule
  );
  expect(records.reduce((a, r) => a + r.wins, 0)).toBe(schedule.length);
  expect(records.reduce((a, r) => a + r.losses, 0)).toBe(schedule.length);
  for (const r of records) {
    expect(r.wins).toBeGreaterThanOrEqual(0);
    expect(r.losses).toBeGreaterThanOrEqual(0);
    expect(r.wins + r.losses).toBe(games.get(r.teamId));
  }
  expect(achievable(records, schedule)).toBe(true);
}

describe('projectRecords', () => {
  it('rounds expected wins into records that sum to the league schedule', () => {
    const ids = teams(4);
    const schedule = season(ids, 6);
    const targets = new Map([
      ['t1', 4.6],
      ['t2', 3.4],
      ['t3', 2.5],
      ['t4', 1.5]
    ]);
    const records = projectRecords(ids, schedule, targets);
    expect(records).toEqual([
      { teamId: 't1', wins: 5, losses: 1 },
      { teamId: 't2', wins: 3, losses: 3 },
      { teamId: 't3', wins: 3, losses: 3 },
      { teamId: 't4', wins: 1, losses: 5 }
    ]);
    expectBalanced(records, schedule);
  });

  it('rescales a guess whose wins do not add up, and clamps impossible ones', () => {
    const ids = teams(4);
    const schedule = season(ids, 6);
    // 30 wins guessed for 12 games; a negative and an over-the-cap guess.
    const records = projectRecords(
      ids,
      schedule,
      new Map([
        ['t1', 20],
        ['t2', 8],
        ['t3', 4],
        ['t4', -2]
      ])
    );
    // Clamped to 6, 6, 4, 0 (16 wins), then scaled down to the 12 games.
    const wins = records.map((r) => r.wins);
    expect(wins[3]).toBe(0);
    expect(wins[0]! + wins[1]!).toBe(9);
    expect(wins[2]).toBe(3);
    expectBalanced(records, schedule);
  });

  it('moves wins until the records are achievable on the schedule', () => {
    // Two teams that only play each other cannot both go undefeated.
    const ids = teams(4);
    const schedule: ReportMatchup[] = [
      { week: 1, homeTeamId: 't1', awayTeamId: 't2' },
      { week: 2, homeTeamId: 't1', awayTeamId: 't2' },
      { week: 1, homeTeamId: 't3', awayTeamId: 't4' },
      { week: 2, homeTeamId: 't3', awayTeamId: 't4' }
    ];
    const records = projectRecords(
      ids,
      schedule,
      new Map([
        ['t1', 2],
        ['t2', 2],
        ['t3', 0],
        ['t4', 0]
      ])
    );
    expectBalanced(records, schedule);
    // t1 and t2 share the two games between them; so do t3 and t4.
    const wins = records.map((r) => r.wins);
    expect(wins[0]! + wins[1]!).toBe(2);
    expect(wins[2]! + wins[3]!).toBe(2);
  });

  it('splits evenly when there is no guess at all', () => {
    const ids = teams(4);
    const schedule = season(ids, 3);
    const records = projectRecords(ids, schedule, new Map());
    expectBalanced(records, schedule);
  });

  it('always adds up, for any league size, season length, and guess', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }).map((h) => h * 2),
        fc.integer({ min: 1, max: 14 }),
        fc.integer(),
        fc.array(fc.oneof(fc.double({ min: -5, max: 20, noNaN: true }), fc.constant(Number.NaN)), {
          minLength: 10,
          maxLength: 10
        }),
        (n, weeks, seed, guesses) => {
          const ids = teams(n);
          const schedule = season(ids, weeks, seed);
          const records = projectRecords(ids, schedule, new Map(ids.map((id, i) => [id, guesses[i]!])));
          expectBalanced(records, schedule);
        }
      ),
      { numRuns: 150 }
    );
  });
});

describe('expectedWins', () => {
  it('sums win probabilities, so the league total equals the number of matchups', () => {
    const ids = teams(4);
    const schedule = season(ids, 6);
    const strong: WeekScore = { projected: 130, stdDev: 20 };
    const weak: WeekScore = { projected: 90, stdDev: 20 };
    const byWeek = (s: WeekScore) => new Map([1, 2, 3, 4, 5, 6].map((w) => [w, s]));
    const scores = new Map([
      ['t1', byWeek(strong)],
      ['t2', byWeek(weak)],
      ['t3', byWeek(weak)],
      ['t4', byWeek(weak)]
    ]);
    const wins = expectedWins(ids, schedule, scores);
    const total = [...wins.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(schedule.length, 6);
    expect(wins.get('t1')!).toBeGreaterThan(5);
    // Missing teams score nothing and lose.
    expect(
      expectedWins(['t1', 't9'], [{ week: 1, homeTeamId: 't9', awayTeamId: 't1' }], scores).get('t9')
    ).toBe(0);
  });
});

describe('rankRecords', () => {
  it('ranks by wins, then by the preferred order, with no gaps', () => {
    const records: ProjectedRecord[] = [
      { teamId: 'a', wins: 5, losses: 9 },
      { teamId: 'b', wins: 9, losses: 5 },
      { teamId: 'c', wins: 9, losses: 5 },
      { teamId: 'd', wins: 5, losses: 9 }
    ];
    // The preference puts d first, but it cannot outrank teams with more wins.
    const ranks = rankRecords(records, ['d', 'c']);
    expect([...ranks.entries()]).toEqual([
      ['c', 1],
      ['b', 2],
      ['d', 3],
      ['a', 4]
    ]);
  });
});

describe('grades', () => {
  it('maps z-scores onto A+ through F-', () => {
    expect(gradeForScore(2)).toBe('A+');
    expect(gradeForScore(0)).toBe('C+');
    expect(gradeForScore(-0.2)).toBe('C');
    expect(gradeForScore(-3)).toBe('F-');
    expect(DRAFT_GRADES).toHaveLength(15);
    for (let z = -3; z <= 3; z += 0.05) expect(DRAFT_GRADES).toContain(gradeForScore(z));
  });

  it('computes z-scores, and zeros when nothing varies', () => {
    const z = zScores(
      new Map([
        ['a', 1],
        ['b', 3]
      ])
    );
    expect(z.get('a')).toBe(-1);
    expect(z.get('b')).toBe(1);
    expect(
      zScores(
        new Map([
          ['a', 2],
          ['b', 2]
        ])
      ).get('a')
    ).toBe(0);
  });

  it('models lineup variance from starter projections', () => {
    expect(lineupStdDev([])).toBe(0);
    expect(lineupStdDev([0, -1])).toBe(0);
    // One starter at 20: sd 9. Two: sqrt(81 + 81).
    expect(lineupStdDev([20])).toBeCloseTo(9);
    expect(lineupStdDev([20, 20])).toBeCloseTo(Math.sqrt(162));
    // The floor applies to tiny projections.
    expect(lineupStdDev([1])).toBe(2);
  });
});
