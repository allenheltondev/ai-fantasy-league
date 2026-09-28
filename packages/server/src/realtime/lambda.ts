/**
 * Lambda entrypoint for the realtime publisher (EventBridge rule on league events, see
 * RealtimePublisherFunction in infra/template.yaml). Bundled by scripts/package-server.sh as
 * `realtime.mjs`, export `handler`.
 */
import { systemClock } from '@fantasy/core';
import type { BusEvent } from '../events/bus.js';
import { createLogger, parseLogLevel, type Logger } from '../log.js';
import { realtimeFromEnv } from './config.js';
import type { Realtime } from './realtime.js';
import { relayEvent, type RelayResult } from './relay.js';

let deps: { realtime: Realtime; log: Logger } | null = null;

export function createRelayDeps(env: Record<string, string | undefined>): {
  realtime: Realtime;
  log: Logger;
} {
  const log = createLogger({ level: parseLogLevel(env.LOG_LEVEL), bindings: { component: 'realtime' } });
  return { realtime: realtimeFromEnv(env, { clock: systemClock, log }), log };
}

export async function handler(event: BusEvent): Promise<RelayResult> {
  deps ??= createRelayDeps(process.env);
  return relayEvent(deps.realtime, deps.log, event);
}
