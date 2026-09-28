/**
 * Lambda entrypoint for system chat messages and notification inboxes (#165) (EventBridge rule on
 * league events, see ChatEventsFunction in infra/template.yaml). Both consumers are idempotent per
 * event id, so a retry after either fails repeats nothing. Bundled by scripts/package-server.sh as
 * `chat-events.mjs`, export `handler`.
 */
import { systemClock } from '@fantasy/core';
import { z } from 'zod';
import type { Services } from '../context.js';
import type { BusEvent } from '../events/bus.js';
import { EventBridgePublisher } from '../events/eventbridge.js';
import { createLogger, parseLogLevel } from '../log.js';
import { createDynamoRepos } from '../repos/dynamo/index.js';
import { createDocumentClient } from '../repos/dynamo/table.js';
import { createServices } from '../services.js';
import { writeNotifications, type NotificationOutcome } from '../notifications/consumer.js';
import { postSystemMessage, type SystemMessageOutcome } from './system-messages.js';

const EnvSchema = z.object({
  TABLE_NAME: z.string().min(1),
  EVENT_BUS_NAME: z.string().min(1).default('default'),
  LOG_LEVEL: z.string().optional()
});

export function createChatEventServices(env: Record<string, string | undefined>): Services {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Missing or invalid chat events environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`
    );
  }
  return createServices({
    clock: systemClock,
    repos: createDynamoRepos({ doc: createDocumentClient(), tableName: parsed.data.TABLE_NAME }),
    events: new EventBridgePublisher({ busName: parsed.data.EVENT_BUS_NAME }),
    log: createLogger({ level: parseLogLevel(parsed.data.LOG_LEVEL), bindings: { component: 'chat-events' } })
  });
}

let services: Services | null = null;

export interface ChatEventsResult {
  chat: SystemMessageOutcome;
  notifications: NotificationOutcome;
}

export async function handleChatEvent(services: Services, event: BusEvent): Promise<ChatEventsResult> {
  return {
    chat: await postSystemMessage(services, event),
    notifications: await writeNotifications(services, event)
  };
}

export async function handler(event: BusEvent): Promise<ChatEventsResult> {
  services ??= createChatEventServices(process.env);
  return handleChatEvent(services, event);
}
