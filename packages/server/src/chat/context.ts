import {
  dmPartner,
  headToHead,
  isStarterSlot,
  powerRankings,
  seriesBetween,
  unfilledStarterSlots,
  type Position,
  type SeriesRecord
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { isApiError } from '../errors.js';
import type { LeagueAccess } from '../league/access.js';
import { actorTeam } from '../league/phase.js';
import { getDraftBoard } from '../operations/draft/get-draft-board.js';
import { getMatchup } from '../operations/league/get-matchup.js';
import { getStandings } from '../operations/league/get-standings.js';
import { getTrendingPlayers } from '../operations/research/get-trending-players.js';
import { getMatchupOutlook } from '../operations/season/get-matchup-outlook.js';
import { getNflGames } from '../operations/season/get-nfl-games.js';
import { listTrades } from '../operations/trades/list.js';
import { PUBLIC_STATUSES, type TradeView } from '../operations/trades/shared.js';
import { listTransactions } from '../operations/waivers/transactions.js';
import { OperationResult, type AnyInputSchema, type Operation } from '../registry/operation.js';
import type { Matchup, Team } from '../repos/types.js';
import { playedGames } from '../season/playoffs.js';
import type { ResolvedRoom } from './rooms.js';

/**
 * Room context packs (issue #153): a small set of facts about the room an AI manager talks in, so
 * its chat can be about the league and not only about the last few messages. Each pack is built
 * from the league's own read operations, called as the caller, so a pack holds only what the
 * caller's team may already read:
 *
 * - no waiver claims or bids (only awarded claims from the transaction log);
 * - no pending offers between other teams (`list_trades` hides them), and in rooms other people
 *   read, not even the details of the caller's own pending offers (only how many are open);
 * - nothing from another team's DMs; a DM pack is about the two teams in it, and offers from
 *   before the caller took its seat stay with the previous occupant (the DM tenure floor);
 * - about other teams, only public roster facts (lineups, points, injuries, byes, needs).
 *
 * Packs are compact: short lists, capped, so the agent's rendered facts stay near 1.5 KB.
 */

export const CONTEXT_LIMITS = {
  /** Days of completed trades in the trades room. */
  tradeDays: 14,
  trades: 5,
  draftRecentPicks: 6,
  draftRecap: 3,
  waiverAwards: 8,
  trending: 5,
  powerTop: 3
} as const;

const SeriesSchema = z.object({ wins: z.number().int(), losses: z.number().int(), ties: z.number().int() });
const TeamNameRef = z.object({ teamId: z.string(), teamName: z.string() });
const PlayerLine = z.object({
  name: z.string(),
  position: z.string(),
  nflTeam: z.string().nullable()
});

const TradeLineSchema = z.object({
  tradeId: z.string(),
  status: z.string(),
  at: z.string().describe('The latest step of the trade.'),
  fromTeamId: z.string(),
  fromTeamName: z.string(),
  toTeamId: z.string(),
  toTeamName: z.string(),
  fromSends: z.array(z.string()).describe('Player names the offering team sends.'),
  toSends: z.array(z.string()).describe('Player names the answering team sends.')
});
export type TradeLine = z.infer<typeof TradeLineSchema>;

const LeaguePackSchema = z.object({
  kind: z.literal('league'),
  throughWeek: z.number().int().nullable().describe('Last final week in the standings.'),
  standings: z.array(
    TeamNameRef.extend({
      rank: z.number().int(),
      record: z.string(),
      streak: z.string().nullable(),
      pointsFor: z.number()
    })
  ),
  lastWeek: z
    .array(
      z.object({
        homeTeamId: z.string(),
        homeScore: z.number(),
        awayTeamId: z.string(),
        awayScore: z.number()
      })
    )
    .describe('Results of the last final week.'),
  powerTop: z.array(TeamNameRef.extend({ rank: z.number().int(), score: z.number() })),
  headToHead: TeamNameRef.extend(SeriesSchema.shape)
    .nullable()
    .describe('Your record against `aboutTeamId`, when given and they have met.')
});

const StarterSchema = PlayerLine.extend({
  slot: z.string(),
  points: z.number().nullable(),
  projected: z.number().nullable(),
  injury: z.string().nullable().describe('Injury designation, when he has one.'),
  onBye: z.boolean(),
  redZone: z.boolean().describe('His NFL team is in the red zone right now.')
});

const MatchupPackSchema = z.object({
  kind: z.literal('matchup'),
  week: z.number().int(),
  status: z.enum(['scheduled', 'in_progress', 'final']),
  sides: z.array(
    TeamNameRef.extend({
      points: z.number(),
      projected: z.number(),
      winProbability: z.number().nullable(),
      starters: z.array(StarterSchema)
    })
  ),
  series: SeriesSchema.nullable().describe("The season series from the first side's view, before this game.")
});

const DraftPackSchema = z.object({
  kind: z.literal('draft'),
  status: z.enum(['not_started', 'in_progress', 'paused', 'complete']),
  picksMade: z.number().int(),
  recentPicks: z.array(TeamNameRef.extend({ overall: z.number().int(), player: PlayerLine })),
  yourPicks: z.array(PlayerLine),
  steals: z.array(TeamNameRef.extend({ player: PlayerLine, value: z.number().nullable() })),
  reaches: z.array(TeamNameRef.extend({ player: PlayerLine, value: z.number().nullable() }))
});

const TradesPackSchema = z.object({
  kind: z.literal('trades'),
  deadline: z.object({ week: z.number().int(), at: z.string().nullable(), passed: z.boolean() }),
  recent: z.array(TradeLineSchema).describe('Trades completed or vetoed in the last two weeks.'),
  yours: z.array(TradeLineSchema).describe('Your trades the league can see (accepted or later).'),
  yourOpenOffers: z.number().int().describe('Your offers waiting for an answer (details stay private).')
});

const WaiversPackSchema = z.object({
  kind: z.literal('waivers'),
  lastRun: z
    .object({
      week: z.number().int(),
      at: z.string(),
      awards: z.array(TeamNameRef.extend({ player: PlayerLine, cost: z.number().nullable() }))
    })
    .nullable(),
  faab: z.array(TeamNameRef.extend({ remaining: z.number() })).describe('Empty for rolling waivers.'),
  trending: z.array(PlayerLine.extend({ adds: z.number().int() }))
});

const DmPackSchema = z.object({
  kind: z.literal('dm'),
  other: TeamNameRef,
  trades: z.array(TradeLineSchema).describe('Trades and offers between your two teams, newest first.'),
  otherNeeds: z.array(z.string()).describe("Starting slots the other team's healthy roster cannot fill."),
  headToHead: SeriesSchema.nullable().describe('Your record against them this season.')
});

export const ChatContextPackSchema = z.union([
  LeaguePackSchema,
  MatchupPackSchema,
  DraftPackSchema,
  TradesPackSchema,
  WaiversPackSchema,
  DmPackSchema
]);
export type ChatContextPack = z.infer<typeof ChatContextPackSchema>;

/** Runs a read operation's handler as the caller (same guards), and returns its validated data. */
async function read<I extends AnyInputSchema, O extends z.ZodType>(
  ctx: Ctx,
  op: Operation<I, O>,
  input: z.input<I>
): Promise<z.output<O>> {
  const returned = await op.handler(ctx, op.input.parse(input) as z.output<I>);
  return op.output.parse(returned instanceof OperationResult ? returned.data : returned) as z.output<O>;
}

const nameOf = (teams: readonly Team[], id: string) => teams.find((t) => t.id === id)?.name ?? id;
const ref = (teams: readonly Team[], teamId: string) => ({ teamId, teamName: nameOf(teams, teamId) });
const playerLine = (p: { name: string; position: string; team: string | null }) => ({
  name: p.name,
  position: p.position,
  nflTeam: p.team
});

function series(matchups: readonly Matchup[], teamId: string, opponentId: string): SeriesRecord | null {
  return seriesBetween(headToHead(playedGames(matchups)), teamId, opponentId);
}

function tradeLine(view: TradeView): TradeLine {
  return {
    tradeId: view.id,
    status: view.status,
    at: view.history.at(-1)?.at ?? view.proposedAt,
    fromTeamId: view.fromTeam.id,
    fromTeamName: view.fromTeam.name,
    toTeamId: view.toTeam.id,
    toTeamName: view.toTeam.name,
    fromSends: view.fromSends.map((p) => p.name),
    toSends: view.toSends.map((p) => p.name)
  };
}

async function leaguePack(
  ctx: Ctx,
  access: LeagueAccess,
  aboutTeamId: string | undefined
): Promise<z.infer<typeof LeaguePackSchema>> {
  const { league, teams } = access;
  const standings = await read(ctx, getStandings, { leagueId: league.id });
  const matchups = await ctx.repos.schedule.listMatchups(league.id);
  const through = standings.throughWeek;
  const lastWeek = matchups
    .filter((m) => m.week === through && m.status === 'final')
    .map((m) => ({
      homeTeamId: m.homeTeamId,
      homeScore: m.homeScore ?? 0,
      awayTeamId: m.awayTeamId,
      awayScore: m.awayScore ?? 0
    }));
  const power = powerRankings(
    playedGames(matchups),
    teams.map((t) => t.id)
  ).slice(0, CONTEXT_LIMITS.powerTop);
  const mine = actorTeam(access.actor)?.id ?? null;
  const about =
    aboutTeamId !== undefined &&
    mine !== null &&
    aboutTeamId !== mine &&
    teams.some((t) => t.id === aboutTeamId)
      ? aboutTeamId
      : null;
  const h2h = about === null ? null : series(matchups, mine as string, about);
  return {
    kind: 'league',
    throughWeek: through,
    standings: standings.standings.map((r) => ({
      teamId: r.teamId,
      teamName: r.teamName,
      rank: r.rank,
      record: r.record,
      streak: r.streak,
      pointsFor: r.pointsFor
    })),
    lastWeek,
    powerTop:
      through === null ? [] : power.map((p) => ({ ...ref(teams, p.teamId), rank: p.rank, score: p.score })),
    headToHead: h2h === null || about === null ? null : { ...ref(teams, about), ...h2h }
  };
}

async function matchupPack(
  ctx: Ctx,
  access: LeagueAccess,
  resolved: ResolvedRoom
): Promise<z.infer<typeof MatchupPackSchema>> {
  const { league, teams } = access;
  const [homeId, awayId] = resolved.room.teamIds as [string, string];
  const week = resolved.room.week as number;
  const [matchup, outlook, games, all] = await Promise.all([
    read(ctx, getMatchup, { leagueId: league.id, teamId: homeId, week }),
    read(ctx, getMatchupOutlook, { leagueId: league.id, teamId: homeId, week }),
    read(ctx, getNflGames, { leagueId: league.id, week }),
    ctx.repos.schedule.listMatchups(league.id)
  ]);
  const redZone = new Set(games.redZone.map((r) => r.team));
  const side = (key: 'home' | 'away', forecast: typeof outlook.you | null) => {
    const lineup = matchup.lineups?.[key];
    const teamId = key === 'home' ? homeId : awayId;
    return {
      ...ref(teams, teamId),
      points: lineup?.points ?? 0,
      projected: forecast?.projectedPoints ?? 0,
      winProbability: forecast?.winProbability ?? null,
      starters: (lineup?.players ?? [])
        .filter((p) => isStarterSlot(p.slot))
        .map((p) => ({
          ...playerLine(p.player),
          slot: p.slot,
          points: p.points,
          projected: p.projectedPoints,
          injury: p.injuryStatus,
          onBye: p.onBye,
          redZone: p.player.team !== null && redZone.has(p.player.team) && !p.onBye
        }))
    };
  };
  const earlier = all.filter((m) => m.week < week);
  return {
    kind: 'matchup',
    week,
    status: matchup.matchup?.status ?? 'scheduled',
    sides: [side('home', outlook.you), side('away', outlook.opponent)],
    series: series(earlier, homeId, awayId)
  };
}

async function draftPack(ctx: Ctx, access: LeagueAccess): Promise<z.infer<typeof DraftPackSchema>> {
  const { league, teams } = access;
  let board;
  try {
    board = await read(ctx, getDraftBoard, { leagueId: league.id, limit: 1 });
  } catch (error) {
    if (!isApiError(error)) throw error;
    return {
      kind: 'draft',
      status: 'not_started',
      picksMade: 0,
      recentPicks: [],
      yourPicks: [],
      steals: [],
      reaches: []
    };
  }
  const recap = (entries: NonNullable<typeof board.recap>['steals']) =>
    entries.slice(0, CONTEXT_LIMITS.draftRecap).map((e) => ({
      ...ref(teams, e.teamId),
      player: playerLine(e.player),
      value: e.value
    }));
  return {
    kind: 'draft',
    status: board.status,
    picksMade: board.picks.length,
    recentPicks: board.picks.slice(-CONTEXT_LIMITS.draftRecentPicks).map((p) => ({
      ...ref(teams, p.teamId),
      overall: p.overall,
      player: playerLine(p.player)
    })),
    yourPicks:
      board.yourTeamId === null
        ? []
        : board.picks.filter((p) => p.teamId === board.yourTeamId).map((p) => playerLine(p.player)),
    steals: board.recap === null ? [] : recap(board.recap.steals),
    reaches: board.recap === null ? [] : recap(board.recap.reaches)
  };
}

async function tradesPack(ctx: Ctx, access: LeagueAccess): Promise<z.infer<typeof TradesPackSchema>> {
  const { league } = access;
  const now = ctx.clock.now();
  const { trades } = await read(ctx, listTrades, { leagueId: league.id, limit: 100 });
  const since = new Date(now.getTime() - CONTEXT_LIMITS.tradeDays * 24 * 60 * 60 * 1000).toISOString();
  const lines = trades.map((view) => ({ view, line: tradeLine(view) }));
  return {
    kind: 'trades',
    deadline: {
      week: league.settings.trades.deadlineWeek,
      at: league.deadlines.tradeDeadlineAt,
      passed:
        league.deadlines.tradeDeadlineAt !== null && now.toISOString() >= league.deadlines.tradeDeadlineAt
    },
    recent: lines
      .filter(
        ({ view, line }) => (view.status === 'processed' || view.status === 'vetoed') && line.at >= since
      )
      .slice(0, CONTEXT_LIMITS.trades)
      .map(({ line }) => line),
    // Others read this room: only your trades the league can already see, never an open offer's terms.
    yours: lines
      .filter(({ view }) => view.direction !== 'league' && PUBLIC_STATUSES.has(view.status))
      .slice(0, CONTEXT_LIMITS.trades)
      .map(({ line }) => line),
    yourOpenOffers: trades.filter((t) => t.direction !== 'league' && t.status === 'proposed').length
  };
}

async function waiversPack(ctx: Ctx, access: LeagueAccess): Promise<z.infer<typeof WaiversPackSchema>> {
  const { league, teams } = access;
  const [log, trending] = await Promise.all([
    read(ctx, listTransactions, { leagueId: league.id, limit: 50 }),
    read(ctx, getTrendingPlayers, { type: 'add', limit: CONTEXT_LIMITS.trending })
  ]);
  const claims = log.transactions.filter((t) => t.type === 'waiver_claim' && t.added !== null);
  const latest = claims[0];
  // One run awards its claims together: the newest award's week and day.
  const run =
    latest === undefined
      ? []
      : claims.filter((t) => t.week === latest.week && t.at.slice(0, 10) === latest.at.slice(0, 10));
  return {
    kind: 'waivers',
    lastRun:
      latest === undefined
        ? null
        : {
            week: latest.week,
            at: latest.at,
            awards: run.slice(0, CONTEXT_LIMITS.waiverAwards).map((t) => ({
              ...ref(teams, t.teamId),
              player: playerLine(t.added as NonNullable<typeof t.added>),
              cost: t.cost
            }))
          },
    faab:
      league.settings.waivers.type === 'faab'
        ? teams.map((t) => ({ ...ref(teams, t.id), remaining: t.faabRemaining }))
        : [],
    trending: trending.players.map((p) => ({ ...playerLine(p.player), adds: p.count }))
  };
}

/** Players who cannot start: out for the week or longer. */
const UNAVAILABLE = new Set(['out', 'ir', 'injured reserve', 'pup', 'suspended', 'nfi']);

async function dmPack(
  ctx: Ctx,
  access: LeagueAccess,
  resolved: ResolvedRoom
): Promise<z.infer<typeof DmPackSchema>> {
  const { league, teams } = access;
  const mine = actorTeam(access.actor) as Team;
  const otherId = dmPartner({ teamIds: resolved.room.teamIds as [string, string] }, mine.id);
  const other = teams.find((t) => t.id === otherId) as Team;
  const [{ trades }, matchups, players] = await Promise.all([
    read(ctx, listTrades, { leagueId: league.id, limit: 100 }),
    ctx.repos.schedule.listMatchups(league.id),
    ctx.repos.players.getMany(other.roster)
  ]);
  const pair = new Set([mine.id, otherId]);
  const floor = resolved.visibleFrom;
  const between = trades.filter(
    (t) =>
      pair.has(t.fromTeam.id) &&
      pair.has(t.toTeam.id) &&
      // A private offer from before you took the seat was the previous occupant's.
      (floor === null || PUBLIC_STATUSES.has(t.status) || t.proposedAt >= floor)
  );
  const healthy = players.filter(
    (p) => p.status !== 'injured_reserve' && !UNAVAILABLE.has((p.injuryStatus ?? '').toLowerCase())
  );
  return {
    kind: 'dm',
    other: ref(teams, otherId),
    trades: between.slice(0, CONTEXT_LIMITS.trades).map(tradeLine),
    otherNeeds: unfilledStarterSlots(
      league.settings,
      healthy.map((p): Position[] => [p.position])
    ),
    headToHead: series(matchups, mine.id, otherId)
  };
}

/** The fact pack for a room the caller may read (`resolveRoom` has already checked that). */
export async function buildChatContext(
  ctx: Ctx,
  access: LeagueAccess,
  resolved: ResolvedRoom,
  options: { aboutTeamId?: string | undefined } = {}
): Promise<ChatContextPack> {
  const { parsed } = resolved;
  if (parsed.kind === 'dm') return dmPack(ctx, access, resolved);
  if (parsed.kind === 'matchup') return matchupPack(ctx, access, resolved);
  switch (parsed.id) {
    case 'draft':
      return draftPack(ctx, access);
    case 'trades':
      return tradesPack(ctx, access);
    case 'waivers-news':
      return waiversPack(ctx, access);
    default:
      return leaguePack(ctx, access, options.aboutTeamId);
  }
}
