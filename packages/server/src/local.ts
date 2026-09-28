/**
 * Local API server for `npm run dev`: the Hono node adapter, dynalite (in-process
 * DynamoDB) seeded with fixture players, in-memory events, and optional dev sign-in.
 *
 * Dev sign-in (`Authorization: Bearer dev` or `Bearer dev:<handle>`) is only on when
 * FANTASY_LOCAL_AUTH=1, and never inside Lambda (see auth/dev.ts).
 */
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { FixedClock, systemClock, type Clock } from '@fantasy/core';
import { serve } from '@hono/node-server';
import { createDevVerifier, isLocalAuthEnabled } from './auth/dev.js';
import { createCognitoVerifier, type TokenVerifier } from './auth/verifier.js';
import type { Services } from './context.js';
import { startLocalTable } from './dev/dynalite.js';
import { InMemoryEventPublisher } from './events/publisher.js';
import { createApp } from './http/app.js';
import { createLogger, parseLogLevel, type Logger } from './log.js';
import { registry } from './operations/index.js';
import { fixturePlayers } from './players/fixtures.js';
import { createDynamoRepos } from './repos/dynamo/index.js';
import { limitsFromEnv } from './context.js';
import { createDynamoReferenceStore } from './repos/dynamo/reference.js';
import { createServices } from './services.js';

export interface LocalServerOptions {
  port?: number;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  log?: Logger;
}

export interface LocalServer {
  url: string;
  services: Services;
  events: InMemoryEventPublisher;
  close(): Promise<void>;
}

export function localVerifier(env: Record<string, string | undefined>): TokenVerifier | null {
  if (isLocalAuthEnabled(env)) return createDevVerifier(env);
  if (env.USER_POOL_ID && env.USER_POOL_CLIENT_ID) {
    return createCognitoVerifier({ userPoolId: env.USER_POOL_ID, clientId: env.USER_POOL_CLIENT_ID });
  }
  return null;
}

/**
 * `FANTASY_LOCAL_NOW` pins the local clock to a moment (e2e runs create leagues at a fixed point in
 * a season, whatever today's date is); otherwise the system clock.
 */
export function localClock(env: Record<string, string | undefined>): Clock {
  const at = env.FANTASY_LOCAL_NOW;
  if (at === undefined || at === '') return systemClock;
  const start = new Date(at);
  if (Number.isNaN(start.getTime())) throw new Error(`FANTASY_LOCAL_NOW is not a date: "${at}".`);
  return new FixedClock(start);
}

export async function startLocalServer(options: LocalServerOptions = {}): Promise<LocalServer> {
  const env = options.env ?? process.env;
  if (env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('The local server must not run inside Lambda.');
  const log = options.log ?? createLogger({ level: parseLogLevel(env.LOG_LEVEL) });
  const table = await startLocalTable();
  const repos = createDynamoRepos(table);
  await repos.players.putMany(fixturePlayers);
  const events = new InMemoryEventPublisher();
  const services = createServices({
    clock: options.clock ?? localClock(env),
    repos,
    events,
    log,
    limits: limitsFromEnv(env),
    reference: createDynamoReferenceStore(table)
  });
  const app = createApp({ registry, services, verifier: localVerifier(env) });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, port: options.port ?? 3001, hostname: '127.0.0.1' }, () =>
      resolve(started)
    );
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    services,
    events,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await table.close();
    }
  };
}

/* v8 ignore start -- process entrypoint */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3001);
  const local = await startLocalServer({ port });
  const auth = isLocalAuthEnabled(process.env) ? 'dev sign-in on (Bearer dev)' : 'dev sign-in off';
  process.stdout.write(`Fantasy API listening on ${local.url}/api/v1 (${auth})\n`);
}
/* v8 ignore stop */
