import { computeStandings, playoffBracket, type BracketGame, type BracketSide } from '@fantasy/core';
import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import type { Matchup, Team } from '../../repos/types.js';
import { playoffMatchupId } from '../../season/playoffs.js';

const BracketSideSchema = z.object({
  teamId: z.string().nullable().describe('Null until known (a later round).'),
  teamName: z.string().nullable(),
  seed: z.number().int().nullable(),
  score: z
    .number()
    .nullable()
    .describe('Final score once the game is decided, live score while it is played, else null.'),
  from: z
    .string()
    .describe(
      'Where this side comes from, e.g. "Seed 3", "Winner of championship-r1-g2", "Reseeded after round 1".'
    )
});

const BracketGameSchema = z.object({
  id: z.string().describe('Bracket game id, e.g. "championship-r2-g1".'),
  bracket: z.enum(['championship', 'consolation']),
  round: z.number().int(),
  week: z.number().int(),
  home: BracketSideSchema.describe('The better seed once both teams are known.'),
  away: BracketSideSchema,
  winnerTeamId: z.string().nullable(),
  decidedBySeed: z.boolean().describe('True when the game was tied and the better seed advanced.')
});

export const getPlayoffBracket = defineOperation({
  name: 'get_playoff_bracket',
  method: 'GET',
  path: '/leagues/{leagueId}/playoffs',
  summary: 'The playoff bracket: seeds, byes, games, winners, and the champion',
  description: [
    'Returns the playoff bracket. Seeds come from the final regular-season standings (so their tiebreakers decide seeding), the top seeds get first-round byes, one round is played per week, and a tied playoff game goes to the better seed.',
    'With `playoffs.reseed` the teams left are re-paired each round (best seed against worst); otherwise the bracket is fixed. The consolation bracket for teams that miss the playoffs is included only when `playoffs.consolation` is on.',
    "During the regular season `status` is `projected`: the bracket if the season ended today, with a PLAYOFFS_PROJECTED warning. Before the draft it is `not_started` and empty. Only members can read it; use get_matchup for a playoff game's lineups."
  ].join(' '),
  tags: ['leagues', 'season'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema }),
  output: z.object({
    status: z
      .enum(['not_started', 'projected', 'in_progress', 'complete'])
      .describe('`complete` once the championship game is decided.'),
    teams: z.number().int().describe('Playoff teams.'),
    byes: z.number().int().describe('First-round byes (the top seeds).'),
    weeks: z.array(z.number().int()).describe('Playoff weeks, one round each.'),
    reseed: z.boolean(),
    consolation: z.boolean(),
    seeds: z.array(z.object({ seed: z.number().int(), teamId: z.string(), teamName: z.string() })),
    games: z.array(BracketGameSchema),
    championTeamId: z.string().nullable(),
    consolationChampionTeamId: z.string().nullable()
  }),
  handler: async (ctx, input) => {
    const { league, teams } = await requireMember(ctx, input.leagueId);
    const p = league.settings.playoffs;
    const empty = {
      teams: p.teams,
      byes: p.byes,
      weeks: Array.from({ length: p.endWeek - p.startWeek + 1 }, (_, i) => p.startWeek + i),
      reseed: p.reseed,
      consolation: p.consolation,
      seeds: [],
      games: [],
      championTeamId: null,
      consolationChampionTeamId: null
    };
    if (league.phase === 'setup' || league.phase === 'drafting') {
      return withWarnings({ status: 'not_started' as const, ...empty }, [
        {
          code: 'SEASON_NOT_STARTED',
          message: `The bracket is seeded from the standings after week ${league.settings.schedule.regularSeasonEndWeek}.`
        }
      ]);
    }
    const name = (id: string | null) => (id === null ? null : (teams.find((t) => t.id === id)?.name ?? id));
    if (league.phase === 'regular_season') {
      const snapshot = await ctx.repos.schedule.latestStandings(league.id);
      const rows =
        snapshot?.rows ??
        computeStandings(league.settings, [], { teamIds: teams.map((t) => t.id), seed: league.scheduleSeed });
      const projected = playoffBracket(league.settings, rows, []);
      const data = projected.ok
        ? { ...empty, ...bracketView(projected.value.seeds, projected.value.games, teams, []) }
        : empty;
      return withWarnings({ status: 'projected' as const, ...data }, [
        {
          code: 'PLAYOFFS_PROJECTED',
          message: `Projected from the standings${snapshot === null ? '' : ` through week ${snapshot.week}`}: the bracket if the regular season ended today. Seeds lock after week ${league.settings.schedule.regularSeasonEndWeek}.`
        }
      ]);
    }
    const [record, matchups] = await Promise.all([
      ctx.repos.history.getPlayoffs(league.id),
      ctx.repos.schedule.listMatchups(league.id)
    ]);
    if (record === null) return { status: 'in_progress' as const, ...empty };
    const view = bracketView(
      record.bracket.seeds,
      record.bracket.games,
      teams,
      matchups.filter((m) => m.kind === 'playoff')
    );
    return {
      status: record.championTeamId === null ? ('in_progress' as const) : ('complete' as const),
      ...empty,
      ...view,
      championTeamId: record.championTeamId,
      consolationChampionTeamId: record.consolationChampionTeamId
    };

    function bracketView(
      seeds: readonly { seed: number; teamId: string }[],
      games: readonly BracketGame[],
      allTeams: readonly Team[],
      played: readonly Matchup[]
    ) {
      const live = new Map(played.map((m) => [m.id, m]));
      const side = (s: BracketSide, g: BracketGame) => {
        const m = live.get(playoffMatchupId(g.week, g.id));
        const liveScore = m?.homeTeamId === s.teamId ? m?.homeScore : m?.awayScore;
        return {
          teamId: s.teamId,
          teamName: name(s.teamId),
          seed: s.seed,
          score: s.score ?? (s.teamId === null ? null : (liveScore ?? null)),
          from:
            s.source.type === 'seed'
              ? `Seed ${s.source.seed}`
              : s.source.type === 'winner'
                ? `Winner of ${s.source.gameId}`
                : `Reseeded after round ${s.source.round - 1}`
        };
      };
      return {
        seeds: seeds.map((s) => ({
          seed: s.seed,
          teamId: s.teamId,
          teamName: allTeams.find((t) => t.id === s.teamId)?.name ?? s.teamId
        })),
        games: games.map((g) => ({
          id: g.id,
          bracket: g.bracket,
          round: g.round,
          week: g.week,
          home: side(g.home, g),
          away: side(g.away, g),
          winnerTeamId: g.winnerTeamId,
          decidedBySeed: g.decidedBySeed
        }))
      };
    }
  }
});
