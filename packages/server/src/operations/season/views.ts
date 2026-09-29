import {
  eligibleStarterSlots,
  forecastPlayer,
  isPlayerLocked,
  isOnBye,
  isStarterSlot,
  playerKickoff,
  playerGame,
  PlayerStatusSchema,
  ROSTER_SLOTS,
  RosterSlotSchema,
  roundPoints,
  scorePlayer,
  slotCount,
  statLine,
  type LeagueSettings,
  type LineupEntry,
  type NflGameRead,
  type RuleIssue,
  type StatLine,
  type WeekGames
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { PlayerDetailSchema, toPlayerDetail, type Player } from '../../players/model.js';
import type { Warning } from '../../registry/operation.js';
import type { League } from '../../repos/types.js';
import { gamesByTeam, playerStatus, weekGames } from '../../season/lineups.js';
import { FINALS_GRACE_MS, nflWeekView } from '../../season/nfl-games.js';
import { STATS_GAME_DURATION_MS } from '../../season/window.js';

/** Shapes and loaders shared by get_roster, set_lineup, and the matchup lineups. */

export const LineupWeekSchema = z
  .number()
  .int()
  .min(1)
  .max(18)
  .optional()
  .describe("NFL week (default: the league's current week).");

/** The week to read or change, checked against the weeks the league plays. */
export function leagueWeek(league: League, requested: number | undefined): number {
  const { startWeek } = league.settings.schedule;
  const lastWeek = league.settings.playoffs.endWeek;
  const week = requested ?? league.week ?? startWeek;
  if (week < startWeek || week > lastWeek) {
    throw new ApiError(
      'INVALID_INPUT',
      `This league plays weeks ${startWeek}-${lastWeek}, not week ${week}.`,
      {
        fix: `Pass a week from ${startWeek} to ${lastWeek}, or leave week out for the current week.`
      }
    );
  }
  return week;
}

/**
 * A game this long past kickoff counts as final even when no final was read (the feed failed): the
 * longest a game runs, plus the grace the live job keeps reading for finals.
 */
export const ASSUME_FINAL_AFTER_MS = STATS_GAME_DURATION_MS + FINALS_GRACE_MS;

export const PlayerGameSchema = z
  .object({
    state: z
      .enum(['upcoming', 'live', 'final', 'bye'])
      .describe(
        'upcoming (not kicked off), live (kicked off and not over; a started game with no live read yet counts as live), final, or bye (no game this week).'
      ),
    opponent: z.string().nullable().describe('The opposing NFL team, or null on a bye.'),
    home: z.boolean().nullable().describe('True when his team is at home; null on a bye.'),
    kickoff: z.string().nullable().describe('Kickoff (ISO 8601), or null on a bye.'),
    period: z.number().int().nullable().describe('The quarter once under way (5 and up is overtime).'),
    clock: z.string().nullable().describe('The game clock while live, e.g. "8:42".'),
    teamScore: z.number().nullable().describe("His NFL team's score once under way."),
    opponentScore: z.number().nullable(),
    possession: z.boolean().describe('His team has the ball (live only).'),
    redZone: z.boolean().describe("His team has the ball inside the opponent's 20 (live only)."),
    progress: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe('Share of the game played: 0 before kickoff, 1 when final, null when unknown or on a bye.')
  })
  .describe(
    'His NFL game as it stands: the same state the matchup, the outlook, and the lineup locks use (#193).'
  );

export const RosterEntrySchema = z.object({
  player: PlayerDetailSchema,
  slot: RosterSlotSchema.describe('Where the player sits this week: a starting slot, BN (bench), or IR.'),
  status: PlayerStatusSchema.describe(
    'Availability: active, questionable, doubtful, out, ir, pup, nfi, suspended, covid, na.'
  ),
  injuryStatus: z.string().nullable().describe('The raw injury designation, e.g. "Questionable", or null.'),
  byeWeek: z.number().int().nullable().describe("The NFL team's bye week, or null when unknown."),
  onBye: z.boolean().describe('True when his NFL team has no game this week (or he has no team).'),
  kickoff: z.string().nullable().describe("His game's kickoff this week (ISO 8601), or null on a bye."),
  opponent: z
    .object({
      team: z.string().describe('The opposing NFL team, e.g. "BUF".'),
      home: z.boolean().describe('True when his team is at home.')
    })
    .nullable()
    .describe("His NFL team's opponent this week, or null on a bye."),
  locked: z.boolean().describe('True once his game has kicked off: he cannot change slots until next week.'),
  projectedPoints: z
    .number()
    .nullable()
    .describe('Projected points this week under league scoring, or null.'),
  points: z.number().nullable().describe('Points scored this week so far, or null before he has stats.'),
  game: PlayerGameSchema,
  expectedPoints: z
    .number()
    .nullable()
    .describe(
      'Expected final points: points so far plus what his projection says is still to come (scaled by how much of a live game is left; nothing more on a bye or ruled out). Null with neither a projection nor points.'
    ),
  statLine: z
    .string()
    .nullable()
    .describe('His box score this week once his game is under way, e.g. "18/27 · 212 yds · 2 TD", or null.'),
  recentPoints: z
    .object({
      average: z.number().describe('Average points per game under league scoring.'),
      games: z.number().int().describe('Games averaged (at most 3; weeks without a stat line are skipped).')
    })
    .nullable()
    .optional()
    .describe(
      'His average over the last 3 NFL weeks before this one, or null with no games yet. Present on get_roster.'
    ),
  seasonAverage: z
    .object({
      average: z.number().describe('Average points per game under league scoring.'),
      games: z.number().int().describe('Games played before this week.')
    })
    .nullable()
    .optional()
    .describe(
      'His average over this season before this week, or null with no games yet. Present on get_roster.'
    ),
  eligibleSlots: z
    .array(RosterSlotSchema)
    .optional()
    .describe(
      'Starting slots this league uses that he can fill (for set_lineup). Present when `detail` is true.'
    )
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const SlotCountSchema = z.object({ slot: RosterSlotSchema, count: z.number().int() });

/** The league's slots in display order, with how many of each. */
export function slotCounts(league: League): z.infer<typeof SlotCountSchema>[] {
  return ROSTER_SLOTS.map((slot) => ({ slot, count: slotCount(league.settings, slot) })).filter(
    (s) => s.count > 0 || s.slot === 'BN'
  );
}

export interface WeekData {
  games: WeekGames;
  /** Each playing NFL team's opponent this week. */
  opponents: ReadonlyMap<string, { team: string; home: boolean }>;
  /** The week's scheduled games as they stand (the schedule overlaid with the latest live read). */
  nflGames: NflGameRead[];
  byes: Record<string, number>;
  projected: Map<string, number>;
  actual: Map<string, number>;
  /** The raw stat lines, for the box score. */
  stats: Map<string, StatLine>;
}

/** Games, byes, projections, and stats for a week, scored with the league's settings. */
export async function loadWeekData(
  ctx: Ctx,
  league: League,
  week: number,
  playerIds: readonly string[]
): Promise<WeekData> {
  const { reference } = ctx.data;
  const now = ctx.clock.now();
  const [games, season, snapshot, lines, stored] = await Promise.all([
    weekGames(reference, league.season, week),
    reference.schedule.getSeason(league.season),
    reference.projections.latestSnapshot(league.season, week, now),
    reference.stats.getWeek(league.season, week),
    reference.nflGames.get(league.season, week)
  ]);
  // Above 100 players (the player market) one partition query beats batched point reads.
  const projections =
    snapshot === null
      ? []
      : await reference.projections.getLines(snapshot, playerIds.length > 100 ? undefined : playerIds);
  const score = (stats: Record<string, number>) => scorePlayer(league.settings, stats).points;
  const wanted = new Set(playerIds);
  const mine = lines.filter((l) => wanted.has(l.playerId));
  // Only scheduled games: a team without one is on bye, as the lock checks see it.
  const view = nflWeekView(league.season, week, games, stored, now);
  return {
    games: gamesByTeam(games),
    opponents: new Map<string, { team: string; home: boolean }>(
      games.flatMap((g): [string, { team: string; home: boolean }][] => [
        [g.homeTeam, { team: g.awayTeam, home: true }],
        [g.awayTeam, { team: g.homeTeam, home: false }]
      ])
    ),
    nflGames: view.games.filter((g) => g.gameId !== null),
    byes: season?.byes ?? {},
    projected: new Map(projections.map((l) => [l.playerId, score(l.stats)])),
    actual: new Map(mine.map((l) => [l.playerId, score(l.stats)])),
    stats: new Map(mine.map((l) => [l.playerId, l.stats]))
  };
}

const SLOT_ORDER = new Map(ROSTER_SLOTS.map((slot, i) => [slot, i]));

/** One row per lineup entry, starters first in slot order, then bench and IR. */
export function rosterEntries(
  lineup: readonly LineupEntry[],
  players: ReadonlyMap<string, Player>,
  week: WeekData,
  now: Date,
  /** League settings for `eligibleSlots`; pass them for detailed entries. */
  detail: Pick<LeagueSettings, 'roster'> | null = null
): RosterEntry[] {
  return lineup
    .map((e) => {
      const player = players.get(e.playerId);
      const team = player?.team ?? null;
      const ref =
        player === undefined
          ? { id: e.playerId, name: e.playerId, team: null, position: 'WR' as const }
          : toPlayerDetail(player, detail !== null);
      const kickoff = playerKickoff({ nflTeam: team }, week.games);
      const status = player === undefined ? ('na' as const) : playerStatus(player);
      const game = playerGame(team, week.nflGames, now, { finalAfterMs: ASSUME_FINAL_AFTER_MS });
      const projectedPoints = week.projected.get(e.playerId) ?? null;
      const points = week.actual.get(e.playerId) ?? null;
      const started = game.state === 'live' || game.state === 'final';
      return {
        player: ref,
        slot: e.slot,
        status,
        injuryStatus: player?.injuryStatus ?? null,
        byeWeek: team === null ? null : (week.byes[team] ?? null),
        onBye: isOnBye({ nflTeam: team }, week.games),
        kickoff: kickoff?.toISOString() ?? null,
        opponent: team === null ? null : (week.opponents.get(team) ?? null),
        locked: isPlayerLocked({ nflTeam: team }, week.games, now),
        projectedPoints,
        points,
        game,
        expectedPoints:
          projectedPoints === null && points === null
            ? null
            : roundPoints(
                forecastPlayer({
                  playerId: e.playerId,
                  slot: e.slot,
                  positions: [ref.position],
                  status,
                  game: game.state,
                  progress: game.progress,
                  projected: projectedPoints,
                  actual: points
                }).mean
              ),
        statLine: started ? statLine(ref.position, week.stats.get(e.playerId)) : null,
        ...(detail === null
          ? {}
          : {
              eligibleSlots:
                player === undefined
                  ? []
                  : eligibleStarterSlots([player.position]).filter((slot) => slotCount(detail, slot) > 0)
            })
      };
    })
    .sort(
      (a, b) =>
        (SLOT_ORDER.get(a.slot) ?? 0) - (SLOT_ORDER.get(b.slot) ?? 0) ||
        a.player.name.localeCompare(b.player.name)
    );
}

/** The sum of the starters' points so far. */
export function startersTotal(entries: readonly RosterEntry[]): number {
  const cents = entries
    .filter((e) => isStarterSlot(e.slot))
    .reduce((sum, e) => sum + Math.round((e.points ?? 0) * 100), 0);
  return cents / 100;
}

/** Lineup rule warnings as response warnings. */
export function issueWarnings(issues: readonly RuleIssue[]): Warning[] {
  return issues.map((issue) => ({ code: issue.code, message: `${issue.message} ${issue.fix}` }));
}
