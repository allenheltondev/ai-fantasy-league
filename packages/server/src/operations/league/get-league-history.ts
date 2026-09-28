import {
  ACHIEVEMENT_IDS,
  ACHIEVEMENTS,
  headToHead,
  seasonRecords,
  type HeadToHeadRecord,
  type SeasonRecords
} from '@fantasy/core';
import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema } from '../../league/views.js';
import { PlayerRefSchema } from '../../players/model.js';
import { defineOperation } from '../../registry/operation.js';
import type { Team } from '../../repos/types.js';
import { leagueTransactions, valuedTrades, type ValuedTrade } from '../../season/model-stats.js';
import { playedGames } from '../../season/playoffs.js';
import { playerRefs, refOf } from '../waivers/shared.js';

/** How many best and worst trades the history lists. */
const TRADE_RECORDS = 3;

const TeamScoreSchema = z
  .object({ teamId: z.string(), teamName: z.string(), week: z.number().int(), points: z.number() })
  .nullable();
const MarginSchema = z
  .object({
    week: z.number().int(),
    kind: z.enum(['regular', 'playoff']),
    winnerTeamId: z.string(),
    winnerName: z.string(),
    loserTeamId: z.string(),
    loserName: z.string(),
    winnerScore: z.number(),
    loserScore: z.number(),
    margin: z.number()
  })
  .nullable();
const RecordsSchema = z
  .object({
    highestScore: TeamScoreSchema,
    lowestScore: TeamScoreSchema,
    biggestBlowout: MarginSchema,
    closestGame: MarginSchema.describe('Smallest winning margin; ties are not counted.')
  })
  .describe('Single-game records over every final game, playoffs included.');
const HeadToHeadSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  opponentId: z.string(),
  opponentName: z.string(),
  wins: z.number().int().describe("From `teamId`'s side."),
  losses: z.number().int(),
  ties: z.number().int(),
  pointsFor: z.number(),
  pointsAgainst: z.number()
});

const TradeValueRecordSchema = z.object({
  tradeId: z.string(),
  at: z.string(),
  week: z.number().int(),
  teamId: z.string(),
  teamName: z.string(),
  partnerTeamId: z.string(),
  partnerName: z.string(),
  received: z.array(PlayerRefSchema),
  sent: z.array(PlayerRefSchema).describe('Players this team sent, plus any it dropped to make room.'),
  valueDelta: z
    .number()
    .describe(
      "The team's player value won (+) or lost (-): rest-of-season points over replacement received minus sent and dropped, projected from the trade's week."
    )
});

const SeasonSchema = z.object({
  season: z.number().int(),
  championTeamId: z.string().nullable(),
  championName: z.string().nullable(),
  runnerUpTeamId: z.string().nullable(),
  consolationChampionTeamId: z.string().nullable(),
  finalStandings: z.array(
    z.object({
      rank: z.number().int(),
      teamId: z.string(),
      teamName: z.string(),
      wins: z.number().int(),
      losses: z.number().int(),
      ties: z.number().int(),
      pointsFor: z.number(),
      pointsAgainst: z.number()
    })
  ),
  playoffResults: z.array(
    z.object({
      gameId: z.string(),
      bracket: z.enum(['championship', 'consolation']),
      round: z.number().int(),
      week: z.number().int(),
      homeTeamId: z.string().nullable(),
      awayTeamId: z.string().nullable(),
      homeScore: z.number().nullable(),
      awayScore: z.number().nullable(),
      winnerTeamId: z.string().nullable()
    })
  ),
  records: RecordsSchema,
  completedAt: z.string()
});

export const getLeagueHistory = defineOperation({
  name: 'get_league_history',
  method: 'GET',
  path: '/leagues/{leagueId}/history',
  summary: 'League history: past seasons, records, head-to-head, achievements, and trades',
  description: [
    'Returns the league archive: each completed season (champion, runner-up, final standings, playoff results, records), the current season so far (records and head-to-head from every final game), achievements teams have earned, and the trade history.',
    '`tradeRecords` ranks the best and worst trades by value delta (the trade value math applied to each processed trade).',
    "Use it for rivalries and trash talk: `headToHead` has every pair of teams that has met, with the record from the first team's side; records name the highest and lowest single-week scores, the biggest blowout, and the closest game.",
    'Before any week is final everything is empty. Only members can read it.'
  ].join(' '),
  tags: ['leagues', 'season'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema }),
  output: z.object({
    seasons: z.array(SeasonSchema).describe('Completed seasons, newest first.'),
    current: z
      .object({
        season: z.number().int(),
        records: RecordsSchema,
        headToHead: z.array(HeadToHeadSchema)
      })
      .describe('This season so far, from every final game.'),
    achievements: z.array(
      z.object({
        id: z.string(),
        achievementId: z.enum(ACHIEVEMENT_IDS),
        name: z.string(),
        description: z.string(),
        teamId: z.string(),
        teamName: z.string(),
        season: z.number().int(),
        week: z.number().int().nullable().describe('Null for a season award such as the championship.'),
        reason: z.string(),
        awardedAt: z.string()
      })
    ),
    trades: z
      .array(
        z.object({
          id: z.string(),
          at: z.string(),
          week: z.number().int(),
          teamId: z.string(),
          teamName: z.string(),
          added: PlayerRefSchema.nullable(),
          dropped: PlayerRefSchema.nullable()
        })
      )
      .describe('Processed trades from the transaction log, newest first (one entry per team side).'),
    tradeRecords: z
      .object({
        best: z.array(TradeValueRecordSchema).describe('Biggest value wins, best first (at most 3).'),
        worst: z.array(TradeValueRecordSchema).describe('Biggest value losses, worst first (at most 3).')
      })
      .describe('The best and worst trades by value delta, one entry per team side of a processed trade.')
  }),
  handler: async (ctx, input) => {
    const { league, teams } = await requireMember(ctx, input.leagueId);
    const deps = { repos: ctx.repos, reference: ctx.data.reference, log: ctx.log };
    const [seasons, matchups, achievements, transactions] = await Promise.all([
      ctx.repos.history.listSeasons(league.id),
      ctx.repos.schedule.listMatchups(league.id),
      ctx.repos.history.listAchievements(league.id),
      leagueTransactions(deps, league.id)
    ]);
    // Trades from the transaction log (`TXN#` records whose type is `trade`), newest first.
    const trades = transactions.filter((t) => t.type === 'trade').reverse();
    const valued = await valuedTrades(deps, league, teams, ctx.clock.now(), transactions);
    const name = (id: string) => teamName(teams, id);
    const games = playedGames(matchups);
    const refs = await playerRefs(ctx, [
      ...trades.flatMap((t) => [t.addPlayerId, t.dropPlayerId]),
      ...valued.flatMap((t) => t.sides.flatMap((s) => [...s.receives, ...s.sends, ...s.drops]))
    ]);
    const tradeRecord = (t: ValuedTrade, side: ValuedTrade['sides'][number]) => ({
      tradeId: t.tradeId,
      at: t.at,
      week: t.week,
      teamId: side.teamId,
      teamName: name(side.teamId),
      partnerTeamId: side.partnerTeamId,
      partnerName: name(side.partnerTeamId),
      received: side.receives.map((id) => refOf(refs, id)),
      sent: [...side.sends, ...side.drops].map((id) => refOf(refs, id)),
      valueDelta: side.valueDelta
    });
    const sides = valued.flatMap((t) => t.sides.map((side) => ({ t, side })));
    const ranked = (keep: (delta: number) => boolean, order: number) =>
      sides
        .filter(({ side }) => keep(side.valueDelta))
        .sort((a, b) => order * (b.side.valueDelta - a.side.valueDelta) || b.t.at.localeCompare(a.t.at))
        .slice(0, TRADE_RECORDS)
        .map(({ t, side }) => tradeRecord(t, side));
    return {
      seasons: seasons.map((s) => ({
        season: s.season,
        championTeamId: s.championTeamId,
        championName: s.championTeamId === null ? null : name(s.championTeamId),
        runnerUpTeamId: s.runnerUpTeamId,
        consolationChampionTeamId: s.consolationChampionTeamId,
        finalStandings: s.finalStandings,
        playoffResults: s.playoffResults.map((g) => ({
          gameId: g.gameId,
          bracket: g.bracket,
          round: g.round,
          week: g.week,
          homeTeamId: g.homeTeamId,
          awayTeamId: g.awayTeamId,
          homeScore: g.homeScore,
          awayScore: g.awayScore,
          winnerTeamId: g.winnerTeamId
        })),
        records: recordsView(s.records, teams),
        completedAt: s.completedAt
      })),
      current: {
        season: league.season,
        records: recordsView(seasonRecords(games), teams),
        headToHead: headToHead(games).map((h) => headToHeadView(h, teams))
      },
      achievements: [...achievements].reverse().map((a) => ({
        id: a.id,
        achievementId: a.achievementId,
        name: ACHIEVEMENTS[a.achievementId].name,
        description: ACHIEVEMENTS[a.achievementId].description,
        teamId: a.teamId,
        teamName: name(a.teamId),
        season: a.season,
        week: a.week,
        reason: a.reason,
        awardedAt: a.awardedAt
      })),
      trades: trades.map((t) => ({
        id: t.id,
        at: t.at,
        week: t.week,
        teamId: t.teamId,
        teamName: name(t.teamId),
        added: t.addPlayerId === null ? null : refOf(refs, t.addPlayerId),
        dropped: t.dropPlayerId === null ? null : refOf(refs, t.dropPlayerId)
      })),
      tradeRecords: { best: ranked((d) => d > 0, 1), worst: ranked((d) => d < 0, -1) }
    };
  }
});

/** A team's name, or its id for a team no longer in the league. */
function teamName(teams: readonly Team[], id: string): string {
  return teams.find((t) => t.id === id)?.name ?? id;
}

function recordsView(records: SeasonRecords, teams: readonly Team[]) {
  const name = (id: string) => teamName(teams, id);
  const score = (r: SeasonRecords['highestScore']) =>
    r === null ? null : { ...r, teamName: name(r.teamId) };
  const margin = (r: SeasonRecords['biggestBlowout']) =>
    r === null ? null : { ...r, winnerName: name(r.winnerTeamId), loserName: name(r.loserTeamId) };
  return {
    highestScore: score(records.highestScore),
    lowestScore: score(records.lowestScore),
    biggestBlowout: margin(records.biggestBlowout),
    closestGame: margin(records.closestGame)
  };
}

function headToHeadView(h: HeadToHeadRecord, teams: readonly Team[]) {
  return { ...h, teamName: teamName(teams, h.teamId), opponentName: teamName(teams, h.opponentId) };
}
