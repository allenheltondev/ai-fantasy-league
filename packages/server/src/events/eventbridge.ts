import type { EventDetailOf } from './details.js';
import { EventBridgeClient, PutEventsCommand, type PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import {
  CANCEL_SCHEDULED_EVENT,
  EVENT_SOURCE,
  SCHEDULE_EVENT,
  scheduleEventDetail,
  type EventDetail,
  type EventPublisher,
  type FantasyEventType,
  type ScheduleRequest
} from './publisher.js';

/** Minimal surface of the SDK client, so tests can pass a fake. */
export interface PutEventsSender {
  send(command: PutEventsCommand): Promise<{ FailedEntryCount?: number | undefined }>;
}

export class EventBridgePublisher implements EventPublisher {
  readonly #client: PutEventsSender;
  readonly #busName: string;

  constructor(options: { client?: PutEventsSender; busName?: string } = {}) {
    this.#client = options.client ?? new EventBridgeClient({});
    this.#busName = options.busName ?? 'default';
  }

  publish<T extends FantasyEventType>(detailType: T, detail: EventDetailOf<T>): Promise<void> {
    return this.#put(detailType, detail as EventDetail);
  }

  scheduleAt(request: ScheduleRequest): Promise<void> {
    return this.#put(SCHEDULE_EVENT, { ...scheduleEventDetail(request) });
  }

  cancelScheduled(name: string): Promise<void> {
    return this.#put(CANCEL_SCHEDULED_EVENT, { name });
  }

  async #put(detailType: string, detail: EventDetail): Promise<void> {
    const entry: PutEventsRequestEntry = {
      EventBusName: this.#busName,
      Source: EVENT_SOURCE,
      DetailType: detailType,
      Detail: JSON.stringify(detail)
    };
    const result = await this.#client.send(new PutEventsCommand({ Entries: [entry] }));
    if ((result.FailedEntryCount ?? 0) > 0) {
      throw new Error(`EventBridge rejected the "${detailType}" event`);
    }
  }
}
