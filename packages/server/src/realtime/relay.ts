import { EVENT_SOURCE, type FantasyEventType } from '../events/publisher.js';
import { eventDetail, eventLeagueIds, type BusEvent } from '../events/bus.js';
import type { Logger } from '../log.js';
import { GLOBAL_TOPIC, leagueTopic, type Realtime, type RealtimeMessage } from './realtime.js';

/**
 * The realtime publisher (issue #68): league events from the bus, pushed to Momento Topics so open
 * browsers update without polling. The event detail passes through untouched, so the streams that
 * emit these events own their shape. Events about a league go to that league's topic; events with
 * no league (the live-stats job's `Scores Updated`) go to the global topic.
 *
 * Only trade events the whole league may see are relayed: an accepted trade (which the league then
 * reviews), and its processing or veto. Offers, counters, rejections, and expiries stay between the
 * two teams (Yahoo shows pending offers only to them), and the league topic reaches every member.
 */
export const RELAYED_EVENTS: readonly FantasyEventType[] = [
  'Chat Message Posted',
  'Scores Updated',
  'Draft Turn Started',
  'Draft Pick Made',
  'Draft Completed',
  'Waivers Processed',
  'Trade Accepted',
  'Trade Processed',
  'Trade Vetoed',
  'Week Provisionally Final',
  'Week Official Final',
  'Stat Correction Applied'
];

export interface RelayResult {
  topics: string[];
}

export async function relayEvent(realtime: Realtime, log: Logger, event: BusEvent): Promise<RelayResult> {
  const detailType = event['detail-type'];
  if (event.source !== EVENT_SOURCE || !RELAYED_EVENTS.includes(detailType as FantasyEventType)) {
    log.info('realtime relay ignored event', { detailType, source: event.source });
    return { topics: [] };
  }
  const detail = eventDetail(event);
  const leagueIds = eventLeagueIds(detail);
  const deliveries: { topic: string; message: RealtimeMessage }[] = [];
  if (detailType === 'Chat Message Posted') {
    const message = detail.message;
    if (leagueIds.length === 1 && message !== null && typeof message === 'object') {
      const leagueId = leagueIds[0] as string;
      deliveries.push({
        topic: leagueTopic(leagueId),
        message: { type: 'chat', leagueId, message: message as Record<string, unknown> }
      });
    }
  } else {
    const base = { type: 'event' as const, detailType, eventId: event.id, time: event.time ?? null, detail };
    if (leagueIds.length === 0)
      deliveries.push({ topic: GLOBAL_TOPIC, message: { ...base, leagueId: null } });
    for (const leagueId of leagueIds) {
      deliveries.push({ topic: leagueTopic(leagueId), message: { ...base, leagueId } });
    }
  }
  for (const delivery of deliveries) await realtime.publish(delivery.topic, delivery.message);
  const topics = deliveries.map((d) => d.topic);
  log.info('realtime relay published', { detailType, eventId: event.id, topics });
  return { topics };
}
