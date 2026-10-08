/**
 * Lambda entrypoint for the realtime subscribe check: the `fantasy` channel namespace's OnSubscribe
 * handler (a direct Lambda integration, see RealtimeSubscribeFunction in infra/template.yaml).
 * Bundled by scripts/package-server.sh as `realtime-authorizer.mjs`, export `handler`.
 */
import { createLogger, parseLogLevel } from '../log.js';
import { DynamoLeagueRepository } from '../repos/dynamo/leagues.js';
import { createDocumentClient } from '../repos/dynamo/table.js';
import { DynamoTeamRepository } from '../repos/dynamo/teams.js';
import { createSubscribeHandler, type SubscribeRequest, type SubscribeResponse } from './authorizer.js';

export function createAuthorizer(env: Record<string, string | undefined>) {
  const tableName = env.TABLE_NAME;
  if (tableName === undefined || tableName.length === 0) {
    throw new Error('Missing realtime authorizer environment: TABLE_NAME');
  }
  const table = { doc: createDocumentClient(), tableName };
  const log = createLogger({
    level: parseLogLevel(env.LOG_LEVEL),
    bindings: { component: 'realtime-authorizer' }
  });
  return createSubscribeHandler(
    { leagues: new DynamoLeagueRepository(table), teams: new DynamoTeamRepository(table) },
    log
  );
}

let authorize: ReturnType<typeof createAuthorizer> | null = null;

export async function handler(request: SubscribeRequest): Promise<SubscribeResponse> {
  authorize ??= createAuthorizer(process.env);
  return authorize(request);
}
