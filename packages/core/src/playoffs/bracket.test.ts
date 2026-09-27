import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import {
  advanceBracket,
  buildBracket,
  champion,
  consolationChampion,
  seedPlayoffs,
  type Bracket,
  type BracketGameResult,
  type PlayoffSeed
} from './bracket.js';

const standings = (n: number) => Array.from({ length: n }, (_, i) => ({ teamId: `t${i + 1}`, rank: i + 1 }));

function setup(teamCount: number, playoffs?: Partial<LeagueSettings['playoffs']>) {
  const s = yahooDefaultSettings(teamCount);
  Object.assign(s.playoffs, playoffs);
  const seeding = seedPlayoffs(s, standings(teamCount));
  if (!seeding.ok) throw new Error('seeding failed');
  return { s, seeding: seeding.value };
}

function build(
  teamCount: number,
  playoffs?: Partial<LeagueSettings['playoffs']>,
  consolation = false
): Bracket {
  const { s, seeding } = setup(teamCount, playoffs);
  const r = buildBracket(s, seeding.seeds, { consolation, nonPlayoff: seeding.nonPlayoff });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

/** Results where the better seed (home) wins every game this week, unless listed in `upsets`. */
function weekResults(bracket: Bracket, week: number, upsets: string[] = [], ties: string[] = []) {
  const results: BracketGameResult[] = bracket.games
    .filter((g) => g.week === week && g.home.teamId && g.away.teamId)
    .map((g) => {
      const tie = ties.includes(g.id);
      const upset = upsets.includes(g.id);
      // Report some results with home/away flipped to check matching by team pair.
      return upset
        ? { homeTeamId: g.away.teamId!, awayTeamId: g.home.teamId!, homeScore: 120, awayScore: 100 }
        : {
            homeTeamId: g.home.teamId!,
            awayTeamId: g.away.teamId!,
            homeScore: tie ? 99 : 120,
            awayScore: tie ? 99 : 100
          };
    });
  return { week, results: [...results, { homeTeamId: 'x', awayTeamId: 'y', homeScore: 1, awayScore: 0 }] };
}

function advance(bracket: Bracket, week: number, upsets: string[] = [], ties: string[] = []): Bracket {
  const r = advanceBracket(bracket, weekResults(bracket, week, upsets, ties));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe('seedPlayoffs', () => {
  it('takes the top teams by rank', () => {
    const s = yahooDefaultSettings(8);
    const r = seedPlayoffs(s, [...standings(8)].reverse());
    expect(r.ok && r.value.seeds.map((x) => x.teamId)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    expect(r.ok && r.value.nonPlayoff).toEqual([
      { seed: 7, teamId: 't7' },
      { seed: 8, teamId: 't8' }
    ]);
  });

  it('fails without enough teams', () => {
    const r = seedPlayoffs(yahooDefaultSettings(8), standings(5));
    expect(!r.ok && r.issues[0]!.code).toBe('NOT_ENOUGH_TEAMS_FOR_PLAYOFFS');
  });
});

describe('buildBracket', () => {
  it('builds the default 6-team bracket with byes for the top 2 in weeks 15-17', () => {
    const b = build(8);
    expect(b.weeks).toEqual([15, 16, 17]);
    const r1 = b.games.filter((g) => g.round === 1);
    expect(r1.map((g) => [g.home.seed, g.away.seed])).toEqual([
      [4, 5],
      [3, 6]
    ]);
    expect(r1.every((g) => g.week === 15)).toBe(true);
    const r2 = b.games.filter((g) => g.round === 2);
    expect(r2.map((g) => [g.home.seed, g.away.source])).toEqual([
      [1, { type: 'winner', gameId: 'championship-r1-g1' }],
      [2, { type: 'winner', gameId: 'championship-r1-g2' }]
    ]);
    expect(b.finalGameId).toBe('championship-r3-g1');
  });

  it('plays a 6-team bracket to a champion with chalk results', () => {
    let b = build(8);
    expect(champion(b)).toBeNull();
    b = advance(b, 15);
    b = advance(b, 16);
    b = advance(b, 17);
    expect(champion(b)).toBe('t1');
    const final = b.games.find((g) => g.id === b.finalGameId)!;
    expect([final.home.teamId, final.away.teamId]).toEqual(['t1', 't2']);
    expect(final.home.score).toBe(120);
  });

  it('moves upset winners on and keeps the better seed at home', () => {
    let b = build(8);
    b = advance(b, 15, ['championship-r1-g1']); // 5 beats 4
    const semi = b.games.find((g) => g.id === 'championship-r2-g1')!;
    expect([semi.home.teamId, semi.away.teamId]).toEqual(['t1', 't5']);
    b = advance(b, 16, ['championship-r2-g1']); // 5 beats 1
    const final = b.games.find((g) => g.id === b.finalGameId)!;
    expect([final.home.seed, final.away.seed]).toEqual([2, 5]);
    b = advance(b, 17, [b.finalGameId]);
    expect(champion(b)).toBe('t5');
  });

  it('advances the better seed on a tie', () => {
    let b = build(8);
    b = advance(b, 15, [], ['championship-r1-g2']);
    const g = b.games.find((x) => x.id === 'championship-r1-g2')!;
    expect(g.winnerTeamId).toBe('t3');
    expect(g.decidedBySeed).toBe(true);
  });

  it('builds a 4-team bracket in weeks 16-17 without byes', () => {
    let b = build(6);
    expect(b.weeks).toEqual([16, 17]);
    expect(b.games.filter((g) => g.round === 1).map((g) => [g.home.seed, g.away.seed])).toEqual([
      [1, 4],
      [2, 3]
    ]);
    b = advance(b, 16, ['championship-r1-g2']);
    b = advance(b, 17);
    expect(champion(b)).toBe('t1');
  });

  it('builds an 8-team bracket over 3 weeks', () => {
    let b = build(10, { teams: 8, byes: 0, startWeek: 15, endWeek: 17 });
    expect(b.games).toHaveLength(7);
    expect(b.games.filter((g) => g.round === 1).map((g) => [g.home.seed, g.away.seed])).toEqual([
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6]
    ]);
    for (const w of [15, 16, 17]) b = advance(b, w, [], []);
    expect(champion(b)).toBe('t1');
  });

  it('adds an optional consolation bracket for non-playoff teams', () => {
    let b = build(12, undefined, true);
    const cons = b.games.filter((g) => g.bracket === 'consolation');
    // 6 non-playoff teams (seeds 7-12): 2 byes, 3 rounds ending week 17.
    expect(cons).toHaveLength(5);
    expect(cons.filter((g) => g.round === 1).map((g) => [g.home.seed, g.away.seed])).toEqual([
      [10, 11],
      [9, 12]
    ]);
    expect(consolationChampion(b)).toBeNull();
    for (const w of [15, 16, 17]) b = advance(b, w);
    expect(consolationChampion(b)).toBe('t7');
    expect(champion(b)).toBe('t1');

    const small = build(8, undefined, true);
    const c2 = small.games.filter((g) => g.bracket === 'consolation');
    expect(c2.map((g) => [g.week, g.home.seed, g.away.seed])).toEqual([[17, 7, 8]]);
    expect(consolationChampion(build(8))).toBeNull();
  });

  it('rejects invalid configurations', () => {
    const { s, seeding } = setup(8);
    const codes = (
      settings: LeagueSettings,
      seeds: readonly PlayoffSeed[],
      consolation = false
    ): string[] => {
      const r = buildBracket(settings, seeds, { consolation, nonPlayoff: consolation ? [] : undefined });
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    expect(codes(s, seeding.seeds.slice(0, 5))).toEqual(['PLAYOFF_SEED_COUNT_MISMATCH']);
    expect(codes({ ...s, playoffs: { ...s.playoffs, byes: 0 } }, seeding.seeds)).toEqual([
      'PLAYOFF_BYES_INVALID'
    ]);
    expect(codes({ ...s, playoffs: { ...s.playoffs, endWeek: 16 } }, seeding.seeds)).toEqual([
      'PLAYOFF_WEEKS_MISMATCH'
    ]);
    const dup = [...seeding.seeds.slice(0, 5), { seed: 6, teamId: 't1' }];
    expect(codes(s, dup)).toEqual(['PLAYOFF_DUPLICATE_SEED']);
    expect(codes(s, seeding.seeds, true)).toEqual(['CONSOLATION_TOO_FEW_TEAMS']);
    expect(
      codes({ ...s, playoffs: { ...s.playoffs, teams: 1, byes: 0, endWeek: 15 } }, seeding.seeds.slice(0, 1))
    ).toEqual(['PLAYOFF_TOO_FEW_TEAMS', 'PLAYOFF_WEEKS_MISMATCH']);
  });
});

describe('advanceBracket errors', () => {
  it('rejects weeks without games, unready rounds, missing results, and replays', () => {
    const b = build(8);
    const code = (r: ReturnType<typeof advanceBracket>) => (r.ok ? [] : r.issues.map((i) => i.code));
    expect(code(advanceBracket(b, { week: 3, results: [] }))).toEqual(['NO_PLAYOFF_GAMES_THIS_WEEK']);
    expect(code(advanceBracket(b, { week: 16, results: [] }))).toEqual([
      'PLAYOFF_ROUND_NOT_READY',
      'PLAYOFF_ROUND_NOT_READY'
    ]);
    const partial = weekResults(b, 15);
    expect(code(advanceBracket(b, { week: 15, results: partial.results.slice(1) }))).toEqual([
      'PLAYOFF_RESULT_MISSING'
    ]);
    const done = advance(b, 15);
    expect(code(advanceBracket(done, weekResults(done, 15)))).toEqual([
      'PLAYOFF_GAME_ALREADY_DECIDED',
      'PLAYOFF_GAME_ALREADY_DECIDED'
    ]);
    // The input bracket is never mutated.
    expect(b.games.every((g) => g.winnerTeamId === null)).toBe(true);
  });
});
