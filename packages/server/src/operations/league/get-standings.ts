import { computeStandings, formatRecord, type StandingsRow } from '@fantasy/core';
import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { leagueManagers, teamManager, TeamManagerSchema, type ManagerLookup } from '../../league/managers.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import type { Matchup, Team } from '../../repos/types.js';

const StandingsRowSchema = z.object({
  rank: z.number().int(),
  teamId: z.string(),
  teamName: z.string(),
  manager: TeamManagerSchema,
  record: z.string().describe('Wins-losses, or wins-losses-ties, e.g. "7-3".'),
  wins: z.number().int(),
  losses: z.number().int(),
  ties: z.number().int(),
  pointsFor: z.number(),
  pointsAgainst: z.number(),
  streak: z.string().nullable().describe('Current streak, e.g. "W3"; null before any game.'),
  tiebreakerOverNext: z
    .enum(['points_for', 'head_to_head', 'coin_flip'])
    .nullable()
    .describe('The tiebreaker that placed this team above the next one, when their records were equal.'),
  results: z
    .array(
      z.object({
        week: z.number().int(),
        opponentTeamId: z.string(),
        result: z.enum(['W', 'L', 'T']),
        pointsFor: z.number(),
        pointsAgainst: z.number()
      })
    )
    .optional()
    .describe('Each final regular-season game, oldest first. Present when `detail` is true.')
});

export const getStandings = defineOperation({
  name: 'get_standings',
  method: 'GET',
  path: '/leagues/{leagueId}/standings',
  summary: 'League standings: records, points, streaks',
  description: [
    'Returns the regular-season standings as of the last final week: rank, record, points for and against, streak, and the tiebreaker that separated teams with equal records. Playoff games never change standings.',
    'Before the season starts the list is empty and a SEASON_NOT_STARTED warning says when it fills in. Before the first week is final every team is 0-0. Only members can read it.',
    '`detail: true` adds each team’s game-by-game results (opponent, result, and score) through `throughWeek`.'
  ].join(' '),
  tags: ['leagues', 'season'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    detail: z.boolean().default(false).describe('Set true to add each team’s game-by-game results.')
  }),
  output: z.object({
    throughWeek: z
      .number()
      .int()
      .nullable()
      .describe('Last week included, or null when no week is final yet.'),
    standings: z.array(StandingsRowSchema)
  }),
  handler: async (ctx, input) => {
    const { league, teams } = await requireMember(ctx, input.leagueId);
    if (league.phase === 'setup' || league.phase === 'drafting') {
      return withWarnings({ throughWeek: null, standings: [] }, [
        {
          code: 'SEASON_NOT_STARTED',
          message: `Standings start after the draft, once week ${league.settings.schedule.startWeek} is played.`
        }
      ]);
    }
    const snapshot = await ctx.repos.schedule.latestStandings(league.id);
    const rows =
      snapshot?.rows ??
      computeStandings(league.settings, [], { teamIds: teams.map((t) => t.id), seed: league.scheduleSeed });
    const throughWeek = snapshot?.week ?? null;
    const managers = await leagueManagers(ctx, league.id, teams);
    const standings = rows.map((row) => standingsRow(row, teams, managers));
    if (!input.detail) return { throughWeek, standings };
    const games = (await ctx.repos.schedule.listMatchups(league.id)).filter(
      (m) => m.kind === 'regular' && m.status === 'final' && throughWeek !== null && m.week <= throughWeek
    );
    return {
      throughWeek,
      standings: standings.map((row) => ({ ...row, results: teamResults(row.teamId, games) }))
    };
  }
});

function teamResults(teamId: string, games: readonly Matchup[]) {
  return games
    .filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId)
    .sort((a, b) => a.week - b.week)
    .map((m) => {
      const home = m.homeTeamId === teamId;
      const pointsFor = (home ? m.homeScore : m.awayScore) ?? 0;
      const pointsAgainst = (home ? m.awayScore : m.homeScore) ?? 0;
      const result = pointsFor > pointsAgainst ? 'W' : pointsFor < pointsAgainst ? 'L' : 'T';
      return {
        week: m.week,
        opponentTeamId: home ? m.awayTeamId : m.homeTeamId,
        result: result as 'W' | 'L' | 'T',
        pointsFor,
        pointsAgainst
      };
    });
}

function standingsRow(
  row: StandingsRow,
  teams: readonly Team[],
  managers: ManagerLookup
): z.infer<typeof StandingsRowSchema> {
  return {
    rank: row.rank,
    teamId: row.teamId,
    teamName: teams.find((t) => t.id === row.teamId)?.name ?? row.teamId,
    manager: teamManager(managers, row.teamId),
    record: formatRecord(row),
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    pointsFor: row.pointsFor,
    pointsAgainst: row.pointsAgainst,
    streak: row.streak === null ? null : `${row.streak.result}${row.streak.length}`,
    tiebreakerOverNext: row.tiebreakerOverNext
  };
}
