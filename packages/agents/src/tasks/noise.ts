import { valuationNoiseMultiplier } from '@fantasy/core';
import type { TaskContext } from './kinds.js';

/**
 * An agent's valuation noise (the difficulty's `valuationNoise`: a weaker manager misjudges value)
 * for one thing it is valuing: a multiplier in [1 - noise, 1 + noise].
 *
 * It is keyed by what is being judged, never by the trigger: the agent, the league week, and the
 * subject, described by its content (an offer's teams, players, and round: `offerSubject`; a pair
 * of players; a waiver target). Never by a generated id: task ids come from event ids, and offer
 * and record ids from `ctx.ids`, which are UUIDs in production but a sequence in process (the
 * simulator, dev server, and tests), so noise keyed by them reshuffled every agent's judgment
 * whenever any change added unrelated activity. The same agent sees the same offer the same way
 * all week, whatever its id.
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

/**
 * What an offer is, as a noise subject: the two teams, the sorted players each side sends, and the
 * negotiation round (the week is in `judgmentNoise`'s own key). Trades carry no FAAB or picks.
 */
export function offerSubject(offer: {
  fromTeamId: string;
  toTeamId: string;
  fromSends: readonly string[];
  toSends: readonly string[];
  round: number;
}): string[] {
  const side = (ids: readonly string[]) => [...ids].sort().join(',');
  return [
    'offer',
    offer.fromTeamId,
    offer.toTeamId,
    side(offer.fromSends),
    side(offer.toSends),
    String(offer.round)
  ];
}
