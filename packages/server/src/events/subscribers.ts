import { postSystemMessage, SYSTEM_MESSAGE_EVENTS } from '../chat/system-messages.js';
import type { Services } from '../context.js';
import { NOTIFICATION_EVENT_TYPES, writeNotifications } from '../notifications/consumer.js';
import { TRADE_TIMER_EVENTS } from '../trades/handlers.js';
import { DRAFT_SCHEDULE_EVENTS, handleLeagueEvent } from './handlers.js';
import type { EventSubscriber } from './loop.js';

/**
 * The server's own event consumers, as event-loop subscribers. Each calls the same function its
 * Lambda runs: the API function's league event handler (the draft pick clock) and the chat events
 * function (system chat messages and notification inboxes). The league handler covers the draft pick clock and the trade
 * timers (offer expiry, review end, the trade deadline). The agent router and task runner live in `@fantasy/agents`
 * (`agentSubscribers`).
 */
export function serverSubscribers(services: Services): EventSubscriber[] {
  return [
    {
      name: 'league-timers',
      detailTypes: ['Draft Pick Deadline', ...DRAFT_SCHEDULE_EVENTS, ...TRADE_TIMER_EVENTS],
      handle: (event) => handleLeagueEvent(services, event)
    },
    {
      name: 'system-messages',
      detailTypes: SYSTEM_MESSAGE_EVENTS,
      handle: (event) => postSystemMessage(services, event)
    },
    {
      name: 'notifications',
      detailTypes: NOTIFICATION_EVENT_TYPES,
      handle: (event) => writeNotifications(services, event)
    }
  ];
}
