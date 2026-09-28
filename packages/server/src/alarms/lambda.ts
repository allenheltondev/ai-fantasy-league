/**
 * Lambda entrypoint for alarm notifications (EventBridge rule on this stack's CloudWatch alarms
 * entering ALARM, see AlarmNotifierFunction in infra/template.yaml). Bundled by
 * scripts/package-server.sh as `alarm-notifier.mjs`, export `handler`.
 */
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { z } from 'zod';
import type { PutEventsSender } from '../events/eventbridge.js';
import { createLogger, parseLogLevel } from '../log.js';
import {
  notifyAlarm,
  type AlarmNotifierDeps,
  type AlarmStateChangeEvent,
  type NotifyResult
} from './notify.js';

const EnvSchema = z.object({
  ALARM_EMAIL: z.string().min(1),
  STACK_NAME: z.string().min(1),
  EVENT_BUS_NAME: z.string().min(1).default('default'),
  LOG_LEVEL: z.string().optional()
});

export function createAlarmNotifierDeps(
  env: Record<string, string | undefined>,
  events: PutEventsSender = new EventBridgeClient({})
): AlarmNotifierDeps {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Missing or invalid alarm notifier environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`
    );
  }
  return {
    events,
    busName: parsed.data.EVENT_BUS_NAME,
    to: parsed.data.ALARM_EMAIL,
    stackName: parsed.data.STACK_NAME,
    log: createLogger({
      level: parseLogLevel(parsed.data.LOG_LEVEL),
      bindings: { component: 'alarm-notifier' }
    })
  };
}

let deps: AlarmNotifierDeps | null = null;

export async function handler(event: AlarmStateChangeEvent): Promise<NotifyResult> {
  deps ??= createAlarmNotifierDeps(process.env);
  return notifyAlarm(deps, event);
}
