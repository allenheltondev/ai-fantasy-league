import type { PlayerStatus } from '../rules/positions.js';
import { DEFAULT_LOPSIDED_THRESHOLD } from '../valuation/trade-value.js';
import { riskMultiplier } from '../valuation/value.js';
import type { ResolvedAgentConfig } from './seat-config.js';

/**
 * How an agent's archetype and difficulty turn into behavior the deterministic code can apply
 * (issue #73). The model still makes the judgment calls; these numbers shape what it is offered
 * and what the fallbacks do, so two archetypes behave measurably differently even without a model.
 *
 * - Draft ranking: `positionWeights` (applied by the draft task's `agentRank`).
 * - Waiver aggressiveness: how small an upgrade is still worth a claim (`waiverMinGain`), and how
 *   much FAAB to bid (`suggestFaabBid` with `waiverAggressiveness`).
 * - Lineup risk: how much an injury designation discounts a starter (`lineupProjection`).
 * - Trade appetite: how often to propose, how much edge to demand, and how many counters to make
 *   (`tradeAppetite`, for the trade task kinds).
 * - Trade votes: how one-sided another pair's trade must be before the agent votes to veto it
 *   (`tradeVetoVote`, for the trade_vote task kind).
 *
 * What an agent's history with other teams may change (#210), the design decision in one place:
 *
 * - Dialogue: the relationship stance (`relationshipsFrom`: warmth, rivalry, grudge, repair, and
 *   decay), the records behind it, and the agent's own beliefs are in its prompt (`summarizeMemory`),
 *   so it talks like it remembers: warm after a fair trade, needling after a close game, cold while a
 *   grudge lasts, softer once a grudge has cooled or been mended.
 * - Bounded decisions: decision tasks see the same stance (built from league records only, never from
 *   chat text), so the model may lean on it when it chooses among options this code already vetted:
 *   which vetted trade candidate to send, whether to take an offer that already clears the accept
 *   floor, what to write in a note. The options, the accept bar and floor, the persuasion allowance
 *   (#196), and every legality check are computed without it.
 * - Fixed: authorization, legality, roster and economic floors, veto votes (`tradeVetoVote`), and
 *   the deterministic fallbacks never read relationships or notes.
 * - Strategy adaptation from outcomes: none yet. Nothing in this module moves with results, and a
 *   note the model wrote cannot change it. A future adaptation must be an explicit, bounded function
 *   of records (never beliefs), added here, and measured by a controlled evaluation first (#211).
 * - Situational adaptation (#217): `situation.ts` bends three of these levers (trade-look chance,
 *   waiver aggressiveness, lineup risk tolerance) within hard caps, from finalized standings and
 *   injury designations only. Trade appetite, floors, and limits here are never among them.
 */

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
const round2 = (x: number) => Math.round(x * 100) / 100;

/** The smallest projected weekly gain worth a waiver claim: a waiver hawk claims marginal upgrades. */
export function waiverMinGain(aggressiveness: number): number {
  return round2(1.5 - 1.4 * clamp01(aggressiveness));
}

/**
 * A player's projected points for lineup decisions, discounted by his injury status and the
 * archetype's risk tolerance: a win-now manager benches a questionable player a gut-feel homer starts.
 */
export function lineupProjection(points: number, status: PlayerStatus, riskTolerance: number): number {
  return round2(points * riskMultiplier(status, riskTolerance));
}

export interface TradeAppetite {
  /** Trades the agent may propose on its own per week; 0 means it only answers offers. */
  proposalsPerWeek: number;
  /**
   * The value edge (in the units of core `tradeValue`) the agent wants before it accepts. Negative
   * means it will give up a little value to get a deal done.
   */
  acceptEdge: number;
  /** Counter-offers per negotiation: the difficulty's `negotiationRounds` lever. */
  maxCounters: number;
}

/** The accept edge for a trade appetite: 5 for a cautious agent (0), down to -5 for a trade addict (1). */
export function tradeAcceptEdge(tradeFrequency: number): number {
  return Math.round((0.5 - clamp01(tradeFrequency)) * 100) / 10;
}

/** Trade behavior for a resolved agent config. The trade task kinds read it; this module decides nothing. */
export function tradeAppetite(config: Pick<ResolvedAgentConfig, 'tradeFrequency' | 'levers'>): TradeAppetite {
  const frequency = clamp01(config.tradeFrequency);
  return {
    proposalsPerWeek: Math.round(frequency * 4),
    acceptEdge: tradeAcceptEdge(frequency),
    maxCounters: config.levers.negotiationRounds
  };
}

/** The trade frequency from which an archetype takes an early trade look right after the draft (#175). */
export const EARLY_TRADE_MIN_FREQUENCY = 0.6;

/**
 * True for archetypes with a high trade appetite (trade-happy and up): right after the draft they
 * shop for one trade instead of waiting for the first weekly rollover.
 */
export function wantsEarlyTradeLook(config: Pick<ResolvedAgentConfig, 'tradeFrequency'>): boolean {
  return clamp01(config.tradeFrequency) >= EARLY_TRADE_MIN_FREQUENCY;
}

/** The fairness numbers of a trade (preview_trade `fairness`, core `tradeValue`). */
export interface TradeFairness {
  lineupGap: number;
  valueGap: number;
  lopsided: boolean;
}

/**
 * The share of the lopsided threshold at which the agent vetoes another pair's trade: 0.7 for a
 * cautious archetype (it vetoes trades that are nearly lopsided too), up to 1 for a trade addict (it
 * vetoes only what the trade value math calls lopsided).
 */
export function tradeVetoRatio(tradeFrequency: number): number {
  return round2(0.7 + 0.3 * clamp01(tradeFrequency));
}

/**
 * The agent's vote on a trade other teams made (league-vote review): veto when the trade value math
 * calls it lopsided, and, depending on the archetype, when it comes close. Deterministic: the model
 * may explain the vote but never changes it.
 */
export function tradeVetoVote(
  fairness: TradeFairness,
  config: Pick<ResolvedAgentConfig, 'tradeFrequency'>
): { veto: boolean; ratio: number; severity: number } {
  const ratio = tradeVetoRatio(config.tradeFrequency);
  const severity = round2(
    Math.max(
      Math.abs(fairness.lineupGap) / DEFAULT_LOPSIDED_THRESHOLD.lineupPoints,
      Math.abs(fairness.valueGap) / DEFAULT_LOPSIDED_THRESHOLD.value
    )
  );
  return { veto: fairness.lopsided || severity >= ratio, ratio, severity };
}

/** The archetype-level behavior numbers for one agent, as the activity views and prompts show them. */
export interface AgentBehavior {
  waiverMinGain: number;
  waiverAggressiveness: number;
  riskTolerance: number;
  trade: TradeAppetite;
}

export function agentBehavior(config: ResolvedAgentConfig): AgentBehavior {
  return {
    waiverMinGain: waiverMinGain(config.waiverAggressiveness),
    waiverAggressiveness: config.waiverAggressiveness,
    riskTolerance: config.valuation.riskTolerance ?? 0.5,
    trade: tradeAppetite(config)
  };
}
