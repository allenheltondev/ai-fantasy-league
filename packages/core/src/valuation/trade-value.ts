import type { LeagueSettings } from '../rules/settings.js';
import { roundPoints } from '../scoring/engine.js';
import { applyTrade, type RosteredPlayer, type TeamRosters, type Trade } from '../trades/trade.js';
import { optimizeLineup } from './optimizer.js';
import {
  playerValue,
  replacementLevels,
  weekProjections,
  type PlayerProjections,
  type ReplacementLevels,
  type ValuationOptions,
  type ValuedPlayer
} from './value.js';

export interface LopsidedThreshold {
  /** Gap in rest-of-season best-lineup points between the two sides' gains. Default 30. */
  lineupPoints?: number;
  /** Gap in total player value (sum of positive VORP) between the two sides' gains. Default 30. */
  value?: number;
}

export const DEFAULT_LOPSIDED_THRESHOLD: Required<LopsidedThreshold> = { lineupPoints: 30, value: 30 };

export interface TradeValueOptions extends ValuationOptions {
  /** Replacement levels; derived from every rostered player when omitted. */
  replacement?: ReplacementLevels;
  threshold?: LopsidedThreshold;
}

export interface TradeSideValue {
  teamId: string;
  /** Sum over the weeks of the best legal lineup's projected points. */
  lineupBefore: number;
  lineupAfter: number;
  lineupDelta: number;
  /** Sum of each rostered player's value, counting negative values as 0 (a team can drop him). */
  valueBefore: number;
  valueAfter: number;
  valueDelta: number;
}

export interface TradeValueResult {
  sides: [TradeSideValue, TradeSideValue];
  /** How much more one side's lineup gains than the other's (absolute). */
  lineupGap: number;
  /** How much more one side's value gains than the other's (absolute). */
  valueGap: number;
  /** The team with the larger combined gain, or null when even. */
  favors: string | null;
  /** True when either gap reaches its threshold. Used to block lopsided agent-to-agent trades. */
  lopsided: boolean;
}

/** Best-lineup projected points summed over the valuation weeks. */
function seasonLineupPoints(
  settings: Pick<LeagueSettings, 'roster'>,
  roster: readonly RosteredPlayer[],
  projections: PlayerProjections,
  options: ValuationOptions
): number {
  const previousLineup = roster.map((p) => ({ playerId: p.playerId, slot: p.slot }));
  let total = 0;
  for (let week = options.fromWeek; week <= options.toWeek; week++) {
    // Statuses describe this week only; later weeks rely on the projections alone.
    const players =
      week === options.fromWeek ? roster : roster.map((p) => ({ ...p, status: 'active' as const }));
    total += optimizeLineup(settings, players, weekProjections(projections, week), {
      previousLineup
    }).projectedPoints;
  }
  return total;
}

function totalValue(
  roster: readonly RosteredPlayer[],
  projections: PlayerProjections,
  options: ValuationOptions & { replacement: ReplacementLevels }
): number {
  return roster.reduce((sum, p) => sum + Math.max(0, playerValue(p, projections, options).value), 0);
}

/**
 * What a trade does to each side: the change in rest-of-season best-lineup points and in total
 * player value, plus a `lopsided` flag when one side gains much more than the other. Players the
 * trade drops are gone from the "after" rosters. Lineups are solved with `optimizeLineup` each week,
 * with no lock or bye context: missing projections count as 0.
 */
export function tradeValue(
  settings: Pick<LeagueSettings, 'teamCount' | 'roster'>,
  rosters: TeamRosters,
  trade: Pick<Trade, 'sides'>,
  projections: PlayerProjections,
  options: TradeValueOptions
): TradeValueResult {
  const replacement =
    options.replacement ?? replacementLevels(settings, Object.values(rosters).flat(), projections, options);
  const valueOptions = { ...options, replacement };
  const after = applyTrade(rosters, trade).rosters;

  const side = (teamId: string): TradeSideValue => {
    const before = rosters[teamId] ?? [];
    const next = after[teamId] ?? [];
    const lineupBefore = roundPoints(seasonLineupPoints(settings, before, projections, options));
    const lineupAfter = roundPoints(seasonLineupPoints(settings, next, projections, options));
    const valueBefore = roundPoints(totalValue(before, projections, valueOptions));
    const valueAfter = roundPoints(totalValue(next, projections, valueOptions));
    return {
      teamId,
      lineupBefore,
      lineupAfter,
      lineupDelta: roundPoints(lineupAfter - lineupBefore),
      valueBefore,
      valueAfter,
      valueDelta: roundPoints(valueAfter - valueBefore)
    };
  };

  const a = side(trade.sides[0].teamId);
  const b = side(trade.sides[1].teamId);
  const lineupGap = roundPoints(Math.abs(a.lineupDelta - b.lineupDelta));
  const valueGap = roundPoints(Math.abs(a.valueDelta - b.valueDelta));
  const net = a.lineupDelta + a.valueDelta - (b.lineupDelta + b.valueDelta);
  const threshold = { ...DEFAULT_LOPSIDED_THRESHOLD, ...options.threshold };
  return {
    sides: [a, b],
    lineupGap,
    valueGap,
    favors: net > 0 ? a.teamId : net < 0 ? b.teamId : null,
    lopsided: lineupGap >= threshold.lineupPoints || valueGap >= threshold.value
  };
}

export interface TradePlayersSide {
  teamId: string;
  /** Value of the players this team received (each counted at 0 or more). */
  received: number;
  /** Value of the players this team sent away or dropped to make room. */
  given: number;
  /** `received - given`: positive means the team won the trade on value. */
  valueDelta: number;
}

/**
 * Each side's player-value change from a trade, from the players in it alone: what a team received
 * minus what it sent and dropped, each player valued like `tradeValue` does (rest-of-season value
 * over replacement, never below 0). With the same replacement levels this equals `tradeValue`'s
 * `valueDelta`, but it needs no rosters, so it can value a trade long after it was processed.
 * Players missing from `players` count as 0.
 */
export function tradePlayersValue(
  trade: Pick<Trade, 'sides'>,
  players: Readonly<Record<string, ValuedPlayer>>,
  projections: PlayerProjections,
  options: ValuationOptions & { replacement: ReplacementLevels }
): [TradePlayersSide, TradePlayersSide] {
  const worth = (ids: readonly string[]) =>
    ids.reduce((sum, id) => {
      const player = players[id];
      return player === undefined ? sum : sum + Math.max(0, playerValue(player, projections, options).value);
    }, 0);
  const side = (i: 0 | 1): TradePlayersSide => {
    const own = trade.sides[i];
    const other = i === 0 ? trade.sides[1] : trade.sides[0];
    const received = roundPoints(worth(other.sends));
    const given = roundPoints(worth([...own.sends, ...own.drops]));
    return { teamId: own.teamId, received, given, valueDelta: roundPoints(received - given) };
  };
  return [side(0), side(1)];
}
