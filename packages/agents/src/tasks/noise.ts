import { valuationNoiseMultiplier } from '@fantasy/core';
import type { TaskContext } from './kinds.js';

/**
 * An agent's valuation noise (the difficulty's `valuationNoise`: a weaker manager misjudges value)
 * for one thing it is valuing: a multiplier in [1 - noise, 1 + noise].
 *
 * It is keyed by what is being judged, never by the trigger: the agent, the league week, and the
 * subject (a trade id and round, a pair of players, a waiver target). The same agent sees the same
 * trade the same way all week, however many other events happened before it. Task ids come from
 * event ids, which are EventBridge UUIDs in production and positions in the log in process (the
 * simulator, dev server, and tests), so noise keyed by them reshuffled every agent's judgment
 * whenever any change added an unrelated event.
 */
export function judgmentNoise(
  ctx: Pick<TaskContext, 'config' | 'seat' | 'league'>,
  ...subject: readonly (string | number)[]
): number {
  return valuationNoiseMultiplier(
    ctx.config.levers.valuationNoise,
    `${ctx.seat.agentId}:week-${ctx.league.week ?? 0}`,
    subject.join('|')
  );
}
