import { postSystemMessage, SYSTEM_MESSAGE_EVENTS } from '../chat/system-messages.js';
import type { Services } from '../context.js';
import { handleLeagueEvent } from './handlers.js';
import type { EventSubscriber } from './loop.js';

/**
 * The server's own event consumers, as event-loop subscribers. Each calls the same function its
 * Lambda runs: the API function's league event handler (the draft pick clock) and the chat events
 * function (system chat messages). The agent router and task runner live in `@fantasy/agents`
 * (`agentSubscribers`).
 */
export function serverSubscribers(services: Services): EventSubscriber[] {
  return [
    {
      name: 'draft-clock',
      detailTypes: ['Draft Pick Deadline'],
      handle: (event) => handleLeagueEvent(services, event)
    },
    {
      name: 'system-messages',
      detailTypes: SYSTEM_MESSAGE_EVENTS,
      handle: (event) => postSystemMessage(services, event)
    }
  ];
}
