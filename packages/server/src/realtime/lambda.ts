/**
 * Lambda entrypoint for the realtime publisher (EventBridge rule on league events, see
 * RealtimePublisherFunction in infra/template.yaml). Bundled by scripts/package-server.sh as
 * `realtime.mjs`, export `handler`.
 */
import type { BusEvent } from '../events/bus.js';
import { createLogger, parseLogLevel, type Logger } from '../log.js';
import { createDocumentClient } from '../repos/dynamo/table.js';
import { DynamoTeamRepository } from '../repos/dynamo/teams.js';
import type { TeamRepository } from '../repos/types.js';
import { realtimeFromEnv } from './config.js';
import type { Realtime } from './realtime.js';
import { relayEvent, type RelayResult } from './relay.js';

let deps: RelayDeps | null = null;

export interface RelayDeps {
  realtime: Realtime;
  log: Logger;
  /** Reads each team's current seat tenure for its channel. */
  teams: Pick<TeamRepository, 'get'>;
}

export function createRelayDeps(env: Record<string, string | undefined>): RelayDeps {
  const log = createLogger({ level: parseLogLevel(env.LOG_LEVEL), bindings: { component: 'realtime' } });
  const tableName = env.TABLE_NAME;
  // Without a table (realtime off, nothing deployed) there are no team channels to look up.
  const teams: Pick<TeamRepository, 'get'> =
    tableName === undefined || tableName.length === 0
      ? { get: async () => null }
      : new DynamoTeamRepository({ doc: createDocumentClient(), tableName });
  return { realtime: realtimeFromEnv(env), log, teams };
}

export async function handler(event: BusEvent): Promise<RelayResult> {
  deps ??= createRelayDeps(process.env);
  return relayEvent(deps.realtime, deps.log, event, deps.teams);
}
