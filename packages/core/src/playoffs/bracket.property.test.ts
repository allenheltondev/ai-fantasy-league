import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { playoffRounds, requiredByes, yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import {
  advanceBracket,
  buildBracket,
  champion,
  consolationChampion,
  seedPlayoffs,
  type Bracket,
  type BracketGame
} from './bracket.js';

interface Scenario {
  settings: Pick<LeagueSettings, 'playoffs'>;
  teamCount: number;
  consolation: boolean;
  /** Score per team per week; small values so ties happen often. */
  scores: number[][];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    teamCount: fc.integer({ min: 4, max: 12 }),
    playoffTeams: fc.integer({ min: 2, max: 8 }),
    reseed: fc.boolean(),
    consolation: fc.boolean(),
    scores: fc.array(fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 12, maxLength: 12 }), {
      minLength: 4,
      maxLength: 4
    })
  })
  .map(({ teamCount, playoffTeams, reseed, consolation, scores }) => {
    const teams = Math.min(playoffTeams, teamCount);
    const rounds = playoffRounds({ teams });
    const base = yahooDefaultSettings(teamCount);
    const settings = {
      playoffs: {
        ...base.playoffs,
        teams,
        byes: requiredByes(teams),
        startWeek: 18 - rounds + 1,
        endWeek: 18,
        reseed,
        consolation
      }
    };
    return { settings, teamCount, consolation: consolation && teamCount - teams >= 2, scores };
  });

/** Plays every week of the bracket with the scenario's scores. */
function play(s: Scenario): { bracket: Bracket; weeks: BracketGame[][] } {
  const standings = Array.from({ length: s.teamCount }, (_, i) => ({ teamId: `t${i + 1}`, rank: i + 1 }));
  const seeding = seedPlayoffs(s.settings, standings);
  if (!seeding.ok) throw new Error('seeding failed');
  const built = buildBracket(s.settings, seeding.value.seeds, {
    consolation: s.consolation,
    nonPlayoff: seeding.value.nonPlayoff
  });
  if (!built.ok) throw new Error(JSON.stringify(built.issues));
  let bracket = built.value;
  const weeks: BracketGame[][] = [];
  for (const [i, week] of bracket.weeks.entries()) {
    const score = (teamId: string) => (s.scores[i] as number[])[Number(teamId.slice(1)) - 1] as number;
    const games = bracket.games.filter((g) => g.week === week);
    const results = games.map((g) => ({
      homeTeamId: g.home.teamId as string,
      awayTeamId: g.away.teamId as string,
      homeScore: score(g.home.teamId as string),
      awayScore: score(g.away.teamId as string)
    }));
    const next = advanceBracket(bracket, { week, results });
    if (!next.ok) throw new Error(JSON.stringify(next.issues));
    bracket = next.value;
    weeks.push(bracket.games.filter((g) => g.week === week));
  }
  return { bracket, weeks };
}

const loser = (g: BracketGame) => (g.winnerTeamId === g.home.teamId ? g.away : g.home);
const winner = (g: BracketGame) => (g.winnerTeamId === g.home.teamId ? g.home : g.away);

describe('playoff bracket properties', () => {
  it('always plays to one champion, one game per team per week, one loss per eliminated team', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { bracket, weeks } = play(s);
        const championship = bracket.games.filter((g) => g.bracket === 'championship');
        expect(championship).toHaveLength(s.settings.playoffs.teams - 1);
        for (const games of weeks) {
          const teams = games.flatMap((g) => [g.home.teamId, g.away.teamId]);
          expect(new Set(teams).size).toBe(teams.length);
        }
        const champ = champion(bracket);
        expect(bracket.seeds.map((x) => x.teamId)).toContain(champ);
        const losses = championship.map((g) => loser(g).teamId);
        expect(new Set(losses).size).toBe(losses.length);
        expect(losses).not.toContain(champ);
        expect(losses.length + 1).toBe(bracket.seeds.length);
        if (s.consolation) {
          expect(bracket.consolationSeeds.map((x) => x.teamId)).toContain(consolationChampion(bracket));
        } else {
          expect(consolationChampion(bracket)).toBeNull();
        }
      })
    );
  });

  it('advances the higher score, and the better seed on a tie, with the better seed at home', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        for (const g of play(s).bracket.games) {
          const w = winner(g);
          const l = loser(g);
          expect(w.score as number).toBeGreaterThanOrEqual(l.score as number);
          expect(g.decidedBySeed).toBe(w.score === l.score);
          if (g.decidedBySeed) expect(w.seed as number).toBeLessThan(l.seed as number);
          expect(g.home.seed as number).toBeLessThan(g.away.seed as number);
        }
      })
    );
  });

  it('reseeding pairs the best seed left with the worst each round; a fixed bracket never changes', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { bracket } = play(s);
        const rounds = Math.max(...bracket.games.map((g) => g.round));
        for (let round = 2; round <= rounds; round++) {
          const games = bracket.games.filter((g) => g.bracket === 'championship' && g.round === round);
          const seeds = games.flatMap((g) => [g.home.seed as number, g.away.seed as number]);
          const top = games.find((g) => g.home.seed === Math.min(...seeds)) as BracketGame;
          if (bracket.reseed) {
            expect(top.away.seed).toBe(Math.max(...seeds));
            expect(top.home.source).toEqual({ type: 'reseed', round });
          } else {
            expect(games.every((g) => g.away.source.type !== 'reseed')).toBe(true);
          }
        }
      })
    );
  });
});
