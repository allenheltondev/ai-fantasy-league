import {
  forecastPlayer,
  forecastTeam,
  isStarterSlot,
  LAST_NFL_WEEK,
  lineupInsights,
  opponentWeakSpots,
  optimizeLineup,
  roundPoints,
  RosterSlotSchema,
  willNotPlay,
  winProbability,
  type OutlookPlayer
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireMember, requireTeam } from '../../league/access.js';
import { actorTeam } from '../../league/phase.js';
import { LeagueIdSchema, TeamIdSchema } from '../../league/views.js';
import { PlayerRefSchema, type PlayerRef } from '../../players/model.js';
import { defineOperation, withWarnings, type Warning } from '../../registry/operation.js';
import type { League, Team } from '../../repos/types.js';
import { resolveLineup, rosterPlayers, toRosterPlayer } from '../../season/lineups.js';
import { detailFlag } from '../players.js';
import { leagueWeek, loadWeekData, rosterEntries, type RosterEntry } from './views.js';

const GAME_STATES = ['upcoming', 'live', 'final', 'bye'] as const;

const SideSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  currentPoints: z.number().describe("The starters' points so far."),
  projectedPoints: z.number().describe('Expected final score: points so far plus expected points to come.'),
  remainingPoints: z.number().describe('Expected points still to come.'),
  stdDev: z.number().describe('Uncertainty in the final score (one standard deviation, in points).'),
  playersYetToPlay: z.number().int().describe('Starters whose game has not kicked off.'),
  playersInProgress: z.number().int().describe('Starters whose game is under way.'),
  playersDone: z.number().int().describe('Starters whose game is final.'),
  playersNotPlaying: z
    .number()
    .int()
    .describe('Starters on bye or ruled out before their game: they score nothing (bench them if you can).'),
  winProbability: z
    .number()
    .nullable()
    .describe('Chance to win this matchup, 0-1. Null without an opponent.'),
  players: z
    .array(
      z.object({
        player: PlayerRefSchema,
        slot: RosterSlotSchema,
        game: z.enum(GAME_STATES).describe('His NFL game: upcoming (not started), live, final, or bye.'),
        projectedPoints: z.number().nullable(),
        points: z.number().nullable(),
        expectedPoints: z.number().describe('Expected final points: actual so far plus what remains.')
      })
    )
    .optional()
    .describe('Every rostered player, starters first. Present when `detail` is true.')
});

const OutlookSchema = z.object({
  week: z.number().int(),
  teamId: z.string(),
  status: z
    .enum(['scheduled', 'in_progress', 'final'])
    .nullable()
    .describe('The matchup status, or null when the team has no game this week.'),
  you: SideSchema.describe('The team asked about (default: yours).'),
  opponent: SideSchema.nullable().describe('The opponent, or null with no game this week.'),
  insights: z
    .object({
      startersOut: z
        .array(z.object({ player: PlayerRefSchema, slot: RosterSlotSchema, reason: z.enum(['bye', 'out']) }))
        .describe('Starters on bye or ruled out whose slot can still change: bench them with set_lineup.'),
      emptySlots: z.array(z.object({ slot: RosterSlotSchema, missing: z.number().int() })),
      benchUpgrades: z
        .array(
          z.object({
            player: PlayerRefSchema.describe('The bench player to start.'),
            replaces: PlayerRefSchema.nullable().describe(
              'The starter to bench, or null to fill an empty slot.'
            ),
            slot: RosterSlotSchema,
            gain: z.number().describe('Projected points gained.')
          })
        )
        .describe('Bench players projected above a starter they can replace, best gain first.'),
      lockedPlayers: z
        .array(PlayerRefSchema)
        .describe('Players whose game has kicked off: their slots are fixed for the week.'),
      currentProjectedPoints: z
        .number()
        .describe("The current starters' projected points (ignoring live scores)."),
      optimalProjectedPoints: z
        .number()
        .describe('Projected points of the best legal lineup, keeping locked players where they are.')
    })
    .describe('Lineup advice for `you`.'),
  opponentWeakSpots: z
    .array(
      z.object({
        slot: RosterSlotSchema,
        player: PlayerRefSchema.nullable().describe("The opponent's player, or null for an empty slot."),
        reason: z.enum(['empty', 'bye', 'out', 'outprojected']),
        theirProjected: z.number(),
        yourPlayer: PlayerRefSchema.nullable(),
        yourProjected: z.number(),
        edge: z.number().describe('Your expected points minus theirs in that slot.')
      })
    )
    .describe('Where the opponent is weak (empty, bye, out, or out-projected slots), largest edge first.')
});

interface Side {
  team: Team;
  entries: RosterEntry[];
  outlook: OutlookPlayer[];
  refs: Map<string, PlayerRef>;
  optimal: number;
}

export const getMatchupOutlook = defineOperation({
  name: 'get_matchup_outlook',
  method: 'GET',
  path: '/leagues/{leagueId}/matchup/outlook',
  summary: 'How does my week look? Projected outcome, win probability, and lineup advice',
  description: [
    'Answers "how does my week look?" for a team\'s matchup: each side\'s current score, expected final score (points so far plus the projection still to come), and win probability from a simple normal model of projections.',
    "`insights` flags your own lineup: starters on bye or ruled out, empty slots, bench players projected above a starter they can replace (with the gain), players already locked, and the best lineup's projected points. Fix what it flags with set_lineup before each player's kickoff.",
    "`opponentWeakSpots` lists the opponent's empty, bye, ruled-out, and out-projected slots.",
    "While games are live, `currentPoints`, `remainingPoints`, and the player counts track the week: a player in a live game has his unmet projection times the share of the game still to play left (from the quarter and clock; half when the game has started but not been read yet), and a final game (the scoreboard's final, at once) has nothing left.",
    'Defaults: your own team and the current week. Projections use league scoring; with none stored yet a NO_PROJECTIONS warning says so. Before the draft there is no schedule (NO_SCHEDULE_YET). `detail: true` adds every player row for both sides. Only members can read it.'
  ].join(' '),
  tags: ['season'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdSchema.optional().describe('Team to look at (default: your own team).'),
    week: z
      .number()
      .int()
      .min(1)
      .max(LAST_NFL_WEEK)
      .optional()
      .describe('NFL week (default: the current week).'),
    detail: detailFlag
  }),
  output: OutlookSchema,
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const { league, teams } = access;
    const own = actorTeam(access.actor);
    if (input.teamId === undefined && own === null) {
      throw new ApiError('INVALID_INPUT', 'You do not manage a team, so there is no default team.', {
        fix: `Pass teamId, one of: ${teams.map((t) => t.id).join(', ')}.`
      });
    }
    const team = requireTeam(access, input.teamId ?? (own as Team).id);
    const week = leagueWeek(league, input.week);
    const matchup = (await ctx.repos.schedule.listMatchups(league.id, week)).find(
      (m) => m.homeTeamId === team.id || m.awayTeamId === team.id
    );
    const opponentId =
      matchup === undefined ? null : matchup.homeTeamId === team.id ? matchup.awayTeamId : matchup.homeTeamId;
    const opponentTeam = teams.find((t) => t.id === opponentId) ?? null;

    const you = await loadSide(ctx, league, team, week);
    const them = opponentTeam === null ? null : await loadSide(ctx, league, opponentTeam, week);
    const yourForecast = forecastTeam(you.outlook);
    const theirForecast = them === null ? null : forecastTeam(them.outlook);
    const insights = lineupInsights(league.settings, you.outlook);
    const ref = (side: Side, id: string) =>
      side.refs.get(id) ?? { id, name: id, team: null, position: 'WR' as const };

    const data = {
      week,
      teamId: team.id,
      status: matchup?.status ?? null,
      you: sideView(you, yourForecast, theirForecast, input.detail),
      opponent:
        them === null || theirForecast === null
          ? null
          : sideView(them, theirForecast, yourForecast, input.detail),
      insights: {
        startersOut: insights.startersOut.map((s) => ({
          player: ref(you, s.playerId),
          slot: s.slot,
          reason: s.reason
        })),
        emptySlots: insights.emptySlots,
        benchUpgrades: insights.benchUpgrades.map((u) => ({
          player: ref(you, u.benchPlayerId),
          replaces: u.starterPlayerId === null ? null : ref(you, u.starterPlayerId),
          slot: u.slot,
          gain: u.gain
        })),
        lockedPlayers: insights.locked.map((id) => ref(you, id)),
        currentProjectedPoints: roundPoints(
          you.outlook
            .filter((p) => isStarterSlot(p.slot) && !willNotPlay(p))
            .reduce((sum, p) => sum + Math.max(p.projected ?? 0, 0), 0)
        ),
        optimalProjectedPoints: you.optimal
      },
      opponentWeakSpots:
        them === null
          ? []
          : opponentWeakSpots(league.settings, you.outlook, them.outlook).map((w) => ({
              slot: w.slot,
              player: w.playerId === null ? null : ref(them, w.playerId),
              reason: w.reason,
              theirProjected: w.theirProjected,
              yourPlayer: w.yourPlayerId === null ? null : ref(you, w.yourPlayerId),
              yourProjected: w.yourProjected,
              edge: w.edge
            }))
    };

    const warnings: Warning[] = [];
    if (league.phase === 'setup' || league.phase === 'drafting') {
      warnings.push({ code: 'NO_SCHEDULE_YET', message: 'The schedule is created when the draft starts.' });
    } else if (matchup === undefined) {
      warnings.push({ code: 'NO_MATCHUP', message: `${team.name} has no game in week ${week}.` });
    }
    if (team.roster.length > 0 && you.entries.every((e) => e.projectedPoints === null)) {
      warnings.push({
        code: 'NO_PROJECTIONS',
        message: `No projections are stored for week ${week} yet, so expected points count only points already scored.`
      });
    }
    return withWarnings(data, warnings);
  }
});

async function loadSide(ctx: Ctx, league: League, team: Team, week: number): Promise<Side> {
  const now = ctx.clock.now();
  const [lineup, players, data] = await Promise.all([
    resolveLineup(ctx.repos, team, week),
    rosterPlayers(ctx.repos, team),
    loadWeekData(ctx, league, week, team.roster)
  ]);
  const entries = rosterEntries(lineup.entries, players, data, now);
  // Each player's game state comes from core `playerGame`, as on the matchup and the lineup (#193).
  const outlook = entries.map((e): OutlookPlayer => ({
    playerId: e.player.id,
    slot: e.slot,
    positions: players.has(e.player.id) ? [e.player.position] : [],
    status: e.status,
    game: e.game.state,
    progress: e.game.progress,
    projected: e.projectedPoints,
    actual: e.points
  }));
  const optimal = optimizeLineup(
    league.settings,
    team.roster.map((id) => toRosterPlayer(id, players.get(id))),
    Object.fromEntries(data.projected),
    { games: data.games, now, previousLineup: lineup.entries }
  ).projectedPoints;
  return { team, entries, outlook, refs: new Map(entries.map((e) => [e.player.id, e.player])), optimal };
}

function sideView(
  side: Side,
  forecast: ReturnType<typeof forecastTeam>,
  other: ReturnType<typeof forecastTeam> | null,
  detail: boolean
): z.input<typeof SideSchema> {
  const byId = new Map(side.outlook.map((p) => [p.playerId, p]));
  return {
    teamId: side.team.id,
    teamName: side.team.name,
    currentPoints: forecast.current,
    projectedPoints: forecast.projected,
    remainingPoints: forecast.remaining,
    stdDev: forecast.stdDev,
    playersYetToPlay: forecast.yetToPlay,
    playersInProgress: forecast.inProgress,
    playersDone: forecast.done,
    playersNotPlaying: forecast.notPlaying,
    winProbability: other === null ? null : winProbability(forecast, other),
    ...(detail
      ? {
          players: side.entries.map((e) => {
            const p = byId.get(e.player.id) as OutlookPlayer;
            return {
              player: e.player,
              slot: e.slot,
              game: p.game,
              projectedPoints: e.projectedPoints,
              points: e.points,
              expectedPoints: roundPoints(forecastPlayer(p).mean)
            };
          })
        }
      : {})
  };
}
