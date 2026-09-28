import type { PlayerStatus } from '../rules/positions.js';
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
