import { playerGame, seasonPoints, type LeagueSettings, type PlayerGame } from '@fantasy/core';
import type { Ctx } from '../context.js';
import type { LeagueAccess } from '../league/access.js';
import { ASSUME_FINAL_AFTER_MS, loadWeekData } from '../operations/season/views.js';
import { chooseLookback } from '../operations/research/get-trending-players.js';
import { playerStatus } from '../season/lineups.js';
import { matchPlayers } from './match.js';
import { leagueStandings, matchesAvailability, type AvailabilityFilter } from './availability.js';
import type { PlayerStanding } from '../waivers/rosters.js';
import type { Player, Position } from './model.js';

/**
 * The player market (#205): every player a league could want, with the numbers a pickup decision
 * needs (this week's projection and game, the rest-of-season projection, this season's points and
 * average, and the crowd's adds and drops), sorted and paged. It reads whole partitions, never one
 * player at a time: the cached player index, the week's projection snapshot, the season's
 * projection set, one stats partition per week played, and the latest trending snapshots.
 */

export const MARKET_SORTS = [
  'projected_week',
  'projected_ros',
  'season_points',
  'average',
  'trending',
  'rank'
] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

/** Positions a FLEX (W/R/T) slot takes. */
export const FLEX_POSITIONS: readonly Position[] = ['RB', 'WR', 'TE'];

/** The trending window the market reads: the day of adds and drops. */
export const TREND_LOOKBACK_HOURS = 24;

export interface MarketQuery {
  q?: string | undefined;
  position?: Position | 'FLEX' | undefined;
  team?: string | undefined;
  availability: AvailabilityFilter | 'all';
  healthyOnly: boolean;
  sort: MarketSort;
  offset: number;
  limit: number;
}

export interface MarketRow {
  player: Player;
  standing: PlayerStanding;
  status: ReturnType<typeof playerStatus>;
  byeWeek: number | null;
  game: PlayerGame;
  projectedPoints: number | null;
  projectedRos: number | null;
  seasonPoints: number | null;
  average: number | null;
  games: number;
  trend: { adds: number; drops: number } | null;
}

export interface MarketPage {
  week: number;
  total: number;
  rows: MarketRow[];
  nextOffset: number | null;
  trendHours: number | null;
}

/** The players the query covers, before availability: a name search, or everyone on an NFL team. */
export function marketPool(
  index: readonly Player[],
  query: Pick<MarketQuery, 'q' | 'position' | 'team'>
): Player[] {
  const byPosition = (p: Player) =>
    query.position === undefined ||
    (query.position === 'FLEX' ? FLEX_POSITIONS.includes(p.position) : p.position === query.position);
  const byTeam = (p: Player) => query.team === undefined || p.team === query.team;
  // A name finds anyone, even a player without a team; browsing lists players on NFL teams.
  const found =
    query.q === undefined
      ? index.filter((p) => p.team !== null)
      : matchPlayers(index, { query: query.q }).map((m) => m.player);
  return found.filter((p) => byPosition(p) && byTeam(p));
}

/** The sort value of a row (higher first), or null to sort it last. */
export function sortValue(row: MarketRow, sort: MarketSort): number | null {
  switch (sort) {
    case 'projected_week':
      return row.projectedPoints;
    case 'projected_ros':
      return row.projectedRos;
    case 'season_points':
      return row.seasonPoints;
    case 'average':
      return row.average;
    case 'trending':
      return row.trend === null ? null : row.trend.adds - row.trend.drops;
    case 'rank':
      return row.player.rank === null ? null : -row.player.rank;
  }
}

/**
 * Orders rows best first by `sort`; rows without a value go last. Ties fall back to consensus rank,
 * then id, so the order is total and pages never overlap or skip a player.
 */
export function sortMarket(rows: readonly MarketRow[], sort: MarketSort): MarketRow[] {
  const rank = (r: MarketRow) => r.player.rank ?? Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort);
    const vb = sortValue(b, sort);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return vb - va;
    }
    return rank(a) - rank(b) || a.player.id.localeCompare(b.player.id);
  });
}

/** Adds and drops per player from the latest trending snapshots, or null with none stored. */
async function loadTrends(
  ctx: Pick<Ctx, 'data' | 'clock'>
): Promise<{ hours: number; of: (id: string) => { adds: number; drops: number } } | null> {
  const now = ctx.clock.now();
  const [adds, drops] = await Promise.all([
    ctx.data.reference.trending.latest('add', now),
    ctx.data.reference.trending.latest('drop', now)
  ]);
  const counts = (snapshot: typeof adds) => {
    const hours =
      snapshot === null
        ? null
        : chooseLookback(Object.keys(snapshot.lookbacks).map(Number), TREND_LOOKBACK_HOURS);
    const entries = hours === null ? [] : (snapshot?.lookbacks[String(hours)] ?? []);
    return { hours, by: new Map(entries.map((e) => [e.playerId, Math.round(e.count)])) };
  };
  const a = counts(adds);
  const d = counts(drops);
  const hours = a.hours ?? d.hours;
  if (hours === null) return null;
  return { hours, of: (id) => ({ adds: a.by.get(id) ?? 0, drops: d.by.get(id) ?? 0 }) };
}

/** This season's points per player under league scoring, from each played week's stats partition. */
async function loadSeasonStats(
  ctx: Pick<Ctx, 'data'>,
  settings: LeagueSettings,
  season: number,
  week: number
): Promise<Map<string, { points: number; games: number; ppg: number }>> {
  const weeks = Array.from({ length: week }, (_, i) => i + 1);
  const lines = (await Promise.all(weeks.map((w) => ctx.data.reference.stats.getWeek(season, w)))).flat();
  const byPlayer = new Map<string, { week: number; stats: Record<string, number> }[]>();
  for (const line of lines) {
    const list = byPlayer.get(line.playerId) ?? [];
    list.push({ week: line.week, stats: line.stats });
    byPlayer.set(line.playerId, list);
  }
  return new Map([...byPlayer].map(([id, weekly]) => [id, seasonPoints(settings, weekly)]));
}

/** Rest-of-season projected points per player: this week through week 18 of the season projection set. */
async function loadRestOfSeason(
  ctx: Pick<Ctx, 'data'>,
  settings: LeagueSettings,
  season: number,
  week: number,
  ids: readonly string[]
): Promise<Map<string, number>> {
  // Above 100 players one partition query beats batched point reads.
  const sets = await ctx.data.reference.seasons.get(
    'projections',
    season,
    ids.length > 100 ? undefined : ids
  );
  return new Map(
    sets.map((set) => [
      set.playerId,
      seasonPoints(
        settings,
        set.weeks.filter((w) => w.week >= week)
      ).points
    ])
  );
}

/** One page of the market for a league member. */
export async function loadMarket(ctx: Ctx, access: LeagueAccess, query: MarketQuery): Promise<MarketPage> {
  const { league } = access;
  const settings = league.settings;
  const week = league.week ?? settings.schedule.startWeek;
  const now = ctx.clock.now();
  const [index, standingOf] = await Promise.all([ctx.data.players.all(), leagueStandings(ctx, access)]);
  const pool = marketPool(index, query).filter((p) => {
    if (query.healthyOnly && playerStatus(p) !== 'active') return false;
    return query.availability === 'all' || matchesAvailability(standingOf(p), query.availability);
  });
  const ids = pool.map((p) => p.id);
  const [weekData, ros, season, trends] = await Promise.all([
    loadWeekData(ctx, league, week, ids),
    loadRestOfSeason(ctx, settings, league.season, week, ids),
    loadSeasonStats(ctx, settings, league.season, week),
    loadTrends(ctx)
  ]);
  const rows = pool.map((player): MarketRow => {
    const stats = season.get(player.id);
    const played = stats !== undefined && stats.games > 0;
    return {
      player,
      standing: standingOf(player),
      status: playerStatus(player),
      byeWeek: player.team === null ? null : (weekData.byes[player.team] ?? null),
      game: playerGame(player.team, weekData.nflGames, now, { finalAfterMs: ASSUME_FINAL_AFTER_MS }),
      projectedPoints: weekData.projected.get(player.id) ?? null,
      projectedRos: ros.get(player.id) ?? null,
      seasonPoints: played ? stats.points : null,
      average: played ? stats.ppg : null,
      games: stats?.games ?? 0,
      trend: trends === null ? null : trends.of(player.id)
    };
  });
  const sorted = sortMarket(rows, query.sort);
  const end = query.offset + query.limit;
  return {
    week,
    total: sorted.length,
    rows: sorted.slice(query.offset, end),
    nextOffset: end < sorted.length ? end : null,
    trendHours: trends?.hours ?? null
  };
}
