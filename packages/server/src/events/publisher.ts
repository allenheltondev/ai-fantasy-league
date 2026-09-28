/**
 * Domain events go to the default EventBridge bus with `source: 'fantasy'`.
 * Timed events use rsc-core's deferred-event scheduler: we emit a `Schedule Event`
 * whose detail carries the event to publish later (rsc-core README, "Deferred events").
 */

import type { EventDetailOf } from './details.js';

export const EVENT_SOURCE = 'fantasy';
export const SCHEDULE_EVENT = 'Schedule Event';
export const CANCEL_SCHEDULED_EVENT = 'Cancel Scheduled Event';

/** Detail types from docs/ARCHITECTURE.md "Events". */
export type FantasyEventType =
  | 'League Created'
  | 'Draft Turn Started'
  | 'Draft Pick Made'
  | 'Draft Completed'
  /** Scheduled at each pick's deadline; the draft clock handler autopicks if the pick is still open. */
  | 'Draft Pick Deadline'
  | 'Week Rolled Over'
  | 'Lineup Lock Approaching'
  | 'Waiver Window Opened'
  | 'Waivers Processed'
  | 'Trade Proposed'
  | 'Trade Countered'
  | 'Trade Accepted'
  | 'Trade Rejected'
  | 'Trade Expired'
  | 'Trade Processed'
  | 'Trade Vetoed'
  | 'Player News Alert'
  | 'Player Status Changed'
  | 'Chat Mention'
  | 'Chat Moment'
  | 'Chat Message Posted'
  | 'Scores Updated'
  | 'Week Provisionally Final'
  | 'Week Official Final'
  | 'Stat Correction Applied'
  | 'Agent Action Requested'
  | 'Member Joined'
  | 'Member Left'
  | 'Settings Changed'
  /** The last playoff week is over and the league is complete (champion and runner-up). */
  | 'Season Completed'
  /** A team earned a league achievement (history/achievements in core). */
  | 'Achievement Earned'
  /** rsc-core badge chest activity (its engine matches on this detail type; see season/achievements.ts). */
  | 'Track Activity';

export type EventDetail = Record<string, unknown>;

/** An event to publish: its detail type and the detail the contract (`details.ts`) requires. */
export type TypedEvent = {
  [T in FantasyEventType]: { detailType: T; detail: EventDetailOf<T> };
}[FantasyEventType];

export interface ScheduleRequest {
  /** When to publish. A Date is sent as an ISO instant. */
  at: Date;
  event: TypedEvent;
  /** Idempotency key: re-scheduling with the same name moves the pending schedule. */
  name?: string;
  /** What to do when `at` has already passed. rsc-core defaults to `send`. */
  whenPast?: 'send' | 'skip' | 'error';
}

/** The exact `Schedule Event` detail rsc-core's ScheduleEventFunction consumes. */
export interface ScheduleEventDetail {
  at: string;
  name?: string;
  whenPast?: 'send' | 'skip' | 'error';
  event: { source: string; detailType: string; detail: EventDetail };
}

export interface EventPublisher {
  /** The detail is typed per event type (`EVENT_DETAIL_SCHEMAS`), so emitters cannot drift. */
  publish<T extends FantasyEventType>(detailType: T, detail: EventDetailOf<T>): Promise<void>;
  scheduleAt(request: ScheduleRequest): Promise<void>;
  cancelScheduled(name: string): Promise<void>;
}

export function scheduleEventDetail(request: ScheduleRequest): ScheduleEventDetail {
  const detail: ScheduleEventDetail = {
    at: request.at.toISOString(),
    event: {
      source: EVENT_SOURCE,
      detailType: request.event.detailType,
      detail: request.event.detail as EventDetail
    }
  };
  if (request.name !== undefined) detail.name = request.name;
  if (request.whenPast !== undefined) detail.whenPast = request.whenPast;
  return detail;
}

export interface RecordedEvent {
  source: string;
  detailType: string;
  detail: EventDetail;
}

/** Keeps every event in memory. Used by unit tests, local dev, and the simulator. */
export class InMemoryEventPublisher implements EventPublisher {
  readonly events: RecordedEvent[] = [];

  async publish<T extends FantasyEventType>(detailType: T, detail: EventDetailOf<T>): Promise<void> {
    this.events.push({ source: EVENT_SOURCE, detailType, detail: detail as EventDetail });
  }

  async scheduleAt(request: ScheduleRequest): Promise<void> {
    this.events.push({
      source: EVENT_SOURCE,
      detailType: SCHEDULE_EVENT,
      detail: { ...scheduleEventDetail(request) }
    });
  }

  async cancelScheduled(name: string): Promise<void> {
    this.events.push({ source: EVENT_SOURCE, detailType: CANCEL_SCHEDULED_EVENT, detail: { name } });
  }
}
