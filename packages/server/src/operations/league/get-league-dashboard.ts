import { currentPick, playerGame, picksUntilTurn, totalPicks } from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { requireMember } from '../../league/access.js';
import { leagueManagers, teamManager, TeamManagerSchema, type ManagerLookup } from '../../league/managers.js';
import { latestMoves, MOVE_TYPES, moveSides } from '../../league/moves.js';
import { actorTeam } from '../../league/phase.js';
import { LeagueIdSchema, PhaseSchema } from '../../league/views.js';
import { PlayerRefSchema } from '../../players/model.js';
import { defineOperation } from '../../registry/operation.js';
import type { League, Team } from '../../repos/types.js';
import { weekGames } from '../../season/lineups.js';
import { nflWeekView } from '../../season/nfl-games.js';
import { ASSUME_FINAL_AFTER_MS } from '../season/views.js';
import { playerRefs, refOf } from '../waivers/shared.js';
import { loadStandings } from './get-standings.js';

const TeamRefSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  ownerName: z.string().nullable().describe('The person who plays the team, or null for an AI or open seat.'),
  manager: TeamManagerSchema
});
type TeamRef = z.infer<typeof TeamRefSchema>;

const DashboardSideSchema = TeamRefSchema.extend({
  score: z.number().nullable().describe('Points so far (refreshed every few minutes while games are live).'),
  record: z.string().nullable().describe('Regular-season record, e.g. "3-1"; null before the season.')
});

const DashboardMatchupSchema = z.object({
  id: z.string(),
  kind: z.enum(['regular', 'playoff']),
  status: z.enum(['scheduled', 'in_progress', 'final']),
  live: z
    .boolean()
    .describe(
      'An NFL game with a player on either roster is being played right now. A week can be `in_progress` between games; this says points can move.'
    ),
  home: DashboardSideSchema,
  away: DashboardSideSchema
});

const DashboardStandingSchema = TeamRefSchema.extend({
  rank: z.number().int(),
  record: z.string(),
  pointsFor: z.number(),
  streak: z.string().nullable()
});

const MoveSideSchema = TeamRefSchema.extend({
  added: z.array(PlayerRefSchema).describe('Players this team received or picked up.'),
  dropped: z.array(PlayerRefSchema).describe('Players this team released.'),
  cost: z.number().int().nullable().describe('FAAB paid (waiver awards).')
});

/** The move board's entries: roster moves, plus team renames (#194). */
const BOARD_MOVE_TYPES = [...MOVE_TYPES, 'team_renamed'] as const;

const MoveSchema = z.object({
  id: z.string().describe('The trade id for a trade, else the transaction id (or `rename:<teamId>:<at>`).'),
  type: z
    .enum(BOARD_MOVE_TYPES)
    .describe(
      '`trade`: a processed trade (both teams); `add`: a free-agent pickup (with any drop); `waiver`: a waiver award; `drop`: a release; `team_renamed`: a team took a new name (see `rename`).'
    ),
  at: z.string(),
  week: z.number().int(),
  teams: z.array(MoveSideSchema).describe('Each team in the move: one, or two for a trade.'),
  rename: z
    .object({
      from: z.string(),
      to: z.string(),
      by: z.enum(['owner', 'commissioner', 'agent']).describe('Who renamed it (`agent`: its AI manager).')
    })
    .nullable()
    .describe('For `team_renamed`: the old and new names; null for roster moves.')
});
type BoardMove = z.infer<typeof MoveSchema>;

const DraftStatusSchema = z.object({
  status: z.enum(['not_started', 'in_progress', 'paused', 'complete']),
  scheduledAt: z
    .string()
    .nullable()
    .describe('When the draft starts by itself; null when the commissioner starts it by hand.'),
  seatsFilled: z.number().int().describe('Seats with a manager (a person or an AI).'),
  seats: z.number().int(),
  picksMade: z.number().int(),
  totalPicks: z.number().int().nullable().describe('Null until the draft starts.'),
  onTheClock: TeamRefSchema.extend({ overall: z.number().int(), round: z.number().int() })
    .nullable()
    .describe('The team picking now.'),
  deadline: z.string().nullable().describe('When the pick on the clock is due; null while paused.'),
  yourPickIn: z
    .number()
    .int()
    .nullable()
    .describe('Picks before yours (0: you are on the clock); null when you have no picks left.')
});

export const getLeagueDashboard = defineOperation({
  name: 'get_league_dashboard',
  method: 'GET',
  path: '/leagues/{leagueId}/dashboard',
  summary: "The league at a glance: this week's matchups, standings, and the latest moves",
  description: [
    "One read for the league's home page: every matchup this week with scores and each side's manager, the standings (compact rows), and the move board, the latest trades, adds, drops, and waiver awards, each grouped into one move with its teams, players in and out, and FAAB paid, plus team renames (`team_renamed`).",
    'Before and during the draft `matchups` and `standings` are empty and `draft` says when it starts, how many seats are filled, and who is on the clock. Once the season is complete `champion` names the winner.',
    'Scores are the stored ones, refreshed every few minutes while games are live; for a live lineup-level view of one matchup, use get_matchup. `moves` sets how many moves to return (default 10); `hasMoreMoves` says whether older ones exist (page them with list_transactions). Only members can read it.'
  ].join(' '),
  tags: ['leagues', 'season'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    moves: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('How many moves to return (1-50, default 10).')
  }),
  output: z.object({
    leagueId: z.string(),
    name: z.string(),
    season: z.number().int(),
    phase: PhaseSchema,
    week: z.number().int().nullable().describe('The current NFL week, or null before the season.'),
    yourTeamId: z.string().nullable(),
    draft: DraftStatusSchema.nullable().describe('The draft, before the season starts (setup and drafting).'),
    matchups: z.array(DashboardMatchupSchema).describe("This week's matchups; empty before the season."),
    standings: z.object({
      throughWeek: z.number().int().nullable().describe('Last final week included, or null.'),
      rows: z.array(DashboardStandingSchema)
    }),
    moves: z.array(MoveSchema).describe('The latest moves, newest first.'),
    hasMoreMoves: z.boolean(),
    champion: TeamRefSchema.nullable().describe('The league champion, once the final is decided.')
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const { league, teams } = access;
    const managers = await leagueManagers(ctx, league.id, teams);
    const ref = (teamId: string): TeamRef => teamRef(teams, managers, teamId);
    const yourTeamId = actorTeam(access.actor)?.id ?? null;
    const preSeason = league.phase === 'setup' || league.phase === 'drafting';

    const [draft, standings, week, board, playoffs] = await Promise.all([
      preSeason ? draftStatus(ctx, league, teams, yourTeamId, ref) : null,
      preSeason ? { throughWeek: null, standings: [] } : loadStandings(ctx, league, teams, managers),
      preSeason || league.week === null ? [] : ctx.repos.schedule.listMatchups(league.id, league.week),
      latestMoves(
        (cursor) => ctx.repos.waivers.listTransactions(league.id, { limit: 100, cursor }),
        input.moves
      ),
      preSeason ? null : ctx.repos.history.getPlayoffs(league.id)
    ]);

    const records = new Map(standings.standings.map((row) => [row.teamId, row.record]));
    const side = (teamId: string, score: number | null) => ({
      ...ref(teamId),
      score,
      record: records.get(teamId) ?? null
    });
    const refs = await playerRefs(
      ctx,
      board.moves.flatMap((m) => m.records.flatMap((r) => [r.addPlayerId, r.dropPlayerId]))
    );
    const championTeamId = playoffs?.championTeamId ?? null;
    const playing =
      league.week !== null && week.some((m) => m.status === 'in_progress')
        ? await teamsPlaying(ctx, league, teams, league.week)
        : new Set<string>();

    return {
      leagueId: league.id,
      name: league.name,
      season: league.season,
      phase: league.phase,
      week: league.week,
      yourTeamId,
      draft,
      matchups: [...week]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((m) => ({
          id: m.id,
          kind: m.kind,
          status: m.status,
          live: m.status === 'in_progress' && (playing.has(m.homeTeamId) || playing.has(m.awayTeamId)),
          home: side(m.homeTeamId, m.homeScore),
          away: side(m.awayTeamId, m.awayScore)
        })),
      standings: {
        throughWeek: standings.throughWeek,
        rows: standings.standings.map((row) => ({
          ...ref(row.teamId),
          rank: row.rank,
          record: row.record,
          pointsFor: row.pointsFor,
          streak: row.streak
        }))
      },
      ...withRenames(
        board.moves.map((move): BoardMove => ({
          id: move.id,
          type: move.type,
          at: move.at,
          week: move.week,
          teams: moveSides(move).map((s) => ({
            ...ref(s.teamId),
            added: s.added.map((id) => refOf(refs, id)),
            dropped: s.dropped.map((id) => refOf(refs, id)),
            cost: s.cost
          })),
          rename: null
        })),
        board.hasMore,
        teams,
        ref,
        input.moves
      ),
      champion: championTeamId === null ? null : ref(championTeamId)
    };
  }
});

/**
 * The board with the teams' renames (#194) merged in by time, newest first, cut to `limit`. Renames
 * live on the teams (the last few each), so older moves than the log page read may hide some.
 */
function withRenames(
  moves: BoardMove[],
  hasMore: boolean,
  teams: readonly Team[],
  ref: (teamId: string) => TeamRef,
  limit: number
): { moves: BoardMove[]; hasMoreMoves: boolean } {
  const renames = teams.flatMap((team) =>
    (team.renames ?? []).map((r): BoardMove => ({
      id: `rename:${team.id}:${r.at}`,
      type: 'team_renamed',
      at: r.at,
      week: r.week,
      teams: [{ ...ref(team.id), added: [], dropped: [], cost: null }],
      rename: { from: r.from, to: r.to, by: r.by }
    }))
  );
  const all = [...moves, ...renames].sort((a, b) => b.at.localeCompare(a.at));
  return { moves: all.slice(0, limit), hasMoreMoves: hasMore || all.length > limit };
}

function teamRef(teams: readonly Team[], managers: ManagerLookup, teamId: string): TeamRef {
  const team = teams.find((t) => t.id === teamId);
  return {
    teamId,
    teamName: team?.name ?? teamId,
    ownerName: team?.ownerUserId == null ? null : team.ownerName,
    manager: teamManager(managers, teamId)
  };
}

async function draftStatus(
  ctx: Pick<Ctx, 'repos'>,
  league: League,
  teams: readonly Team[],
  yourTeamId: string | null,
  ref: (teamId: string) => TeamRef
): Promise<z.infer<typeof DraftStatusSchema>> {
  const record = league.phase === 'drafting' ? await ctx.repos.drafts.get(league.id) : null;
  const base = {
    scheduledAt: league.phase === 'setup' ? league.settings.draft.scheduledAt : null,
    seatsFilled: teams.filter((t) => t.seatType === 'agent' || t.ownerUserId !== null).length,
    seats: teams.length
  };
  if (record === null) {
    return {
      ...base,
      status: 'not_started',
      picksMade: 0,
      totalPicks: null,
      onTheClock: null,
      deadline: null,
      yourPickIn: null
    };
  }
  const pick = record.status === 'complete' ? null : currentPick(record.state);
  return {
    ...base,
    status: record.status,
    picksMade: record.state.picks.length,
    totalPicks: totalPicks(record.state),
    onTheClock: pick === null ? null : { ...ref(pick.teamId), overall: pick.overall, round: pick.round },
    deadline: record.deadline,
    yourPickIn: yourTeamId === null ? null : picksUntilTurn(record.state, yourTeamId)
  };
}

/** The teams with a rostered player whose NFL game is being played right now. */
async function teamsPlaying(
  ctx: Ctx,
  league: League,
  teams: readonly Team[],
  week: number
): Promise<Set<string>> {
  const { reference } = ctx.data;
  const now = ctx.clock.now();
  const [schedule, stored, players] = await Promise.all([
    weekGames(reference, league.season, week),
    reference.nflGames.get(league.season, week),
    ctx.repos.players.getMany(teams.flatMap((t) => t.roster))
  ]);
  const games = nflWeekView(league.season, week, schedule, stored, now).games.filter(
    (g) => g.gameId !== null
  );
  const nflTeams = new Map(players.map((p) => [p.id, p.team]));
  const live = (playerId: string) =>
    playerGame(nflTeams.get(playerId) ?? null, games, now, { finalAfterMs: ASSUME_FINAL_AFTER_MS }).state ===
    'live';
  return new Set(teams.filter((t) => t.roster.some(live)).map((t) => t.id));
}
