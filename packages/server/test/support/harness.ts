import { FixedClock, yahooDefaultSettings } from '@fantasy/core';
import type { Hono } from 'hono';
import { createCognitoVerifier } from '../../src/auth/verifier.js';
import type { Services } from '../../src/context.js';
import { startLocalTable, type LocalTable } from '../../src/dev/dynalite.js';
import { InMemoryEventPublisher } from '../../src/events/publisher.js';
import { createApp } from '../../src/http/app.js';
import { silentLogger } from '../../src/log.js';
import { fixturePlayers } from '../../src/players/fixtures.js';
import type { Registry } from '../../src/registry/registry.js';
import { createDynamoRepos } from '../../src/repos/dynamo/index.js';
import { createDynamoReferenceStore } from '../../src/repos/dynamo/reference.js';
import { createInMemoryRepos } from '../../src/repos/memory.js';
import type { League, Repos } from '../../src/repos/types.js';
import { createServices } from '../../src/services.js';
import { testRegistry } from './test-ops.js';
import { CLIENT_ID, jwks, signIdToken, USER_POOL_ID } from './tokens.js';

export const START = '2026-09-10T12:00:00.000Z';

export interface Harness {
  app: Hono;
  services: Services;
  repos: Repos;
  clock: FixedClock;
  events: InMemoryEventPublisher;
  registry: Registry;
  request(path: string, init?: RequestOptions): Promise<{ status: number; body: unknown; headers: Headers }>;
  close(): Promise<void>;
}

export interface RequestOptions {
  method?: string;
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export function league(overrides: Partial<League> = {}): League {
  return {
    id: 'lg-1',
    name: 'Test League',
    season: 2026,
    phase: 'setup',
    week: null,
    settings: yahooDefaultSettings(8),
    commissionerId: 'user-123',
    commissionerName: 'Allen',
    createdBy: 'user-123',
    scheduleSeed: 'seed-1',
    deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
    createdAt: START,
    updatedAt: START,
    version: 1,
    ...overrides
  };
}

/** The real REST app with a real Cognito verifier (local JWKS) and either repo backend. */
export async function createHarness(
  options: { backend?: 'memory' | 'dynamo'; registry?: Registry } = {}
): Promise<Harness> {
  let table: LocalTable | null = null;
  let repos: Repos;
  if (options.backend === 'dynamo') {
    table = await startLocalTable();
    repos = createDynamoRepos(table);
    await repos.players.putMany(fixturePlayers);
  } else {
    repos = createInMemoryRepos({ players: fixturePlayers });
  }
  const clock = new FixedClock(START);
  const events = new InMemoryEventPublisher();
  const services = createServices({
    clock,
    repos,
    events,
    log: silentLogger,
    ...(table === null ? {} : { reference: createDynamoReferenceStore(table) })
  });
  const registry = options.registry ?? testRegistry;
  const verifier = createCognitoVerifier({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, jwks });
  const app = createApp({ registry, services, verifier });
  const defaultToken = signIdToken();

  return {
    app,
    services,
    repos,
    clock,
    events,
    registry,
    async request(path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      const token = init.token === undefined ? defaultToken : init.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (init.idempotencyKey !== undefined) headers['idempotency-key'] = init.idempotencyKey;
      let body: string | undefined = init.rawBody;
      if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        headers['content-type'] = 'application/json';
      }
      const response = await app.request(path, { method: init.method ?? 'GET', headers, body });
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
    async close() {
      await table?.close();
    }
  };
}
