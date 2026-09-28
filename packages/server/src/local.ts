/**
 * Local API server for `npm run dev`: the Hono node adapter, dynalite (in-process
 * DynamoDB) seeded with the fixture draft pool, in-memory events, and optional dev sign-in.
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
import { seedDemoSeason } from './dev/season-demo.js';
import { EventLoop, type EventSubscriber } from './events/loop.js';
import { InMemoryEventPublisher } from './events/publisher.js';
import { serverSubscribers } from './events/subscribers.js';
import { createApp } from './http/app.js';
import { createLogger, parseLogLevel, type Logger } from './log.js';
import { registry } from './operations/index.js';
import { fixtureDraftPool } from './players/fixtures.js';
import { createDynamoRepos } from './repos/dynamo/index.js';
import { limitsFromEnv } from './context.js';
import { createDynamoReferenceStore } from './repos/dynamo/reference.js';
import { createServices } from './services.js';

export interface LocalServerOptions {
  port?: number;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  log?: Logger;
  /**
   * Deliver events in process (`EventLoop`): the draft pick clock, system chat messages, the season
   * jobs on their cadences, and whatever `subscribers` adds (the agents package adds the agent
   * router and task runner; see `packages/agents/src/dev.ts`). Off by default, so events are only
   * recorded.
   */
  eventLoop?: {
    subscribers?: (services: Services) => EventSubscriber[];
    /** How often the loop checks for deferred events and job runs (default 1000 ms). */
    pollMs?: number;
  };
}

export interface LocalServer {
  url: string;
  services: Services;
  events: InMemoryEventPublisher;
  /** The running event loop, when `eventLoop` was given. */
  loop: EventLoop | null;
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
  await repos.players.putMany(fixtureDraftPool);
  const events = new InMemoryEventPublisher();
  const services = createServices({
    clock: options.clock ?? localClock(env),
    repos,
    events,
    log,
    limits: limitsFromEnv(env),
    reference: createDynamoReferenceStore(table)
  });
  // FANTASY_LOCAL_SEASON_DEMO=<handle>: an in-season league (`demo-season`) for dev user local-<handle>.
  const demo = env.FANTASY_LOCAL_SEASON_DEMO;
  if (demo !== undefined && demo !== '') {
    await seedDemoSeason(
      { repos, reference: services.data.reference },
      { leagueId: 'demo-season', owner: { sub: `local-${demo}`, name: demo }, now: services.clock.now() }
    );
  }
  const loop =
    options.eventLoop === undefined ? null : await startEventLoop(services, events, options.eventLoop);
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
    loop,
    close: async () => {
      await loop?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await table.close();
    }
  };
}

async function startEventLoop(
  services: Services,
  events: InMemoryEventPublisher,
  options: NonNullable<LocalServerOptions['eventLoop']>
): Promise<EventLoop> {
  // Loaded only here: the season jobs import @fantasy/data, which the plain dev server (and e2e) skip.
  const { seasonJobs } = await import('./jobs/schedules.js');
  const loop = new EventLoop({
    publisher: events,
    clock: services.clock,
    subscribers: [...serverSubscribers(services), ...(options.subscribers?.(services) ?? [])],
    jobs: seasonJobs(
      { repos: services.repos, reference: services.data.reference, events, log: services.log },
      services.clock
    ),
    log: services.log
  });
  loop.start(options.pollMs ?? 1000);
  return loop;
}

/* v8 ignore start -- process entrypoint */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3001);
  const local = await startLocalServer({ port });
  const auth = isLocalAuthEnabled(process.env) ? 'dev sign-in on (Bearer dev)' : 'dev sign-in off';
  process.stdout.write(`Fantasy API listening on ${local.url}/api/v1 (${auth})\n`);
}
/* v8 ignore stop */
