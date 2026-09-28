import { renderSystemMessage, SYSTEM_MESSAGE_TEMPLATES } from '@fantasy/core';
import { eventDetail, type BusEvent } from '../events/bus.js';
import { EVENT_SOURCE } from '../events/publisher.js';
import type { Services } from '../context.js';
import type { ChatMessage } from './model.js';

/**
 * System chat messages (issue #70): league events announced in the group chat, from the template
 * map in `@fantasy/core` (`SYSTEM_MESSAGE_TEMPLATES`).
 *
 * Idempotent per event: the message id is `sys-<event id>` and its time is the event's time, so a
 * redelivered event hits the same key and the conditional put stores nothing. Only a first delivery
 * announces the message (`Chat Message Posted`) and, for big moments, invites agents to react
 * (`Chat Moment`).
 */

export type SystemMessageOutcome =
  | { status: 'posted'; message: ChatMessage; moment: boolean }
  | { status: 'duplicate'; messageId: string }
  | { status: 'skipped'; reason: 'not_ours' | 'no_template' | 'no_league' | 'nothing_to_say' };

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
  const teams = await services.repos.teams.list(league.id);
  const names = new Map(teams.map((t) => [t.id, t.name]));
  const rendered = renderSystemMessage(detailType, detail, { teamName: (id) => names.get(id) ?? null });
  if (rendered === null) return { status: 'skipped', reason: 'nothing_to_say' };

  const message: ChatMessage = {
    id: `sys-${event.id}`,
    leagueId: league.id,
    kind: 'system',
    author: { teamId: null, teamName: null, name: 'League' },
    text: rendered.text,
    mentionedTeamIds: [],
    event: { detailType, eventId: event.id },
    ...(rendered.players.length === 0 ? {} : { players: rendered.players }),
    createdAt: eventTime(event, services.clock.now())
  };
  if (!(await services.repos.chat.put(message))) return { status: 'duplicate', messageId: message.id };
  await services.events.publish('Chat Message Posted', { leagueId: league.id, message });
  if (rendered.moment) {
    await services.events.publish('Chat Moment', {
      leagueId: league.id,
      moment: rendered.text,
      messageId: message.id,
      sourceEventType: detailType,
      sourceEventId: event.id,
      ...(rendered.subjectTeamId === null ? {} : { teamId: rendered.subjectTeamId })
    });
  }
  return { status: 'posted', message, moment: rendered.moment };
}
