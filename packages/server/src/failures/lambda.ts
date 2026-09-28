/**
 * Lambda entrypoint for failure emails (EventBridge rule on this stack's `Lambda Function
 * Invocation Result - Failure` events, see FailureNotifierFunction in infra/template.yaml).
 * Bundled by scripts/package-server.sh as `failure-notifier.mjs`, export `handler`.
 */
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { z } from 'zod';
import type { PutEventsSender } from '../events/eventbridge.js';
import { createLogger, parseLogLevel } from '../log.js';
import {
  notifyFailure,
  type FailureNotifierDeps,
  type InvocationFailureEvent,
  type NotifyResult
} from './notify.js';

const EnvSchema = z.object({
  ALARM_EMAIL: z.string().min(1),
  STACK_NAME: z.string().min(1),
  EVENT_BUS_NAME: z.string().min(1).default('default'),
  LOG_LEVEL: z.string().optional()
});

export function createFailureNotifierDeps(
  env: Record<string, string | undefined>,
  events: PutEventsSender = new EventBridgeClient({})
): FailureNotifierDeps {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Missing or invalid failure notifier environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`
    );
  }
  return {
    events,
    busName: parsed.data.EVENT_BUS_NAME,
    to: parsed.data.ALARM_EMAIL,
    stackName: parsed.data.STACK_NAME,
    log: createLogger({
      level: parseLogLevel(parsed.data.LOG_LEVEL),
      bindings: { component: 'failure-notifier' }
    })
  };
}

let deps: FailureNotifierDeps | null = null;

export async function handler(event: InvocationFailureEvent): Promise<NotifyResult> {
  deps ??= createFailureNotifierDeps(process.env);
  return notifyFailure(deps, event);
}
