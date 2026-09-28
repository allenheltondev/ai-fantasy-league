import { EVENT_SOURCE, type FantasyEventType } from '../events/publisher.js';
import { eventDetail, eventLeagueIds, type BusEvent } from '../events/bus.js';
import type { Logger } from '../log.js';
import { GLOBAL_TOPIC, leagueTopic, teamTopic, type Realtime, type RealtimeMessage } from './realtime.js';

/**
 * The realtime publisher (issue #68): league events from the bus, pushed to Momento Topics so open
 * browsers update without polling. The event detail passes through untouched, so the streams that
 * emit these events own their shape. Events about a league go to that league's topic; events with
 * no league (the live-stats job's `Scores Updated`, and `NFL Games Updated`) go to the global topic.
 *
 * Only trade events the whole league may see go to the league topic: an accepted trade (which the
 * league then reviews), and its processing or veto. Offers, counters, rejections, expiries, and
 * withdrawals stay between the two teams (Yahoo shows pending offers only to them): they go only to
 * those two teams' private topics (`teamTopic`), never to the league topic, which reaches every
 * member.
 *
 * Direct messages (chat rooms `dm-...`, #144) are the same: a `Chat Message Posted` in a DM goes to
 * its two teams' topics (`detail.teamIds`) and never to the league topic. A DM message without its
 * two teams is dropped rather than risk the league topic.
 *
 * Per-team results also go to the team's own topic: each team's waiver awards from
 * `Waivers Processed` (the league topic still gets the whole run, which everyone may see).
 */
export const RELAYED_EVENTS: readonly FantasyEventType[] = [
  'Chat Message Posted',
  'Scores Updated',
  'NFL Games Updated',
  'Draft Turn Started',
  'Draft Pick Made',
  'Draft Completed',
  'Draft Paused',
  'Draft Resumed',
  'Waivers Processed',
  'Trade Accepted',
  'Trade Processed',
  'Trade Vetoed',
  'Week Provisionally Final',
  'Week Official Final',
  'Stat Correction Applied'
];

/** Events only the two teams in a trade may see: relayed to their private topics alone. */
export const TEAM_ONLY_EVENTS: readonly FantasyEventType[] = [
  'Trade Proposed',
  'Trade Countered',
  'Trade Rejected',
  'Trade Expired',
  'Trade Withdrawn'
];

export interface RelayResult {
  topics: string[];
}

export async function relayEvent(realtime: Realtime, log: Logger, event: BusEvent): Promise<RelayResult> {
  const detailType = event['detail-type'];
  const teamOnly = TEAM_ONLY_EVENTS.includes(detailType as FantasyEventType);
  if (
    event.source !== EVENT_SOURCE ||
    (!teamOnly && !RELAYED_EVENTS.includes(detailType as FantasyEventType))
  ) {
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
      const chat = { type: 'chat' as const, leagueId, message: message as Record<string, unknown> };
      const roomId = [detail.roomId, (message as { roomId?: unknown }).roomId].find(isId);
      if (roomId?.startsWith('dm-') === true) {
        const teams = Array.isArray(detail.teamIds) ? [...new Set(detail.teamIds.filter(isId))] : [];
        if (teams.length === 2) {
          for (const teamId of teams) deliveries.push({ topic: teamTopic(leagueId, teamId), message: chat });
        }
      } else {
        deliveries.push({ topic: leagueTopic(leagueId), message: chat });
      }
    }
  } else if (teamOnly) {
    const base = { type: 'event' as const, detailType, eventId: event.id, time: event.time ?? null, detail };
    const teams = new Set([detail.fromTeamId, detail.toTeamId].filter(isId));
    if (leagueIds.length === 1) {
      const leagueId = leagueIds[0] as string;
      for (const teamId of teams) {
        deliveries.push({ topic: teamTopic(leagueId, teamId), message: { ...base, leagueId } });
      }
    }
  } else {
    const base = { type: 'event' as const, detailType, eventId: event.id, time: event.time ?? null, detail };
    if (leagueIds.length === 0)
      deliveries.push({ topic: GLOBAL_TOPIC, message: { ...base, leagueId: null } });
    for (const leagueId of leagueIds) {
      deliveries.push({ topic: leagueTopic(leagueId), message: { ...base, leagueId } });
    }
    if (detailType === 'Waivers Processed' && leagueIds.length === 1) {
      deliveries.push(...teamAwardDeliveries(leagueIds[0] as string, base));
    }
  }
  for (const delivery of deliveries) await realtime.publish(delivery.topic, delivery.message);
  const topics = deliveries.map((d) => d.topic);
  log.info('realtime relay published', { detailType, eventId: event.id, topics });
  return { topics };
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Each team's own waiver awards, on its private topic. */
function teamAwardDeliveries(
  leagueId: string,
  base: Omit<Extract<RealtimeMessage, { type: 'event' }>, 'leagueId'>
): { topic: string; message: RealtimeMessage }[] {
  const awarded = Array.isArray(base.detail.awarded) ? base.detail.awarded : [];
  const byTeam = new Map<string, unknown[]>();
  for (const award of awarded) {
    const teamId = (award as { teamId?: unknown } | null)?.teamId;
    if (!isId(teamId)) continue;
    byTeam.set(teamId, [...(byTeam.get(teamId) ?? []), award]);
  }
  return [...byTeam].map(([teamId, mine]) => ({
    topic: teamTopic(leagueId, teamId),
    message: { ...base, leagueId, detail: { ...base.detail, teamId, awarded: mine } }
  }));
}
