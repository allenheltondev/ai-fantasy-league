import {
  eligibleStarterSlots,
  isPlayerLocked,
  isOnBye,
  isStarterSlot,
  playerKickoff,
  PlayerStatusSchema,
  ROSTER_SLOTS,
  RosterSlotSchema,
  scorePlayer,
  slotCount,
  type LeagueSettings,
  type LineupEntry,
  type RuleIssue,
  type WeekGames
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { PlayerDetailSchema, toPlayerDetail, type Player } from '../../players/model.js';
import type { Warning } from '../../registry/operation.js';
import type { League } from '../../repos/types.js';
import { gamesByTeam, playerStatus, weekGames } from '../../season/lineups.js';

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
  locked: z.boolean().describe('True once his game has kicked off: he cannot change slots until next week.'),
  projectedPoints: z
    .number()
    .nullable()
    .describe('Projected points this week under league scoring, or null.'),
  points: z.number().nullable().describe('Points scored this week so far, or null before he has stats.'),
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
  /** NFL teams whose game this week is final. */
  finalTeams: ReadonlySet<string>;
  byes: Record<string, number>;
  projected: Map<string, number>;
  actual: Map<string, number>;
}

/** Games, byes, projections, and stats for a week, scored with the league's settings. */
export async function loadWeekData(
  ctx: Ctx,
  league: League,
  week: number,
  playerIds: readonly string[]
): Promise<WeekData> {
  const { reference } = ctx.data;
  const [games, season, snapshot, lines] = await Promise.all([
    weekGames(reference, league.season, week),
    reference.schedule.getSeason(league.season),
    reference.projections.latestSnapshot(league.season, week, ctx.clock.now()),
    reference.stats.getWeek(league.season, week)
  ]);
  const projections = snapshot === null ? [] : await reference.projections.getLines(snapshot, playerIds);
  const score = (stats: Record<string, number>) => scorePlayer(league.settings, stats).points;
  const wanted = new Set(playerIds);
  return {
    games: gamesByTeam(games),
    finalTeams: new Set(games.filter((g) => g.status === 'final').flatMap((g) => [g.homeTeam, g.awayTeam])),
    byes: season?.byes ?? {},
    projected: new Map(projections.map((l) => [l.playerId, score(l.stats)])),
    actual: new Map(lines.filter((l) => wanted.has(l.playerId)).map((l) => [l.playerId, score(l.stats)]))
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
      return {
        player: ref,
        slot: e.slot,
        status: player === undefined ? ('na' as const) : playerStatus(player),
        injuryStatus: player?.injuryStatus ?? null,
        byeWeek: team === null ? null : (week.byes[team] ?? null),
        onBye: isOnBye({ nflTeam: team }, week.games),
        kickoff: kickoff?.toISOString() ?? null,
        locked: isPlayerLocked({ nflTeam: team }, week.games, now),
        projectedPoints: week.projected.get(e.playerId) ?? null,
        points: week.actual.get(e.playerId) ?? null,
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
