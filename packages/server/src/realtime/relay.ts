import { EVENT_SOURCE, type FantasyEventType } from '../events/publisher.js';
import { eventDetail, eventLeagueIds, type BusEvent } from '../events/bus.js';
import type { Logger } from '../log.js';
import type { TeamRepository } from '../repos/types.js';
import {
  GLOBAL_CHANNEL,
  leagueChannel,
  seatTenureKey,
  teamChannel,
  type Realtime,
  type RealtimeMessage
} from './realtime.js';

/**
 * The realtime publisher (issue #68): league events from the bus, pushed to AppSync Events channels
 * so open browsers update without polling. The event detail passes through untouched, so the streams
 * that emit these events own their shape. Events about a league go to that league's channel; events
 * with no league (the live-stats job's `Scores Updated`, and `NFL Games Updated`) go to the global
 * channel.
 *
 * Only trade events the whole league may see go to the league channel: an accepted trade (which the
 * league then reviews), and its processing or veto. Offers, counters, rejections, expiries, and
 * withdrawals stay between the two teams (Yahoo shows pending offers only to them): they go only to
 * those two teams' private channels, never to the league channel, which reaches every member.
 *
 * Direct messages (chat rooms `dm-...`, #144) are the same: a `Chat Message Posted` in a DM goes to
 * its two teams' channels (`detail.teamIds`) and never to the league channel. A DM message without
 * its two teams is dropped rather than risk the league channel.
 *
 * Per-team results also go to the team's own channel: each team's waiver awards and failed claims
 * from `Waivers Processed` (the league channel gets the run's awards, which everyone may see, but
 * never the failed claims).
 *
 * A team's new inbox item (`Notification Created`, #165) goes only to that team's channel.
 *
 * A team's channel is keyed by its current seat tenure (`teamChannel`), read from the table as each
 * event is relayed: after a seat changes hands, its messages go to a channel the previous occupant
 * never subscribed to (and the subscribe check refuses them). A team that no longer exists gets
 * nothing.
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
  'Draft Starting Soon',
  'Draft Start Blocked',
  'Waivers Processed',
  'Trade Accepted',
  'Trade Processed',
  'Trade Vetoed',
  'Week Provisionally Final',
  'Week Official Final',
  'Stat Correction Applied',
  // League-less, so on the global channel (#200): open lineups and matchups re-read the status.
  'Player Status Changed'
];

/** Events only the two teams in a trade may see: relayed to their private channels alone. */
export const TEAM_ONLY_EVENTS: readonly FantasyEventType[] = [
  'Trade Proposed',
  'Trade Countered',
  'Trade Rejected',
  'Trade Expired',
  'Trade Withdrawn'
];

/** Events for one team alone (`detail.teamId`): its new inbox items (#165). */
export const TEAM_INBOX_EVENTS: readonly FantasyEventType[] = ['Notification Created'];

export interface RelayResult {
  channels: string[];
}

/** Where a message goes: a channel, or a team whose current channel is looked up when relaying. */
type Target = string | { leagueId: string; teamId: string };

export async function relayEvent(
  realtime: Realtime,
  log: Logger,
  event: BusEvent,
  teams: Pick<TeamRepository, 'get'>
): Promise<RelayResult> {
  const detailType = event['detail-type'];
  const inbox = TEAM_INBOX_EVENTS.includes(detailType as FantasyEventType);
  const teamOnly = inbox || TEAM_ONLY_EVENTS.includes(detailType as FantasyEventType);
  if (
    event.source !== EVENT_SOURCE ||
    (!teamOnly && !RELAYED_EVENTS.includes(detailType as FantasyEventType))
  ) {
    log.info('realtime relay ignored event', { detailType, source: event.source });
    return { channels: [] };
  }
  const detail = eventDetail(event);
  const leagueIds = eventLeagueIds(detail);
  const deliveries: { target: Target; message: RealtimeMessage }[] = [];
  if (detailType === 'Chat Message Posted') {
    const message = detail.message;
    if (leagueIds.length === 1 && message !== null && typeof message === 'object') {
      const leagueId = leagueIds[0] as string;
      const chat = { type: 'chat' as const, leagueId, message: message as Record<string, unknown> };
      const roomId = [detail.roomId, (message as { roomId?: unknown }).roomId].find(isId);
      if (roomId?.startsWith('dm-') === true) {
        const teams = Array.isArray(detail.teamIds) ? [...new Set(detail.teamIds.filter(isId))] : [];
        if (teams.length === 2) {
          for (const teamId of teams) deliveries.push({ target: { leagueId, teamId }, message: chat });
        }
      } else {
        deliveries.push({ target: leagueChannel(leagueId), message: chat });
      }
    }
  } else if (teamOnly) {
    const base = { type: 'event' as const, detailType, eventId: event.id, time: event.time ?? null, detail };
    const teams = new Set(
      inbox ? [detail.teamId].filter(isId) : [detail.fromTeamId, detail.toTeamId].filter(isId)
    );
    if (leagueIds.length === 1) {
      const leagueId = leagueIds[0] as string;
      for (const teamId of teams) {
        deliveries.push({ target: { leagueId, teamId }, message: { ...base, leagueId } });
      }
    }
  } else {
    const base = { type: 'event' as const, detailType, eventId: event.id, time: event.time ?? null, detail };
    // Failed waiver claims are private to each team: the league channel never carries them.
    const { lost, ...shared } = detail;
    const everyone = detailType === 'Waivers Processed' ? { ...base, detail: shared } : base;
    if (leagueIds.length === 0)
      deliveries.push({ target: GLOBAL_CHANNEL, message: { ...everyone, leagueId: null } });
    for (const leagueId of leagueIds) {
      deliveries.push({ target: leagueChannel(leagueId), message: { ...everyone, leagueId } });
    }
    if (detailType === 'Waivers Processed' && leagueIds.length === 1) {
      deliveries.push(...teamWaiverDeliveries(leagueIds[0] as string, everyone, lost));
    }
  }
  const channelOf = teamChannels(teams);
  const channels: string[] = [];
  for (const { target, message } of deliveries) {
    const channel = typeof target === 'string' ? target : await channelOf(target.leagueId, target.teamId);
    if (channel === null) {
      log.warn('realtime relay skipped a team that does not exist', { detailType, target });
      continue;
    }
    await realtime.publish(channel, message);
    channels.push(channel);
  }
  log.info('realtime relay published', { detailType, eventId: event.id, channels });
  return { channels };
}

/** Each team's current channel, read once per relayed event. */
function teamChannels(teams: Pick<TeamRepository, 'get'>) {
  const read = new Map<string, Promise<string | null>>();
  return (leagueId: string, teamId: string): Promise<string | null> => {
    const key = `${leagueId}/${teamId}`;
    let channel = read.get(key);
    if (channel === undefined) {
      channel = teams
        .get(leagueId, teamId)
        .then((team) => (team === null ? null : teamChannel(leagueId, teamId, seatTenureKey(team))));
      read.set(key, channel);
    }
    return channel;
  };
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Each team's own waiver awards and failed claims, on its private channel. */
function teamWaiverDeliveries(
  leagueId: string,
  base: Omit<Extract<RealtimeMessage, { type: 'event' }>, 'leagueId'>,
  lost: unknown
): { target: Target; message: RealtimeMessage }[] {
  const byTeam = new Map<string, { awarded: unknown[]; lost: unknown[] }>();
  const add = (items: unknown, key: 'awarded' | 'lost') => {
    for (const item of Array.isArray(items) ? items : []) {
      const teamId = (item as { teamId?: unknown } | null)?.teamId;
      if (!isId(teamId)) continue;
      const mine = byTeam.get(teamId) ?? { awarded: [], lost: [] };
      mine[key].push(item);
      byTeam.set(teamId, mine);
    }
  };
  add(base.detail.awarded, 'awarded');
  add(lost, 'lost');
  return [...byTeam].map(([teamId, mine]) => ({
    target: { leagueId, teamId },
    message: {
      ...base,
      leagueId,
      detail: {
        ...base.detail,
        teamId,
        awarded: mine.awarded,
        ...(lost === undefined ? {} : { lost: mine.lost })
      }
    }
  }));
}
