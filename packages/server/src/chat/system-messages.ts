import {
  matchupRoomId,
  renderMatchupRoomLine,
  renderSystemMessage,
  SYSTEM_MESSAGE_TEMPLATES,
  systemMessageRoute
} from '@fantasy/core';
import { canonicalEvent, eventDetail, type BusEvent } from '../events/bus.js';
import { EVENT_SOURCE } from '../events/publisher.js';
import type { Services } from '../context.js';
import { leagueManagers } from '../league/managers.js';
import { phaseFlags } from '../league/phase.js';
import type { ChatMessage } from './model.js';

/**
 * System chat messages (issue #70): league events announced in chat, from the template map in
 * `@fantasy/core` (`SYSTEM_MESSAGE_TEMPLATES`). Each goes to the room the routing table
 * (`SYSTEM_MESSAGE_ROUTES`, #144) names; a week going final also posts one line, the game's score,
 * to each of the week's matchup rooms (`sys-<event id>-<matchup id>`), and the closest game, when
 * close, is a moment. The week is over by then, so its matchup rooms are archived: agents react to
 * the moment in the room of the week's announcement (`league`), not the matchup room.
 *
 * Idempotent per event: the message id is `sys-<event id>` and its time is the event's time, so a
 * redelivered event hits the same key and the conditional put stores nothing. Only a first delivery
 * announces the message (`Chat Message Posted`) and, for big moments, invites agents to react
 * (`Chat Moment`).
 */

export type SystemMessageOutcome =
  | { status: 'posted'; message: ChatMessage; moment: boolean; matchupMessages: ChatMessage[] }
  | { status: 'duplicate'; messageId: string }
  | { status: 'skipped'; reason: 'not_ours' | 'no_template' | 'no_league' | 'nothing_to_say' | 'stale' };

/** Detail types that may produce a system message (for the EventBridge rule and tests). */
export const SYSTEM_MESSAGE_EVENTS = Object.keys(SYSTEM_MESSAGE_TEMPLATES);

function eventTime(event: BusEvent, fallback: Date): string {
  const parsed = event.time === undefined ? Number.NaN : Date.parse(event.time);
  return Number.isNaN(parsed) ? fallback.toISOString() : new Date(parsed).toISOString();
}

export async function postSystemMessage(
  services: Pick<Services, 'repos' | 'events' | 'clock' | 'log'>,
  event: BusEvent
): Promise<SystemMessageOutcome> {
  event = canonicalEvent(event);
  const detailType = event['detail-type'];
  const log = services.log.child({ eventId: event.id, detailType });
  const outcome = await post(services, event);
  log.info('system chat message', {
    status: outcome.status,
    ...(outcome.status === 'skipped' ? { reason: outcome.reason } : {})
  });
  return outcome;
}

async function post(
  services: Pick<Services, 'repos' | 'events' | 'clock'>,
  event: BusEvent
): Promise<SystemMessageOutcome> {
  const detailType = event['detail-type'];
  if (event.source !== EVENT_SOURCE) return { status: 'skipped', reason: 'not_ours' };
  if (SYSTEM_MESSAGE_TEMPLATES[detailType] === undefined) return { status: 'skipped', reason: 'no_template' };
  const detail = eventDetail(event);
  const leagueId = typeof detail.leagueId === 'string' ? detail.leagueId : null;
  const league = leagueId === null ? null : await services.repos.leagues.get(leagueId);
  if (league === null) return { status: 'skipped', reason: 'no_league' };
  // A deadline event left over from before the deadline moved later says nothing yet.
  if (detailType === 'Trade Deadline Passed' && !phaseFlags(league, services.clock.now()).tradeDeadlinePassed)
    return { status: 'skipped', reason: 'stale' };
  const teams = await services.repos.teams.list(league.id);
  const names = new Map(teams.map((t) => [t.id, t.name]));
  // Announcements name an agent team's AI manager next to the team (#151).
  const managers = await leagueManagers(services, league.id, teams);
  const rendered = renderSystemMessage(detailType, detail, {
    teamName: (id) => names.get(id) ?? null,
    managerName: (id) => managers.get(id)?.name ?? null
  });
  if (rendered === null) return { status: 'skipped', reason: 'nothing_to_say' };

  const route = systemMessageRoute(detailType);
  const createdAt = eventTime(event, services.clock.now());
  const system = { kind: 'system', author: { teamId: null, teamName: null, name: 'League' } } as const;
  const message: ChatMessage = {
    id: `sys-${event.id}`,
    leagueId: league.id,
    roomId: route.room,
    ...system,
    text: rendered.text,
    mentionedTeamIds: [],
    event: { detailType, eventId: event.id },
    ...(rendered.players.length === 0 ? {} : { players: rendered.players }),
    createdAt
  };
  if (!(await services.repos.chat.put(message))) return { status: 'duplicate', messageId: message.id };
  await announce(services, message);
  if (rendered.moment) {
    await services.events.publish('Chat Moment', {
      leagueId: league.id,
      roomId: message.roomId,
      moment: rendered.text,
      messageId: message.id,
      sourceEventType: detailType,
      sourceEventId: event.id,
      ...(rendered.subjectTeamId === null ? {} : { teamId: rendered.subjectTeamId })
    });
  }

  const matchupMessages: ChatMessage[] = [];
  const week = typeof detail.week === 'number' ? detail.week : null;
  const lines =
    route.matchupRooms === true && week !== null && Array.isArray(detail.matchups) ? detail.matchups : [];
  // At most one close game per week is a moment: the closest.
  let closest: { message: ChatMessage; margin: number; teamIds: string[] } | null = null;
  for (const raw of lines) {
    const line = (raw ?? {}) as Record<string, unknown>;
    if (
      typeof line.matchupId !== 'string' ||
      typeof line.homeTeamId !== 'string' ||
      typeof line.awayTeamId !== 'string'
    )
      continue;
    const text = renderMatchupRoomLine(detailType, line, { teamName: (id) => names.get(id) ?? null });
    if (text === null) continue;
    const roomMessage: ChatMessage = {
      ...message,
      id: `sys-${event.id}-${line.matchupId}`,
      roomId: matchupRoomId(league.season, week as number, line.matchupId),
      text: text.text
    };
    delete roomMessage.players;
    if (!(await services.repos.chat.put(roomMessage))) continue;
    await announce(services, roomMessage);
    matchupMessages.push(roomMessage);
    const margin = Math.abs(Number(line.homeScore) - Number(line.awayScore));
    if (text.moment && (closest === null || margin < closest.margin)) {
      closest = { message: roomMessage, margin, teamIds: [line.homeTeamId, line.awayTeamId] };
    }
  }
  if (closest !== null) {
    await services.events.publish('Chat Moment', {
      leagueId: league.id,
      roomId: message.roomId,
      moment: closest.message.text,
      messageId: closest.message.id,
      sourceEventType: detailType,
      sourceEventId: event.id,
      teamIds: closest.teamIds
    });
  }
  return { status: 'posted', message, moment: rendered.moment, matchupMessages };
}

function announce(services: Pick<Services, 'events'>, message: ChatMessage): Promise<void> {
  return services.events.publish('Chat Message Posted', {
    leagueId: message.leagueId,
    roomId: message.roomId,
    teamIds: null,
    message
  });
}
