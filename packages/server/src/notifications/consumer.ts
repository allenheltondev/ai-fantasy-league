import {
  NOTIFICATION_EVENTS,
  notificationDrafts,
  PLAYER_NOTIFICATION_EVENTS,
  type NotificationDraft
} from '@fantasy/core';
import type { Services } from '../context.js';
import { eventDetail, type BusEvent } from '../events/bus.js';
import { EVENT_SOURCE } from '../events/publisher.js';
import { seatTenureStart } from '../repos/types.js';
import { notificationId, notificationLocalKey, type StoredNotification } from './model.js';
import { writePlayerNotifications } from './players.js';

/**
 * The notification inbox consumer (#165): league events become inbox items for the teams they are
 * news to (core `notificationDrafts`), only for teams a person holds (agent-only teams get none).
 * Each new item is announced with `Notification Created`, which the realtime relay pushes to that
 * team's private topic.
 *
 * Player status changes and news (#200) are league-less: `writePlayerNotifications` finds the
 * teams that roster the player (`players.ts`).
 *
 * Idempotent per event, like the system chat messages: an item's time is its event's time and its
 * key carries the event id, so a redelivered event hits the same key and the conditional put stores
 * nothing (and announces nothing).
 */

export type NotificationOutcome =
  | { status: 'written'; notifications: StoredNotification[]; duplicates: number }
  | { status: 'skipped'; reason: 'not_ours' | 'not_notifiable' | 'no_league' | 'nobody' };

/** Detail types that may notify someone (for the EventBridge rule and tests). */
export const NOTIFICATION_EVENT_TYPES: readonly string[] = [
  ...NOTIFICATION_EVENTS,
  ...PLAYER_NOTIFICATION_EVENTS
];

const PLAYER_EVENTS: readonly string[] = PLAYER_NOTIFICATION_EVENTS;

export function eventTime(event: BusEvent, fallback: Date): string {
  const parsed = event.time === undefined ? Number.NaN : Date.parse(event.time);
  return Number.isNaN(parsed) ? fallback.toISOString() : new Date(parsed).toISOString();
}

export async function writeNotifications(
  services: Pick<Services, 'repos' | 'events' | 'clock' | 'log' | 'data'>,
  event: BusEvent
): Promise<NotificationOutcome> {
  const log = services.log.child({ eventId: event.id, detailType: event['detail-type'] });
  const outcome = await write(services, event);
  log.info('notifications', {
    status: outcome.status,
    ...(outcome.status === 'skipped'
      ? { reason: outcome.reason }
      : { written: outcome.notifications.length, duplicates: outcome.duplicates })
  });
  return outcome;
}

async function write(
  services: Pick<Services, 'repos' | 'events' | 'clock' | 'data'>,
  event: BusEvent
): Promise<NotificationOutcome> {
  const detailType = event['detail-type'];
  if (event.source !== EVENT_SOURCE) return { status: 'skipped', reason: 'not_ours' };
  if (!NOTIFICATION_EVENT_TYPES.includes(detailType)) return { status: 'skipped', reason: 'not_notifiable' };
  if (PLAYER_EVENTS.includes(detailType)) return writePlayerNotifications(services, event);
  const detail = eventDetail(event);
  const leagueId = typeof detail.leagueId === 'string' ? detail.leagueId : null;
  const league = leagueId === null ? null : await services.repos.leagues.get(leagueId);
  if (league === null) return { status: 'skipped', reason: 'no_league' };
  const teams = await services.repos.teams.list(league.id);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const createdAt = eventTime(event, services.clock.now());
  const drafts = notificationDrafts(detailType, detail, {
    teamName: (id) => byId.get(id)?.name ?? null
  }).filter((d) => {
    const team = byId.get(d.teamId);
    // A person must hold the seat, and have held it when the event happened.
    return (
      team !== undefined &&
      team.seatType === 'human' &&
      team.ownerUserId !== null &&
      seatTenureStart(team) <= createdAt
    );
  });
  if (drafts.length === 0) return { status: 'skipped', reason: 'nobody' };
  return deliver(services, league.id, drafts, event, createdAt);
}

/**
 * Stores each draft as an inbox item and announces the new ones with `Notification Created`. The
 * item's id is its event's time and id (plus the draft's key), so a redelivered event stores nothing.
 */
export async function deliver(
  services: Pick<Services, 'repos' | 'events'>,
  leagueId: string,
  drafts: readonly NotificationDraft[],
  event: BusEvent,
  createdAt: string
): Promise<NotificationOutcome> {
  const detailType = event['detail-type'];
  const written: StoredNotification[] = [];
  let duplicates = 0;
  for (const draft of drafts) {
    const notification: StoredNotification = {
      id: notificationId(notificationLocalKey(createdAt, event.id, draft.key)),
      leagueId,
      teamId: draft.teamId,
      kind: draft.kind,
      title: draft.title,
      body: draft.body,
      target: draft.target,
      ...(draft.urgent === true ? { urgent: true } : {}),
      event: { detailType, eventId: event.id },
      createdAt,
      readAt: null,
      deliveredAt: null
    };
    if (!(await services.repos.notifications.put(notification))) {
      duplicates += 1;
      continue;
    }
    written.push(notification);
    await services.events.publish('Notification Created', {
      leagueId,
      teamId: draft.teamId,
      notification: { ...notification, read: false }
    });
  }
  return { status: 'written', notifications: written, duplicates };
}
