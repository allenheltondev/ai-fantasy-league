import { FixedClock } from '@fantasy/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, league, type Harness } from '../../test/support/harness.js';
import { testRegistry } from '../../test/support/test-ops.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { silentLogger } from '../log.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createServices } from '../services.js';
import { authenticate, createApp } from './app.js';
import { originSecretsFromEnv, requireOriginSecret } from './origin.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.repos.leagues.create(league());
});
afterEach(() => h.close());

describe('REST adapter', () => {
  it('serves the OpenAPI document', async () => {
    const res = await h.request('/api/v1/openapi.json', { token: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ openapi: '3.1.0' });
  });

  it('merges path, query, and body into the input', async () => {
    const res = await h.request('/api/v1/leagues/lg-1/picks/2?player=cmc&tags=a&tags=b', {
      method: 'PUT',
      idempotencyKey: 'key-00000001',
      body: {}
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: { round: 2, tags: ['a', 'b'], player: { id: 'fx-cmc' } } });
    expect(res.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/);
  });

  it('accepts a body field that matches the path, and rejects one that conflicts', async () => {
    const ok = await h.request('/api/v1/leagues/lg-1/picks/1', {
      method: 'PUT',
      idempotencyKey: 'key-00000002',
      body: { leagueId: 'lg-1', playerId: 'fx-lamb' }
    });
    expect(ok.status).toBe(200);
    const conflict = await h.request('/api/v1/leagues/lg-1/picks/1', {
      method: 'PUT',
      idempotencyKey: 'key-00000003',
      body: { leagueId: 'lg-2', playerId: 'fx-lamb' }
    });
    expect(conflict.status).toBe(400);
    expect(conflict.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('marks idempotent replays', async () => {
    const init = { method: 'POST', idempotencyKey: 'key-00000004', body: { name: 'Renamed' } };
    const first = await h.request('/api/v1/leagues/lg-1/name', init);
    const second = await h.request('/api/v1/leagues/lg-1/name', init);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.body).toEqual(first.body);
  });

  it('rejects bad bodies', async () => {
    const invalid = await h.request('/api/v1/leagues/lg-1/name', {
      method: 'POST',
      idempotencyKey: 'key-00000005',
      rawBody: '{nope'
    });
    expect(invalid.body).toMatchObject({ error: { code: 'INVALID_JSON' } });
    const array = await h.request('/api/v1/leagues/lg-1/name', {
      method: 'POST',
      idempotencyKey: 'key-00000005',
      body: [1]
    });
    expect(array.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    const empty = await h.request('/api/v1/leagues/lg-1/name', {
      method: 'POST',
      idempotencyKey: 'key-00000005',
      rawBody: ' '
    });
    expect(empty.body).toMatchObject({
      error: { code: 'INVALID_INPUT', details: { issues: [{ path: 'name' }] } }
    });
  });

  it('returns ROUTE_NOT_FOUND with a fix for unknown routes', async () => {
    const res = await h.request('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: { code: 'ROUTE_NOT_FOUND', fix: expect.stringContaining('openapi') }
    });
  });

  it('rejects malformed and invalid tokens even on public operations', async () => {
    const malformed = await h.request('/api/v1/health', {
      headers: { authorization: 'Basic abc' },
      token: null
    });
    expect(malformed.status).toBe(401);
    const invalid = await h.request('/api/v1/health', { token: 'not-a-jwt' });
    expect(invalid.status).toBe(401);
    expect(invalid.body).toMatchObject({ error: { code: 'UNAUTHENTICATED', fix: expect.any(String) } });
  });

  it('converts unexpected errors into INTERNAL', async () => {
    const services = createServices({
      clock: new FixedClock('2026-09-10T12:00:00Z'),
      repos: createInMemoryRepos(),
      events: new InMemoryEventPublisher(),
      log: silentLogger
    });
    const app = createApp({
      registry: testRegistry,
      services,
      verifier: {
        verify: () => {
          throw new Error('verifier crashed');
        }
      }
    });
    const res = await app.request('/api/v1/me', { headers: { authorization: 'Bearer x' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL' } });
    const onError = createApp({
      registry: testRegistry,
      services,
      verifier: { verify: () => Promise.reject(new Error('async crash')) }
    });
    expect((await onError.request('/api/v1/me', { headers: { authorization: 'Bearer x' } })).status).toBe(
      500
    );
  });
});

describe('origin verification', () => {
  function appWith(originSecrets?: readonly string[]) {
    const services = createServices({
      clock: new FixedClock('2026-09-10T12:00:00Z'),
      repos: createInMemoryRepos(),
      events: new InMemoryEventPublisher(),
      log: silentLogger
    });
    return createApp({ registry: testRegistry, services, verifier: null, originSecrets });
  }

  it('refuses a direct call without the header, before auth runs, on every route', async () => {
    const app = appWith(['s3cret-current']);
    for (const path of ['/api/v1/health', '/api/v1/openapi.json', '/api/v1/nope']) {
      const res = await app.request(path, { headers: { authorization: 'Bearer anything' } });
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'FORBIDDEN', fix: expect.any(String) } });
    }
    const wrong = await app.request('/api/v1/health', { headers: { 'x-origin-verify': 's3cret-currenX' } });
    expect(wrong.status).toBe(403);
    const short = await app.request('/api/v1/health', { headers: { 'x-origin-verify': 's3cret' } });
    expect(short.status).toBe(403);
  });

  it('accepts the current and the previous secret, so a rotation has no downtime', async () => {
    const app = appWith(['new-secret', 'old-secret']);
    for (const secret of ['new-secret', 'old-secret']) {
      const res = await app.request('/api/v1/health', { headers: { 'x-origin-verify': secret } });
      expect(res.status, secret).toBe(200);
    }
  });

  it('is off when no secrets are configured (the local dev server)', async () => {
    expect((await appWith().request('/api/v1/health')).status).toBe(200);
    expect(() => requireOriginSecret([])).toThrow(/at least one/);
  });

  it('reads the current and previous secret from the environment', () => {
    expect(originSecretsFromEnv({})).toEqual([]);
    expect(originSecretsFromEnv({ ORIGIN_VERIFY_SECRET: ' a ', ORIGIN_VERIFY_SECRET_PREVIOUS: 'b' })).toEqual(
      ['a', 'b']
    );
    expect(originSecretsFromEnv({ ORIGIN_VERIFY_SECRET: 'a', ORIGIN_VERIFY_SECRET_PREVIOUS: 'a' })).toEqual([
      'a'
    ]);
    expect(originSecretsFromEnv({ ORIGIN_VERIFY_SECRET_PREVIOUS: '  ' })).toEqual([]);
  });
});

describe('authenticate', () => {
  it('is anonymous without a header and refuses tokens when sign-in is not configured', async () => {
    expect(await authenticate(null, undefined)).toEqual({ type: 'anonymous' });
    expect(await authenticate(null, '  ')).toEqual({ type: 'anonymous' });
    await expect(authenticate(null, 'Bearer abc')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
