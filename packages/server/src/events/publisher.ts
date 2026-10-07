/**
 * Domain events go to the default EventBridge bus with `source: 'fantasy'`.
 * Timed events use rsc-core's deferred-event scheduler: we emit a `Schedule Event`
 * whose detail carries the event to publish later (rsc-core README, "Deferred events").
 */

import type { EventDetailOf } from './details.js';
import { isValidScheduleName } from './schedule-name.js';

export const EVENT_SOURCE = 'fantasy';
export const SCHEDULE_EVENT = 'Schedule Event';
export const CANCEL_SCHEDULED_EVENT = 'Cancel Scheduled Event';
/** rsc-core's email event: its SendEmailFunction listens on the default bus for this detail type. */
export const SEND_EMAIL = 'Send Email';
/** Source of the emails the league sends people (the failure emails have their own). */
export const LEAGUE_EMAIL_SOURCE = 'fantasy.email';

/** Detail types from docs/ARCHITECTURE.md "Events". */
export type FantasyEventType =
  | 'League Created'
  | 'Draft Turn Started'
  | 'Draft Pick Made'
  | 'Draft Completed'
  /** The commissioner froze the pick clock (`pause_draft`); relayed so boards stop counting down. */
  | 'Draft Paused'
  /** The commissioner restarted the pick clock (`resume_draft`), with the new deadline. */
  | 'Draft Resumed'
  /** Scheduled at each pick's deadline; the draft clock handler autopicks if the pick is still open. */
  | 'Draft Pick Deadline'
  /** Scheduled at `draft.scheduledAt`; the API function starts the draft if the time still holds. */
  | 'Draft Start Scheduled'
  /** Scheduled a few minutes before `draft.scheduledAt`; the API function announces `Draft Starting Soon`. */
  | 'Draft Reminder Due'
  /** The scheduled draft starts in a few minutes (chat, and pushed to open lobbies). */
  | 'Draft Starting Soon'
  /** The scheduled draft could not start (open seats, ...); the commissioner is told in chat. */
  | 'Draft Start Blocked'
  | 'Week Rolled Over'
  | 'Lineup Lock Approaching'
  | 'Waiver Window Opened'
  /** Three times a day, per drafted league with agents (`managerCheckIns`): every agent looks at its team. */
  | 'Manager Check-In'
  | 'Waivers Processed'
  | 'Trade Proposed'
  | 'Trade Countered'
  | 'Trade Accepted'
  | 'Trade Rejected'
  | 'Trade Expired'
  /** The proposer took back an open offer (only the two teams hear about it). */
  | 'Trade Withdrawn'
  | 'Trade Processed'
  | 'Trade Vetoed'
  /** Scheduled at an offer's `expiresAt`; the API function expires it if it is still open. */
  | 'Trade Offer Deadline'
  /** Scheduled at the end of an accepted trade's review period; the API function processes it. */
  | 'Trade Review Ended'
  /** Scheduled at the trade deadline (kickoff of `trades.deadlineWeek`); open offers expire. */
  | 'Trade Deadline Passed'
  | 'Player News Alert'
  | 'Player Status Changed'
  | 'Chat Mention'
  | 'Chat Moment'
  | 'Chat Message Posted'
  /** A notification was added to a team's inbox (#165); relayed only to that team's private topic. */
  | 'Notification Created'
  | 'Scores Updated'
  /** The week's NFL games changed (scores, status, possession, red zone); league-less, on the global topic. */
  | 'NFL Games Updated'
  | 'Week Provisionally Final'
  | 'Week Official Final'
  | 'Stat Correction Applied'
  | 'Agent Action Requested'
  | 'Member Joined'
  | 'Member Left'
  | 'Settings Changed'
  /** The commissioner changed an agent seat after the draft (announced in chat). */
  | 'Agent Seat Changed'
  /** A team got a new name (#194): chat announces renames by people, and AI managers may rename. */
  | 'Team Renamed'
  /** The league's agents passed their weekly model budget for the first time this week (announced in chat). */
  | 'Agent Budget Exceeded'
  /** The last playoff week is over and the league is complete (champion and runner-up). */
  | 'Season Completed'
  /** A team earned a league achievement (history/achievements in core). */
  | 'Achievement Earned'
  /** The weekly "which model wins the league?" standings, posted in chat at each rollover. */
  | 'Model Power Rankings'
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

/** The `Send Email` detail rsc-core's SendEmailFunction consumes. */
export interface SendEmailDetail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EventPublisher {
  /** The detail is typed per event type (`EVENT_DETAIL_SCHEMAS`), so emitters cannot drift. */
  publish<T extends FantasyEventType>(detailType: T, detail: EventDetailOf<T>): Promise<void>;
  scheduleAt(request: ScheduleRequest): Promise<void>;
  cancelScheduled(name: string): Promise<void>;
  /** Emails one person through rsc-core's `Send Email`. Not a domain event: nothing here consumes it. */
  sendEmail(email: SendEmailDetail): Promise<void>;
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

function assertScheduleName(name: string): void {
  if (!isValidScheduleName(name)) {
    throw new Error(
      `Schedule name "${name}" does not fit EventBridge Scheduler; build it with scheduleName().`
    );
  }
}

export interface RecordedEvent {
  source: string;
  detailType: string;
  detail: EventDetail;
}

/**
 * Keeps every event in memory. Used by unit tests, local dev, and the simulator. It refuses a
 * schedule name EventBridge Scheduler would not take unchanged (build names with `scheduleName`),
 * so every test, the local loop, and the replay check every name the code produces.
 */
export class InMemoryEventPublisher implements EventPublisher {
  readonly events: RecordedEvent[] = [];
  /** Emails are kept apart from `events`, which the event loop delivers to handlers. */
  readonly emails: SendEmailDetail[] = [];

  async publish<T extends FantasyEventType>(detailType: T, detail: EventDetailOf<T>): Promise<void> {
    this.events.push({ source: EVENT_SOURCE, detailType, detail: detail as EventDetail });
  }

  async scheduleAt(request: ScheduleRequest): Promise<void> {
    if (request.name !== undefined) assertScheduleName(request.name);
    this.events.push({
      source: EVENT_SOURCE,
      detailType: SCHEDULE_EVENT,
      detail: { ...scheduleEventDetail(request) }
    });
  }

  async cancelScheduled(name: string): Promise<void> {
    assertScheduleName(name);
    this.events.push({ source: EVENT_SOURCE, detailType: CANCEL_SCHEDULED_EVENT, detail: { name } });
  }

  async sendEmail(email: SendEmailDetail): Promise<void> {
    this.emails.push({ ...email });
  }
}
