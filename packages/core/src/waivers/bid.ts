/**
 * A FAAB bid for a waiver target, for agents (the deterministic half of the waiver decision).
 *
 * The bid is a share of the FAAB left, growing with the weekly points the pickup adds over the
 * player it replaces (`gain`), capped at `MAX_SHARE` of the budget so one claim never empties it:
 *
 *   share = min(gain / FULL_VALUE_GAIN, 1) × MAX_SHARE × (0.5 + aggressiveness)
 *
 * `aggressiveness` (0-1) is the archetype's `waiverAggressiveness`: a waiver hawk at 0.95 bids
 * almost three times what a patient manager at 0.1 does. `noise` (a multiplier around 1, from the
 * difficulty's `valuationNoise`) makes weaker agents misjudge value. The result is a whole number of
 * dollars from `minBid` to `faabRemaining`; a pickup with no gain bids `minBid`.
 */
export interface FaabBidInput {
  /** Projected weekly points the pickup adds over the dropped (or weakest) player. */
  gain: number;
  faabRemaining: number;
  /** 0 (patient) to 1 (bids big on every breakout). */
  aggressiveness: number;
  /** Multiplier on the gain, e.g. 0.9 to 1.1. Defaults to 1. */
  noise?: number;
  /** 0 when the league allows $0 bids, else 1. */
  minBid?: number;
}

/** Weekly points over replacement at which a pickup earns the full share. */
export const FULL_VALUE_GAIN = 10;
/** The most of the remaining budget one bid may use. */
export const MAX_SHARE = 0.4;

export function suggestFaabBid(input: FaabBidInput): number {
  const budget = Math.max(0, Math.floor(input.faabRemaining));
  const minBid = Math.min(Math.max(0, Math.floor(input.minBid ?? 0)), budget);
  const gain = Math.max(0, input.gain * (input.noise ?? 1));
  if (!Number.isFinite(gain) || gain === 0) return minBid;
  const aggressiveness = Math.min(1, Math.max(0, input.aggressiveness));
  const share = Math.min(gain / FULL_VALUE_GAIN, 1) * MAX_SHARE * (0.5 + aggressiveness);
  return Math.min(budget, Math.max(minBid, Math.round(budget * share)));
}
