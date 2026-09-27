import { z } from 'zod';
import type { ValuationWeights } from '../valuation/value.js';

/**
 * Strategy archetypes (SPEC §8). Each one bends the deterministic valuation (position weights, risk
 * tolerance, recency bias), sets how eagerly the agent works waivers and trades, and adds prompt
 * guidance for the judgment calls the model makes.
 */

export const ARCHETYPES = [
  'balanced',
  'zero_rb',
  'contrarian',
  'win_now',
  'analytics_only',
  'gut_feel_homer',
  'trade_happy',
  'waiver_hawk'
] as const;
export const ArchetypeSchema = z.enum(ARCHETYPES);
export type Archetype = z.infer<typeof ArchetypeSchema>;

export interface StrategyArchetype {
  id: Archetype;
  displayName: string;
  description: string;
  /** Passed straight to the core valuation (`playerValue`, `valuePlayers`, `tradeValue`). */
  valuation: Required<Pick<ValuationWeights, 'riskTolerance' | 'recencyBias'>> &
    Pick<ValuationWeights, 'positionWeights'>;
  /** 0 = rarely claims, 1 = claims every week and bids big. */
  waiverAggressiveness: number;
  /** 0 = only answers offers, 1 = proposes trades constantly. */
  tradeFrequency: number;
  /** Strategy instructions added to the system prompt. */
  promptGuidance: string;
}

export const STRATEGY_ARCHETYPES: Readonly<Record<Archetype, StrategyArchetype>> = {
  balanced: {
    id: 'balanced',
    displayName: 'Balanced',
    description: 'Best player available, sensible risk, steady moves.',
    valuation: { riskTolerance: 0.5, recencyBias: 0.2 },
    waiverAggressiveness: 0.5,
    tradeFrequency: 0.4,
    promptGuidance:
      'Take the best value available while keeping the starting lineup complete. Avoid big risks unless the upside is clear.'
  },
  zero_rb: {
    id: 'zero_rb',
    displayName: 'Zero RB',
    description: 'Loads up on elite receivers early and mines running backs late and off waivers.',
    valuation: { riskTolerance: 0.6, recencyBias: 0.1, positionWeights: { RB: 0.75, WR: 1.2, TE: 1.1 } },
    waiverAggressiveness: 0.7,
    tradeFrequency: 0.4,
    promptGuidance:
      'Prioritize wide receivers and an elite tight end early in the draft. Wait on running backs, then chase high-upside backs in later rounds and on waivers.'
  },
  contrarian: {
    id: 'contrarian',
    displayName: 'Contrarian',
    description: 'Fades the consensus and buys players everyone else is selling.',
    valuation: { riskTolerance: 0.75, recencyBias: 0 },
    waiverAggressiveness: 0.5,
    tradeFrequency: 0.5,
    promptGuidance:
      "Look for value the league is ignoring: buy low on slumping players with good underlying usage, and avoid overpaying for last week's breakout."
  },
  win_now: {
    id: 'win_now',
    displayName: 'Win Now',
    description: 'Maximizes this week and the next few, happily trading future value for points today.',
    valuation: { riskTolerance: 0.3, recencyBias: 0.8 },
    waiverAggressiveness: 0.7,
    tradeFrequency: 0.6,
    promptGuidance:
      'Optimize for the next few weeks. Trade future upside for proven production and start the highest floor available.'
  },
  analytics_only: {
    id: 'analytics_only',
    displayName: 'Analytics Only',
    description: 'Trusts projections and value math completely. Ignores narratives.',
    valuation: { riskTolerance: 0.5, recencyBias: 0.1 },
    waiverAggressiveness: 0.5,
    tradeFrequency: 0.3,
    promptGuidance:
      'Decide from projections, value over replacement, and the trade value numbers the tools return. Ignore hype and narratives; explain decisions with numbers.'
  },
  gut_feel_homer: {
    id: 'gut_feel_homer',
    displayName: 'Gut-Feel Homer',
    description: 'Goes with the gut and favors players from a favorite team.',
    valuation: { riskTolerance: 0.8, recencyBias: 0.5 },
    waiverAggressiveness: 0.4,
    tradeFrequency: 0.3,
    promptGuidance:
      'Trust your instincts. Lean toward players you "believe in" and your favorite NFL team, but never start someone who is out or on bye.'
  },
  trade_happy: {
    id: 'trade_happy',
    displayName: 'Trade Happy',
    description: 'Always working the phones. Proposes and counters trades constantly.',
    valuation: { riskTolerance: 0.55, recencyBias: 0.3 },
    waiverAggressiveness: 0.3,
    tradeFrequency: 0.9,
    promptGuidance:
      'Look for trades every chance you get. Target teams with needs you can fill, counter rather than reject, and preview every trade before proposing it.'
  },
  waiver_hawk: {
    id: 'waiver_hawk',
    displayName: 'Waiver Hawk',
    description: 'Lives on the waiver wire, bidding aggressively on breakouts.',
    valuation: { riskTolerance: 0.6, recencyBias: 0.6 },
    waiverAggressiveness: 0.95,
    tradeFrequency: 0.2,
    promptGuidance:
      'Scan trending players and news every waiver window. Bid aggressively on emerging starters and cut bench players who are not contributing.'
  }
};

export function getArchetype(id: Archetype): StrategyArchetype {
  return STRATEGY_ARCHETYPES[id];
}
