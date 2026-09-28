import {
  firstKickoff,
  weekEndsAt,
  scorePlayer,
  tradeValue,
  type PlayerProjections,
  type RosteredPlayer,
  type Trade,
  type TradeContext,
  type TradeValueResult
} from '@fantasy/core';
import type { EventPublisher } from '../events/publisher.js';
import type { Logger } from '../log.js';
import type { Player } from '../players/model.js';
import type { ReferenceStore } from '../repos/reference.js';
import type { League, Repos, Team } from '../repos/types.js';
import { STATS_GAME_DURATION_MS } from '../season/window.js';
import { gamesByTeam, resolveWeekLineups, toRosterPlayer, weekGames } from '../season/lineups.js';

/**
 * What a trade decision needs to know about the league right now: every team's players with their
 * slots this week (lineups reconciled with the rosters), the week's games (for locks and the
 * deadline), and projections for the trade value math. Operations and the scheduled trade
 * handlers both build it, so they take plain dependencies rather than a request context.
 */

export interface TradeDeps {
  repos: Repos;
  reference: ReferenceStore;
  events: EventPublisher;
  log: Logger;
}

export interface TradeWorld {
  league: League;
  teams: Team[];
  week: number;
  players: Map<string, Player>;
  /** Core's trade context: every team's roster with slots, this week's games, and now. */
  context: TradeContext & { rosters: Record<string, RosteredPlayer[]> };
}

/** The league week trades are judged in. */
export function tradeWeek(league: League): number {
  return league.week ?? league.settings.schedule.startWeek;
}

export async function loadTradeWorld(
  deps: Pick<TradeDeps, 'repos' | 'reference'>,
  league: League,
  now: Date,
  teams?: Team[]
): Promise<TradeWorld> {
  const week = tradeWeek(league);
  const allTeams = teams ?? (await deps.repos.teams.list(league.id));
  const [games, stored, lineups] = await Promise.all([
    weekGames(deps.reference, league.season, week),
    deps.repos.players.getMany(allTeams.flatMap((t) => t.roster)),
    resolveWeekLineups(deps.repos, allTeams, week)
  ]);
  const players = new Map(stored.map((p) => [p.id, p]));
  const rosters: Record<string, RosteredPlayer[]> = {};
  for (const team of allTeams) {
    rosters[team.id] = (lineups.get(team.id)?.entries ?? []).map((e) => ({
      ...toRosterPlayer(e.playerId, players.get(e.playerId)),
      slot: e.slot
    }));
  }
  return {
    league,
    teams: allTeams,
    week,
    players,
    context: { now: now.toISOString(), currentWeek: week, games: gamesByTeam(games), rosters }
  };
}

/** The next lineup lock: the next kickoff after `now` this week or next week, or null. */
export async function nextLockAt(
  reference: ReferenceStore,
  league: League,
  now: Date
): Promise<string | null> {
  const week = tradeWeek(league);
  for (const w of [week, week + 1]) {
    const upcoming = (await weekGames(reference, league.season, w))
      .map((g) => Date.parse(g.kickoff))
      .filter((at) => at > now.getTime());
    if (upcoming.length > 0) return new Date(Math.min(...upcoming)).toISOString();
  }
  return null;
}

/** The trade deadline: the first kickoff of `trades.deadlineWeek`, or null without a schedule. */
export async function tradeDeadlineAt(reference: ReferenceStore, league: League): Promise<string | null> {
  return firstKickoff(await weekGames(reference, league.season, league.settings.trades.deadlineWeek));
}

/** Retry spacing when the week is over but the league has not rolled to the next week yet. */
export const LOCK_RETRY_MS = 30 * 60 * 1000;

/**
 * When this week's player locks release: the end of the week's last game (the weekly rollover
 * follows), or a short retry when that has already passed or there is no schedule.
 */
export async function locksReleaseAt(reference: ReferenceStore, league: League, now: Date): Promise<string> {
  const ends = weekEndsAt(await weekGames(reference, league.season, tradeWeek(league)), STATS_GAME_DURATION_MS);
  const retry = now.getTime() + LOCK_RETRY_MS;
  return new Date(ends === null ? retry : Math.max(Date.parse(ends), retry)).toISOString();
}

/** Weeks the trade value math looks ahead (this week and the next three). */
export const VALUE_WEEKS = 4;

export interface TradeProjections {
  table: PlayerProjections;
  fromWeek: number;
  toWeek: number;
}

/**
 * Projected points for `playerIds` over the valuation weeks, scored with league settings. A week
 * without a projection snapshot yet repeats the latest earlier week's numbers, so rest-of-season
 * value is a flat estimate rather than zero.
 */
export async function loadProjections(
  reference: ReferenceStore,
  league: League,
  playerIds: readonly string[],
  now: Date
): Promise<TradeProjections> {
  const fromWeek = tradeWeek(league);
  const toWeek = Math.max(fromWeek, Math.min(fromWeek + VALUE_WEEKS - 1, league.settings.playoffs.endWeek));
  const table: Record<string, Record<number, number>> = {};
  let previous = new Map<string, number>();
  for (let week = fromWeek; week <= toWeek; week++) {
    const snapshot = await reference.projections.latestSnapshot(league.season, week, now);
    const points =
      snapshot === null
        ? previous
        : new Map(
            (await reference.projections.getLines(snapshot, playerIds)).map((l) => [
              l.playerId,
              scorePlayer(league.settings, l.stats).points
            ])
          );
    for (const [playerId, pts] of points) (table[playerId] ??= {})[week] = pts;
    previous = points;
  }
  return { table, fromWeek, toWeek };
}

/** The trade value math (#42) for a trade against the current rosters. */
export function valueTrade(
  world: TradeWorld,
  trade: Pick<Trade, 'sides'>,
  projections: TradeProjections
): TradeValueResult {
  return tradeValue(world.league.settings, world.context.rosters, trade, projections.table, {
    fromWeek: projections.fromWeek,
    toWeek: projections.toWeek
  });
}

/** Points a player projects over the valuation weeks. */
export function horizonPoints(projections: TradeProjections, playerId: string): number {
  const weeks = projections.table[playerId] ?? {};
  let total = 0;
  for (let w = projections.fromWeek; w <= projections.toWeek; w++) total += weeks[w] ?? 0;
  return Math.round(total * 100) / 100;
}
